import { createApp } from "./api/app.js";
import { loadConfig } from "./config.js";
import { PortalClient } from "./portal/client.js";
import { RateLimiter } from "./portal/rate-limiter.js";
import { CatalogService } from "./services/catalog-service.js";
import { ReadingsService } from "./services/readings-service.js";

const config = loadConfig();

const portal = new PortalClient({
  baseUrl: config.portal.baseUrl,
  email: config.portal.email,
  password: config.portal.password,
  timeoutMs: config.portal.timeoutMs,
  limiter: new RateLimiter(config.portal.maxRequests, config.portal.windowMs),
});

const catalog = new CatalogService(portal, config.snapshotTtlMs);
const readings = new ReadingsService(portal, {
  utcOffset: config.portal.utcOffset,
  ttlMs: config.readingsTtlMs,
});

const { app } = createApp({ catalog, readings }, { logRequests: true });

// Express 5 passes listen errors (e.g. port in use) to this callback.
const server = app.listen(config.port, (err?: Error) => {
  if (err) {
    console.error(`Could not start on port ${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Urja Meter API listening on http://localhost:${config.port} (docs at /docs)`);
});

// Warm the catalog so the first request is fast. A failure here is not fatal: requests
// retry the load, and /health reports the error.
catalog
  .refresh()
  .then((s) => console.log(`Catalog loaded: ${s.meters.length} meters, ${s.transformers.length} transformers`))
  .catch((err: unknown) => console.warn(`Initial catalog load failed: ${String(err)}`));

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
