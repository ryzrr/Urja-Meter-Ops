import { NETWORK_LEVELS, type Meter, type NetworkLevel } from "./models.js";
import { distanceKm } from "./network.js";

export interface MeterFilters {
  q?: string;
  status?: string[];
  make?: string[];
  phase?: string[];
  installationType?: string[];
  build?: string[];
  network?: Partial<Record<NetworkLevel, string>>;
  nodeId?: string;
  near?: { latitude: number; longitude: number; radiusKm: number };
}

export type MeterMatch = Meter & { distanceKm?: number };

/**
 * Filters the in-memory catalog. Everything is a linear scan, which is fine for the
 * current ~400 meters (and would still be fine at tens of thousands). See README for
 * where this stops working and what would replace it.
 */
export function filterMeters(meters: Meter[], f: MeterFilters): MeterMatch[] {
  const q = f.q?.toLowerCase();
  const inList = (list: string[] | undefined, value: string) =>
    !list?.length || list.includes(value.toLowerCase());
  const networkFilters = NETWORK_LEVELS.flatMap((level) => {
    const code = f.network?.[level];
    return code ? [[level, code.toLowerCase()] as const] : [];
  });

  const matches: MeterMatch[] = [];
  for (const m of meters) {
    if (q && !m.meterId.toLowerCase().includes(q) && !m.serialNumber.toLowerCase().includes(q)) continue;
    if (!inList(f.status, m.status)) continue;
    if (!inList(f.make, m.make)) continue;
    if (!inList(f.phase, m.phase)) continue;
    if (!inList(f.installationType, m.installationType)) continue;
    if (!inList(f.build, m.build)) continue;
    if (networkFilters.some(([level, code]) => m.network[level].code?.toLowerCase() !== code)) continue;
    if (f.nodeId && m.network.nodeId !== f.nodeId && !m.network.nodeId.startsWith(`${f.nodeId}/`)) continue;

    if (f.near) {
      if (!m.location) continue;
      const d = distanceKm(f.near.latitude, f.near.longitude, m.location.latitude, m.location.longitude);
      if (d > f.near.radiusKm) continue;
      matches.push({ ...m, distanceKm: Math.round(d * 1000) / 1000 });
    } else {
      matches.push(m);
    }
  }

  if (f.near) matches.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  return matches;
}

/** "Faulty, decommissioned" -> ["faulty", "decommissioned"] */
export function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : undefined;
}
