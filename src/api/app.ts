import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { apiReference } from "@scalar/express-api-reference";
import express, { type Express, type RequestHandler } from "express";
import type { CatalogService } from "../services/catalog-service.js";
import type { ReadingsService } from "../services/readings-service.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { healthRoutes } from "./routes/health.js";
import { meterRoutes } from "./routes/meters.js";
import { networkRoutes } from "./routes/network.js";

export interface AppDeps {
  catalog: CatalogService;
  readings: ReadingsService;
}

export function createApp(deps: AppDeps, options: { logRequests?: boolean } = {}) {
  const app: Express = express();
  app.disable("x-powered-by");
  if (options.logRequests) app.use(requestLogger);

  const registry = new OpenAPIRegistry();
  app.use(healthRoutes(deps, registry));
  app.use(meterRoutes(deps, registry));
  app.use(networkRoutes(deps, registry));

  const openapi = buildOpenApiDocument(registry);
  // Point "Try it" in /docs at whatever host and port this server was reached on,
  // instead of the localhost:3000 written in the static openapi.json file.
  app.get("/openapi.json", (req, res) => {
    res.json({ ...openapi, servers: [{ url: `${req.protocol}://${req.get("host")}`, description: "This server" }] });
  });
  app.use("/docs", apiReference({ url: "/openapi.json" }));
  app.get("/", (_req, res) => {
    res.redirect("/docs");
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, openapi };
}

function buildOpenApiDocument(registry: OpenAPIRegistry) {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Urja Meter API",
      version: "1.0.0",
      description:
        "Read-only API over the Urja Meter Ops portal: meters, network hierarchy, transformers and " +
        "consumption. Meter and network data come from a cached snapshot of the portal's bulk export; " +
        "readings are fetched per request and cached. See README.md and PROTOCOL.md in the repository.",
    },
    servers: [{ url: "http://localhost:3000", description: "Local" }],
    tags: [
      { name: "Meters", description: "Meter search and details" },
      { name: "Readings", description: "Register readings and derived consumption" },
      { name: "Network", description: "Hierarchy, transformers and data quality" },
      { name: "Ops", description: "Health" },
    ],
  });
}

const requestLogger: RequestHandler = (req, res, next) => {
  const start = performance.now();
  res.on("finish", () => {
    const ms = (performance.now() - start).toFixed(0);
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
};
