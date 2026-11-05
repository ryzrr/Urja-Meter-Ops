import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { Router } from "express";
import type { AppDeps } from "../app.js";
import { HealthResponse } from "../schemas.js";

export function healthRoutes(deps: AppDeps, registry: OpenAPIRegistry): Router {
  const router = Router();

  registry.registerPath({
    method: "get",
    path: "/health",
    tags: ["Ops"],
    summary: "Service health and catalog freshness",
    description:
      "200 once the catalog has loaded. `degraded` means the last refresh failed or the snapshot is " +
      "past its TTL; data is still served from the previous snapshot. 503 while starting.",
    responses: {
      200: { description: "Ready", content: { "application/json": { schema: HealthResponse } } },
      503: { description: "Catalog not loaded yet", content: { "application/json": { schema: HealthResponse } } },
    },
  });
  router.get("/health", (_req, res) => {
    const catalog = deps.catalog.status();
    const status = !catalog.loaded ? "starting" : catalog.lastRefreshError || catalog.stale ? "degraded" : "ok";
    res.status(catalog.loaded ? 200 : 503).json({ status, catalog });
  });

  return router;
}
