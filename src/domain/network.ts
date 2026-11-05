import { NETWORK_LEVELS, type Meter, type NetworkNode } from "./models.js";

/**
 * Builds the network as a flat list of nodes linked by parentId.
 *
 * A node is identified by its full code path ("Z-01/C-01/D-07/..."), because codes below
 * zone level are reused under different parents. Keying by code alone would merge
 * unrelated branches and produce a graph with multiple parents rather than a tree.
 */
export function buildNetwork(meters: Meter[]): NetworkNode[] {
  const nodes = new Map<string, NetworkNode>();

  for (const meter of meters) {
    const path: string[] = [];
    let parentId: string | null = null;

    for (const level of NETWORK_LEVELS) {
      const ref = meter.network[level];
      path.push(ref.code ?? "?");
      const id = path.join("/");

      let node = nodes.get(id);
      if (!node) {
        node = { id, parentId, level, code: ref.code, name: ref.name, meterCount: 0, childCount: 0 };
        nodes.set(id, node);
        if (parentId) nodes.get(parentId)!.childCount++;
      }
      node.meterCount++;
      parentId = id;
    }
  }

  // Sorting by path gives depth-first order: every parent precedes its children.
  return [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/** Great circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
