import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { Router } from "express";
import type { DataIssue } from "../../domain/models.js";
import type { AppDeps } from "../app.js";
import { ApiError, errorResponses, parseOr400 } from "../errors.js";
import {
  DataQualityQuery,
  DataQualityResponse,
  NetworkQuery,
  NetworkResponse,
  TransformerCodeParams,
  TransformerListResponse,
  TransformerResponse,
} from "../schemas.js";

const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });

/** Transformers, the network hierarchy and the data quality report. All served from the catalog. */
export function networkRoutes(deps: AppDeps, registry: OpenAPIRegistry): Router {
  const router = Router();

  registry.registerPath({
    method: "get",
    path: "/v1/transformers",
    tags: ["Network"],
    summary: "List distribution transformers",
    description: "From the portal's transformer master list, with meter counts and any conflicting names seen on meter records.",
    responses: { 200: { description: "Transformers", ...json(TransformerListResponse) }, ...errorResponses(502, 503) },
  });
  router.get("/v1/transformers", async (_req, res) => {
    const snapshot = await deps.catalog.get();
    res.json({
      data: snapshot.transformers,
      meta: { total: snapshot.transformers.length, dataAsOf: snapshot.loadedAt.toISOString() },
    });
  });

  registry.registerPath({
    method: "get",
    path: "/v1/transformers/{code}",
    tags: ["Network"],
    summary: "Get one transformer. Use /v1/meters?transformer={code} for its meters.",
    request: { params: TransformerCodeParams },
    responses: { 200: { description: "Transformer", ...json(TransformerResponse) }, ...errorResponses(404, 502, 503) },
  });
  router.get("/v1/transformers/:code", async (req, res) => {
    const { code } = parseOr400(TransformerCodeParams, req.params);
    const snapshot = await deps.catalog.get();
    const transformer = snapshot.transformers.find((t) => t.code.toLowerCase() === code.toLowerCase());
    if (!transformer) throw new ApiError(404, "transformer_not_found", `Transformer ${code} not found`);
    res.json({ data: transformer, meta: { dataAsOf: snapshot.loadedAt.toISOString() } });
  });

  registry.registerPath({
    method: "get",
    path: "/v1/network",
    tags: ["Network"],
    summary: "Network hierarchy as a flat list of nodes",
    description:
      "Zone > circle > division > subdivision > substation > feeder > transformer. Each node has a " +
      "`parentId`, so the tree can be rebuilt client side. Node IDs are full code paths because codes " +
      "below zone level are reused under different parents in the portal data.",
    request: { query: NetworkQuery },
    responses: { 200: { description: "Nodes in depth-first order", ...json(NetworkResponse) }, ...errorResponses(400, 502, 503) },
  });
  router.get("/v1/network", async (req, res) => {
    const query = parseOr400(NetworkQuery, req.query);
    const snapshot = await deps.catalog.get();
    const nodes = snapshot.network.filter(
      (n) => (!query.level || n.level === query.level) && (!query.parentId || n.parentId === query.parentId),
    );
    res.json({ data: nodes, meta: { total: nodes.length, dataAsOf: snapshot.loadedAt.toISOString() } });
  });

  registry.registerPath({
    method: "get",
    path: "/v1/data-quality",
    tags: ["Network"],
    summary: "Problems found in the portal's meter data and how they were handled",
    request: { query: DataQualityQuery },
    responses: { 200: { description: "Issue summary and list", ...json(DataQualityResponse) }, ...errorResponses(400, 502, 503) },
  });
  router.get("/v1/data-quality", async (req, res) => {
    const query = parseOr400(DataQualityQuery, req.query);
    const snapshot = await deps.catalog.get();
    const summary: Partial<Record<DataIssue["type"], number>> = {};
    for (const i of snapshot.issues) summary[i.type] = (summary[i.type] ?? 0) + 1;
    const issues = query.type ? snapshot.issues.filter((i) => i.type === query.type) : snapshot.issues;
    res.json({ data: { summary, issues }, meta: { dataAsOf: snapshot.loadedAt.toISOString() } });
  });

  return router;
}
