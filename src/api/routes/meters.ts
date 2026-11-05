import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { Router } from "express";
import { filterMeters, splitList } from "../../domain/search.js";
import type { AppDeps } from "../app.js";
import { ApiError, errorResponses, parseOr400 } from "../errors.js";
import {
  ConsumptionQuery,
  ConsumptionResponse,
  MeterIdParams,
  MeterListQuery,
  MeterListResponse,
  MeterResponse,
  RangeQuery,
  ReadingsResponse,
} from "../schemas.js";

const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });

export function meterRoutes(deps: AppDeps, registry: OpenAPIRegistry): Router {
  const router = Router();

  registry.registerPath({
    method: "get",
    path: "/v1/meters",
    tags: ["Meters"],
    summary: "Search and filter meters",
    description:
      "Served from the in-memory catalog, so it does not touch the portal per request. " +
      "Filters combine with AND; comma-separated values within one filter combine with OR.",
    request: { query: MeterListQuery },
    responses: { 200: { description: "Matching meters", ...json(MeterListResponse) }, ...errorResponses(400, 502, 503) },
  });
  router.get("/v1/meters", async (req, res) => {
    const query = parseOr400(MeterListQuery, req.query);
    const snapshot = await deps.catalog.get();

    const [lat, lng] = query.near?.split(",").map(Number) ?? [];
    const matches = filterMeters(snapshot.meters, {
      q: query.q,
      status: splitList(query.status),
      make: splitList(query.make),
      phase: splitList(query.phase),
      installationType: splitList(query.installationType),
      build: splitList(query.build),
      network: {
        zone: query.zone,
        circle: query.circle,
        division: query.division,
        subdivision: query.subdivision,
        substation: query.substation,
        feeder: query.feeder,
        transformer: query.transformer,
      },
      nodeId: query.nodeId,
      near: lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng, radiusKm: query.radiusKm } : undefined,
    });

    const start = (query.page - 1) * query.pageSize;
    res.json({
      data: matches.slice(start, start + query.pageSize),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: matches.length,
        dataAsOf: snapshot.loadedAt.toISOString(),
      },
    });
  });

  registry.registerPath({
    method: "get",
    path: "/v1/meters/{meterId}",
    tags: ["Meters"],
    summary: "Get one meter with its network position and location",
    request: { params: MeterIdParams },
    responses: { 200: { description: "The meter", ...json(MeterResponse) }, ...errorResponses(400, 404, 502, 503) },
  });
  router.get("/v1/meters/:meterId", async (req, res) => {
    const { meterId } = parseOr400(MeterIdParams, req.params);
    const snapshot = await deps.catalog.get();
    const meter = snapshot.meterById.get(meterId.toUpperCase());
    if (!meter) throw new ApiError(404, "meter_not_found", `Meter ${meterId} not found`);
    res.json({ data: meter, meta: { dataAsOf: snapshot.loadedAt.toISOString() } });
  });

  registry.registerPath({
    method: "get",
    path: "/v1/meters/{meterId}/readings",
    tags: ["Readings"],
    summary: "Cleaned register readings for a meter",
    description:
      "Cumulative kWh/kVAh registers and R phase voltage, as reported by the meter. Timestamps are " +
      "converted to ISO 8601 with the portal's UTC offset. Duplicate rows are dropped and reported in " +
      "`dataIssues`. Without from/to the portal's default applies: the last 7 days of data it holds.",
    request: { params: MeterIdParams, query: RangeQuery },
    responses: { 200: { description: "Readings", ...json(ReadingsResponse) }, ...errorResponses(400, 404, 502, 503) },
  });
  router.get("/v1/meters/:meterId/readings", async (req, res) => {
    const meterId = await knownMeterId(deps, req.params);
    const range = parseOr400(RangeQuery, req.query);
    const result = await deps.readings.readings(meterId, toRange(range));
    res.json({
      data: { meterId, from: result.from, to: result.to, interval: result.interval, readings: result.readings },
      dataIssues: result.issues,
    });
  });

  registry.registerPath({
    method: "get",
    path: "/v1/meters/{meterId}/consumption",
    tags: ["Readings"],
    summary: "Energy used per interval or per day",
    description:
      "Derived from consecutive register readings (usage = difference between readings). Intervals " +
      "where the register goes down are returned as null and reported in `dataIssues`.",
    request: { params: MeterIdParams, query: ConsumptionQuery },
    responses: { 200: { description: "Consumption", ...json(ConsumptionResponse) }, ...errorResponses(400, 404, 502, 503) },
  });
  router.get("/v1/meters/:meterId/consumption", async (req, res) => {
    const meterId = await knownMeterId(deps, req.params);
    const query = parseOr400(ConsumptionQuery, req.query);
    const result = await deps.readings.consumption(meterId, query.granularity, toRange(query));
    res.json({
      data: {
        meterId,
        from: result.from,
        to: result.to,
        interval: result.interval,
        granularity: query.granularity,
        totalKwh: result.totalKwh,
        totalKvah: result.totalKvah,
        points: result.points,
      },
      dataIssues: result.issues,
    });
  });

  return router;
}

/** Rejects unknown meters from the catalog so typos do not spend portal rate budget. */
async function knownMeterId(deps: AppDeps, params: unknown): Promise<string> {
  const { meterId } = parseOr400(MeterIdParams, params);
  const id = meterId.toUpperCase();
  const snapshot = await deps.catalog.get();
  if (!snapshot.meterById.has(id)) throw new ApiError(404, "meter_not_found", `Meter ${meterId} not found`);
  return id;
}

function toRange(q: { from?: string | undefined; to?: string | undefined }) {
  return q.from && q.to ? { from: q.from, to: q.to } : undefined;
}
