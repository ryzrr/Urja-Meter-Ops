import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { PortalError } from "../src/portal/errors.js";
import { CatalogService } from "../src/services/catalog-service.js";
import { ReadingsService } from "../src/services/readings-service.js";
import { fakePortal, rawReadings } from "./helpers.js";

function makeApp(portalOverride?: Partial<ReturnType<typeof fakePortal>["portal"]>) {
  const { portal, calls } = fakePortal({ J100000: rawReadings("energy-J100000-halfhourly.json") });
  Object.assign(portal, portalOverride);
  const { app } = createApp({
    catalog: new CatalogService(portal, 60_000),
    readings: new ReadingsService(portal, { utcOffset: "+05:30", ttlMs: 60_000 }),
  });
  return { app, calls };
}

describe("API", () => {
  it("lists and filters meters with paging metadata", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/v1/meters?status=faulty&pageSize=2").expect(200);
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 2, total: expect.any(Number) });
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((m: { status: string }) => m.status === "faulty")).toBe(true);
  });

  it("returns one meter, case-insensitive id", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/v1/meters/j100001").expect(200);
    expect(res.body.data.meterId).toBe("J100001");
  });

  it("returns 404 for unknown meters without calling the portal for readings", async () => {
    const { app, calls } = makeApp();
    await request(app).get("/v1/meters/J999999/readings").expect(404);
    expect(calls.getReadings).toEqual([]);
  });

  it("validates date ranges", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/v1/meters/J100000/readings?from=2026-06-05&to=2026-06-01").expect(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("serves daily consumption and fetches one extra day to close the last interval", async () => {
    const { app, calls } = makeApp();
    const res = await request(app).get("/v1/meters/J100000/consumption?from=2026-06-01&to=2026-06-01").expect(200);
    expect(res.body.data.points).toHaveLength(1);
    expect(res.body.data.totalKwh).toBeGreaterThan(0);
    expect(calls.getReadings).toEqual(["J100000|2026-06-01|2026-06-02"]);
  });

  it("caches readings per meter and window", async () => {
    const { app, calls } = makeApp();
    await request(app).get("/v1/meters/J100000/readings?from=2026-06-01&to=2026-06-02").expect(200);
    await request(app).get("/v1/meters/J100000/readings?from=2026-06-01&to=2026-06-02").expect(200);
    expect(calls.getReadings).toHaveLength(1);
  });

  it("maps portal rate limiting to 503 with Retry-After", async () => {
    const { app } = makeApp({
      getReadings: async () => {
        throw new PortalError("still 429", "rate_limited", 429);
      },
    });
    const res = await request(app).get("/v1/meters/J100000/readings").expect(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body.error.code).toBe("upstream_rate_limited");
  });

  it("exposes network nodes, data quality and the OpenAPI document", async () => {
    const { app } = makeApp();
    const zones = await request(app).get("/v1/network?level=zone").expect(200);
    expect(zones.body.data.every((n: { parentId: string | null }) => n.parentId === null)).toBe(true);

    const quality = await request(app).get("/v1/data-quality").expect(200);
    expect(quality.body.data.summary.missing_code_filled).toBeGreaterThan(0);

    const spec = await request(app).get("/openapi.json").expect(200);
    expect(spec.body.openapi).toBe("3.0.3");
  });
});
