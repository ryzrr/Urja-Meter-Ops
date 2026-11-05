import { describe, expect, it } from "vitest";
import { PortalClient } from "../src/portal/client.js";
import { PortalError } from "../src/portal/errors.js";
import { RateLimiter } from "../src/portal/rate-limiter.js";

const BASE = "https://portal.test";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const loginOk = (token: string) =>
  json({ type: "redirect", status: 303, location: "/meters" }, 200, {
    "set-cookie": `__Secure-better-auth.session_token=${token}; Max-Age=3600; Path=/; HttpOnly`,
  });

/** Fake portal: each route handler decides the response; every call is recorded. */
function setup(routes: Record<string, (req: { headers: Headers; n: number }) => Response>) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    calls.push(key);
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected request ${key}`);
    return handler({ headers: new Headers(init?.headers), n });
  }) as typeof fetch;

  // Fake clock shared by the client and its limiter; sleeping just advances it.
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
  };
  const client = new PortalClient({
    baseUrl: BASE,
    email: "ops@example.test",
    password: "secret",
    fetch: fetchImpl,
    sleep,
    limiter: new RateLimiter(1000, 30_000, now, sleep),
    now,
  });
  return { client, calls, sleeps };
}

const readings = { data: [{ timestamp: "01/06/2026 00:00", kwh: "1", kvah: "1", voltR: "230" }] };

describe("PortalClient", () => {
  it("logs in once and reuses the session cookie", async () => {
    const { client, calls } = setup({
      "POST /login": () => loginOk("t1"),
      "GET /portal/meters/J1/energy": ({ headers }) => {
        expect(headers.get("cookie")).toBe("__Secure-better-auth.session_token=t1");
        return json(readings);
      },
    });
    await Promise.all([client.getReadings("J1"), client.getReadings("J1")]);
    expect(calls.filter((c) => c === "POST /login")).toHaveLength(1);
  });

  it("logs in again when the session expires", async () => {
    const { client, calls } = setup({
      "POST /login": ({ n }) => loginOk(`t${n}`),
      "GET /portal/meters/J1/energy": ({ headers }) =>
        headers.get("cookie")?.endsWith("t1") ? json({ error: "unauthorized" }, 401) : json(readings),
    });
    await expect(client.getReadings("J1")).resolves.toHaveLength(1);
    expect(calls).toEqual(["POST /login", "GET /portal/meters/J1/energy", "POST /login", "GET /portal/meters/J1/energy"]);
  });

  it("treats an HTTP 200 'failure' login response as bad credentials", async () => {
    const { client } = setup({
      "POST /login": () => json({ type: "failure", status: 401, data: "[]" }),
    });
    await expect(client.getReadings("J1")).rejects.toMatchObject({ kind: "auth" });
  });

  it("backs off and retries on 429, then gives up with rate_limited", async () => {
    const { client, sleeps } = setup({
      "POST /login": () => loginOk("t1"),
      "GET /portal/meters/J1/energy": ({ n }) => (n <= 2 ? json({ error: "rate_limited" }, 429) : json(readings)),
      "GET /portal/meters/J2/energy": () => json({ error: "rate_limited" }, 429),
    });
    await expect(client.getReadings("J1")).resolves.toHaveLength(1);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);

    const err = await client.getReadings("J2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalError);
    expect(err).toMatchObject({ kind: "rate_limited" });
  });

  it("signs the export and refetches the secret once if the signature is rejected", async () => {
    const { client, calls } = setup({
      "POST /login": () => loginOk("t1"),
      "GET /portal/keys": ({ n }) => json({ data: { signingSecret: n === 1 ? "old" : "new" } }),
      "GET /portal/export": ({ headers, n }) => {
        expect(headers.get("x-timestamp")).toBe("1700000000");
        expect(headers.get("x-signature")).toMatch(/^[0-9a-f]{64}$/);
        return n === 1 ? json({ error: "signature_invalid" }, 401) : json({ data: [], total: 0 });
      },
    });
    await expect(client.exportMeters()).resolves.toEqual([]);
    expect(calls.filter((c) => c === "GET /portal/keys")).toHaveLength(2);
  });

  it("fails with a contract error when the response shape changes", async () => {
    const { client } = setup({
      "POST /login": () => loginOk("t1"),
      "GET /portal/meters/J1/energy": () => json({ rows: [] }),
    });
    await expect(client.getReadings("J1")).rejects.toMatchObject({ kind: "contract" });
  });
});
