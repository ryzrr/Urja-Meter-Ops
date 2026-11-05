import type { z } from "zod";
import { PortalError } from "./errors.js";
import { RateLimiter, realSleep, type Sleep } from "./rate-limiter.js";
import {
  ExportResponseSchema,
  KeysResponseSchema,
  ReadingsResponseSchema,
  TransformerPageSchema,
  type RawMeter,
  type RawReading,
  type RawTransformer,
} from "./schemas.js";
import { signRequest } from "./signing.js";

const SESSION_COOKIE = "__Secure-better-auth.session_token";

export interface PortalClientOptions {
  baseUrl: string;
  email: string;
  password: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Shared throttle. Created in server.ts from config so its limits live in one place. */
  limiter: RateLimiter;
  fetch?: typeof fetch;
  sleep?: Sleep;
  now?: () => number;
}

/** What the rest of the service needs from the portal. Lets tests swap in a fake. */
export interface PortalSource {
  exportMeters(): Promise<RawMeter[]>;
  listTransformers(): Promise<RawTransformer[]>;
  getReadings(meterId: string, range?: { from: string; to: string }): Promise<RawReading[]>;
}

interface GetOptions {
  query?: string;
  signed?: boolean;
}

/**
 * HTTP client for the Urja Meter Ops portal. Handles:
 *  - login through the SvelteKit form action and session cookie reuse
 *  - transparent re-login when the 1 hour session expires (401)
 *  - HMAC signing for the bulk export, refreshing the secret if it is rejected
 *  - client-side throttling and backoff on 429, 5xx, timeouts and network errors
 */
export class PortalClient implements PortalSource {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep;
  private readonly now: () => number;

  private cookie: string | null = null;
  private pendingLogin: Promise<string> | null = null;
  private signingSecret: string | null = null;

  constructor(private readonly options: PortalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.limiter = options.limiter;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? Date.now;
  }

  /** Every meter with hierarchy and coordinates in one call. The `page` param is ignored by the portal. */
  async exportMeters(): Promise<RawMeter[]> {
    const body = await this.getJson("/portal/export", { query: "page=1", signed: true });
    return parse(ExportResponseSchema, body, "/portal/export").data;
  }

  /** Transformer master list. Fixed page size of 20; out-of-range pages silently return page 1. */
  async listTransformers(): Promise<RawTransformer[]> {
    const byCode = new Map<string, RawTransformer>();
    for (let page = 1; page <= 100; page++) {
      const body = await this.getJson("/portal/dts", { query: `page=${page}` });
      const result = parse(TransformerPageSchema, body, "/portal/dts");
      for (const dt of result.data) byCode.set(dt.code, dt);
      const pageCount = Math.ceil(result.total / Math.max(result.pageSize, 1));
      if (result.page !== page || page >= pageCount || result.data.length === 0) break;
    }
    return [...byCode.values()];
  }

  /**
   * Readings for one meter. `from`/`to` are inclusive calendar dates (YYYY-MM-DD).
   * Without a range the portal returns the last 7 days of data it holds.
   */
  async getReadings(meterId: string, range?: { from: string; to: string }): Promise<RawReading[]> {
    const query = range ? new URLSearchParams(range).toString() : "";
    const path = `/portal/meters/${encodeURIComponent(meterId)}/energy`;
    const body = await this.getJson(path, { query });
    return parse(ReadingsResponseSchema, body, path).data;
  }

  private async getJson(path: string, opts: GetOptions = {}): Promise<unknown> {
    const query = opts.query ?? "";
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
    let reauthenticated = false;
    let resigned = false;

    for (let attempt = 0; ; attempt++) {
      const cookie = await this.session();
      const headers: Record<string, string> = { cookie, accept: "application/json" };
      if (opts.signed) {
        const secret = await this.secret();
        Object.assign(headers, signRequest(secret, "GET", path, query, this.now() / 1000));
      }

      await this.limiter.acquire();
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw new PortalError(`Portal request to ${path} failed: ${describe(err)}`, "unavailable");
      }

      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw new PortalError(`Portal returned non-JSON from ${path}`, "contract", res.status);
        }
      }

      const errorCode = await readErrorCode(res);

      if (res.status === 401 && errorCode === "signature_invalid" && !resigned) {
        resigned = true;
        this.signingSecret = null;
        continue;
      }
      if (res.status === 401 && !reauthenticated) {
        reauthenticated = true;
        if (this.cookie === cookie) this.cookie = null;
        continue;
      }
      if (res.status === 404) {
        throw new PortalError(`Portal says ${path} does not exist`, "not_found", 404);
      }
      if (res.status === 429 && attempt < this.maxRetries) {
        // Pause the shared limiter so every pending request backs off, not just this one.
        this.limiter.pauseFor(this.backoffMs(attempt));
        continue;
      }
      if (res.status >= 500 && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs(attempt));
        continue;
      }
      if (res.status === 429) {
        throw new PortalError("Portal rate limit still exceeded after retries", "rate_limited", 429);
      }
      if (res.status === 401) {
        throw new PortalError("Portal rejected the session after re-login", "auth", 401);
      }
      throw new PortalError(`Portal responded ${res.status} for ${path}`, "unavailable", res.status);
    }
  }

  /** Returns the session cookie, logging in first if needed. Concurrent callers share one login. */
  private session(): Promise<string> {
    if (this.cookie) return Promise.resolve(this.cookie);
    this.pendingLogin ??= this.login().finally(() => {
      this.pendingLogin = null;
    });
    return this.pendingLogin;
  }

  private async login(): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/login`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          // Ask SvelteKit for the JSON action result instead of an HTML page.
          "x-sveltekit-action": "true",
          // SvelteKit's CSRF check rejects form posts without a matching Origin (403).
          origin: this.baseUrl,
        },
        body: new URLSearchParams({ email: this.options.email, password: this.options.password }),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new PortalError(`Portal login request failed: ${describe(err)}`, "unavailable");
    }

    // Form actions answer HTTP 200 even for a wrong password; the outcome is in the body.
    const body = (await res.json().catch(() => null)) as { type?: string } | null;
    if (body?.type === "failure") {
      throw new PortalError("Portal rejected the configured credentials", "auth", 401);
    }
    const cookie = findCookie(res.headers.getSetCookie(), SESSION_COOKIE);
    if (!cookie) {
      throw new PortalError(`Portal login did not return a session (HTTP ${res.status})`, "auth", res.status);
    }
    this.cookie = cookie;
    return cookie;
  }

  private async secret(): Promise<string> {
    if (!this.signingSecret) {
      const body = await this.getJson("/portal/keys");
      this.signingSecret = parse(KeysResponseSchema, body, "/portal/keys").data.signingSecret;
    }
    return this.signingSecret;
  }

  /** 2s, 4s, 8s, 16s (capped at 30s) plus jitter. Covers the portal's ~30s rate window. */
  private backoffMs(attempt: number): number {
    return Math.min(30_000, 2_000 * 2 ** attempt) + Math.floor(Math.random() * 250);
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown, endpoint: string): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first ? `${first.path.join(".")}: ${first.message}` : "unknown";
    throw new PortalError(`Unexpected response shape from ${endpoint} (${where})`, "contract");
  }
  return result.data;
}

function findCookie(setCookies: string[], name: string): string | null {
  for (const header of setCookies) {
    const pair = header.split(";", 1)[0]?.trim();
    if (pair?.startsWith(`${name}=`)) return pair;
  }
  return null;
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "timed out" : err.message;
  return String(err);
}
