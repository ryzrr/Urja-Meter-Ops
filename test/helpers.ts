import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PortalSource } from "../src/portal/client.js";
import type { RawMeter, RawReading, RawTransformer } from "../src/portal/schemas.js";

/** Loads a recorded portal response from test/fixtures. */
export function fixture<T = unknown>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export const rawMeters = () => fixture<{ data: RawMeter[] }>("export.json").data;
export const rawTransformers = () => [
  ...fixture<{ data: RawTransformer[] }>("dts-page1.json").data,
  ...fixture<{ data: RawTransformer[] }>("dts-page2.json").data,
];
export const rawReadings = (name: string) => fixture<{ data: RawReading[] }>(name).data;

/** In-memory PortalSource backed by fixtures, counting calls. */
export function fakePortal(readings: Record<string, RawReading[]> = {}) {
  const calls = { exportMeters: 0, listTransformers: 0, getReadings: [] as string[] };
  const portal: PortalSource = {
    async exportMeters() {
      calls.exportMeters++;
      return rawMeters();
    },
    async listTransformers() {
      calls.listTransformers++;
      return rawTransformers();
    },
    async getReadings(meterId, range) {
      calls.getReadings.push(`${meterId}|${range?.from ?? ""}|${range?.to ?? ""}`);
      return readings[meterId] ?? [];
    },
  };
  return { portal, calls };
}
