import { describe, expect, it } from "vitest";
import { buildCatalog } from "../src/domain/catalog.js";
import { buildNetwork } from "../src/domain/network.js";
import { filterMeters } from "../src/domain/search.js";
import { rawMeters, rawTransformers } from "./helpers.js";

const catalog = buildCatalog(rawMeters(), rawTransformers());
const meter = (id: string) => catalog.meters.find((m) => m.meterId === id)!;

describe("buildCatalog", () => {
  it("normalises enums to lower snake case", () => {
    expect(meter("J100001")).toMatchObject({
      serialNumber: "GE84132",
      status: "installed",
      installationType: "ct_operated",
      phase: "single",
      location: { latitude: expect.any(Number), longitude: expect.any(Number) },
    });
  });

  it("fills an empty code from other records with the same name", () => {
    const m = meter("J100011"); // circle code "" with name "Circle 6"
    expect(m.network.circle).toEqual({ code: "C-06", name: "Circle 6" });
    expect(m.dataIssues).toMatchObject([{ type: "missing_code_filled", field: "network.circle.code" }]);
  });

  it("fills an empty name from other records with the same code", () => {
    const m = meter("J100218"); // circle "C-01" with empty name
    expect(m.network.circle).toEqual({ code: "C-01", name: "Circle 1" });
  });

  it("uses the transformer master name and records the conflicting one", () => {
    expect(meter("J100400").network.transformer).toEqual({ code: "DT-007", name: "Sanganer DT 7" });
    const dt7 = catalog.transformers.find((t) => t.code === "DT-007");
    expect(dt7?.otherNamesSeen).toEqual(["Old Malviya Nagar Xfmr"]);
  });

  it("resolves every gap in the fixture", () => {
    expect(catalog.issues.filter((i) => i.type === "unresolved_value")).toEqual([]);
    for (const m of catalog.meters) expect(m.network.nodeId).not.toContain("?");
  });

  it("reports codes that appear under more than one parent", () => {
    const reused = catalog.issues.filter((i) => i.type === "code_reused_across_parents");
    expect(reused.length).toBeGreaterThan(0);
    expect(reused.every((i) => /^(circle|division|subdivision|substation|feeder|transformer):/.test(i.entity))).toBe(true);
  });
});

describe("buildNetwork", () => {
  const nodes = buildNetwork(catalog.meters);

  it("puts every parent before its children and links them by path", () => {
    const seen = new Set<string>();
    for (const n of nodes) {
      if (n.parentId) expect(seen.has(n.parentId)).toBe(true);
      seen.add(n.id);
    }
  });

  it("counts meters at each level consistently", () => {
    const zoneTotal = nodes.filter((n) => n.level === "zone").reduce((s, n) => s + n.meterCount, 0);
    const leafTotal = nodes.filter((n) => n.level === "transformer").reduce((s, n) => s + n.meterCount, 0);
    expect(zoneTotal).toBe(catalog.meters.length);
    expect(leafTotal).toBe(catalog.meters.length);
  });
});

describe("filterMeters", () => {
  it("combines filters with AND and list values with OR", () => {
    const result = filterMeters(catalog.meters, { status: ["faulty", "decommissioned"], phase: ["three"] });
    expect(result.length).toBeGreaterThan(0);
    for (const m of result) {
      expect(["faulty", "decommissioned"]).toContain(m.status);
      expect(m.phase).toBe("three");
    }
  });

  it("matches meter id or serial, case-insensitively", () => {
    expect(filterMeters(catalog.meters, { q: "ge84132" }).map((m) => m.meterId)).toEqual(["J100001"]);
  });

  it("filters by subtree", () => {
    const result = filterMeters(catalog.meters, { nodeId: "Z-01/C-01" });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((m) => m.network.nodeId.startsWith("Z-01/C-01/"))).toBe(true);
  });

  it("returns meters within a radius, nearest first", () => {
    const { latitude, longitude } = meter("J100001").location!;
    const result = filterMeters(catalog.meters, { near: { latitude, longitude, radiusKm: 3 } });
    expect(result[0]?.meterId).toBe("J100001");
    expect(result[0]?.distanceKm).toBe(0);
    const distances = result.map((m) => m.distanceKm!);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });
});
