/**
 * Writes openapi.json from the same Zod schemas the routes use. Run with `npm run openapi`.
 * No portal access is needed: the services are constructed but never called.
 */
import { writeFileSync } from "node:fs";
import { createApp } from "../src/api/app.js";
import type { PortalSource } from "../src/portal/client.js";
import { CatalogService } from "../src/services/catalog-service.js";
import { ReadingsService } from "../src/services/readings-service.js";

const unused = (): never => {
  throw new Error("Portal is not used while generating the OpenAPI document");
};
const portal: PortalSource = { exportMeters: unused, listTransformers: unused, getReadings: unused };

const { openapi } = createApp({
  catalog: new CatalogService(portal, 1),
  readings: new ReadingsService(portal, { utcOffset: "+05:30", ttlMs: 1 }),
});

writeFileSync("openapi.json", `${JSON.stringify(openapi, null, 2)}\n`);
console.log(`Wrote openapi.json (${Object.keys(openapi.paths ?? {}).length} paths)`);
