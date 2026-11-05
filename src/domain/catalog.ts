import type { RawHierarchyLevel, RawMeter, RawTransformer } from "../portal/schemas.js";
import {
  NETWORK_LEVELS,
  type DataIssue,
  type Meter,
  type MeterNetwork,
  type NetworkLevel,
  type NetworkRef,
  type Transformer,
} from "./models.js";

const RAW_LEVEL: Record<NetworkLevel, RawHierarchyLevel> = {
  zone: "zone",
  circle: "circle",
  division: "division",
  subdivision: "subdivision",
  substation: "substation",
  feeder: "feeder",
  transformer: "dt",
};

export interface Catalog {
  meters: Meter[];
  transformers: Transformer[];
  issues: DataIssue[];
}

/**
 * Turns the raw export plus the transformer master list into clean records.
 *
 * Repairs, all data driven (nothing is guessed from string patterns):
 *  - a missing code is filled from another record that has the same name at that level
 *  - a missing name is filled from another record that has the same code at that level
 *  - transformer names come from the /portal/dts master list; other names are kept as aliases
 *  - a missing feeder code falls back to the transformer master's feederCode
 */
export function buildCatalog(rawMeters: RawMeter[], rawTransformers: RawTransformer[]): Catalog {
  const issues: DataIssue[] = [];
  const master = new Map(rawTransformers.map((t) => [t.code, t]));
  const lookups = buildLookups(rawMeters, rawTransformers);
  const aliases = new Map<string, Set<string>>();

  const meters = rawMeters.map((raw) => {
    const entity = `meter:${raw.meterId}`;
    const meterIssues: DataIssue[] = [];
    const network = {} as Record<NetworkLevel, NetworkRef>;

    for (const level of NETWORK_LEVELS) {
      const ref = raw.hierarchy[RAW_LEVEL[level]];
      let code = clean(ref.code);
      let name = clean(ref.name);
      const lookup = lookups[level];

      if (!code && name) {
        code = mostCommon(lookup.codesByName.get(name));
        if (code) {
          meterIssues.push(issue("missing_code_filled", entity, `network.${level}.code`,
            `Empty ${level} code; filled "${code}" from other records named "${name}".`));
        }
      }
      if (level === "feeder" && !code) {
        code = master.get(clean(raw.dtCode) ?? "")?.feederCode ?? null;
        if (code) {
          meterIssues.push(issue("missing_code_filled", entity, "network.feeder.code",
            `Empty feeder code; filled "${code}" from the transformer master list.`));
        }
      }
      if (code && !name) {
        name = mostCommon(lookup.namesByCode.get(code));
        if (name) {
          meterIssues.push(issue("missing_name_filled", entity, `network.${level}.name`,
            `Empty ${level} name; filled "${name}" from other records with code "${code}".`));
        }
      }
      if (level === "transformer" && code) {
        const canonical = master.get(code)?.name;
        if (canonical && name && name !== canonical) {
          meterIssues.push(issue("name_differs_from_master", entity, "network.transformer.name",
            `Record calls ${code} "${name}"; using master name "${canonical}".`));
          setAdd(aliases, code, name);
        }
        name = canonical ?? name;
      }
      if (!code || !name) {
        meterIssues.push(issue("unresolved_value", entity, `network.${level}`,
          `Could not resolve ${level} ${code ? "name" : "code"}; left as null.`));
      }
      network[level] = { code, name };
    }

    issues.push(...meterIssues);
    return toMeter(raw, network, meterIssues);
  });

  issues.push(...findReusedCodes(meters));

  return { meters, transformers: buildTransformers(meters, rawTransformers, aliases), issues };
}

function toMeter(raw: RawMeter, network: Record<NetworkLevel, NetworkRef>, dataIssues: DataIssue[]): Meter {
  const meterNetwork: MeterNetwork = {
    ...network,
    nodeId: NETWORK_LEVELS.map((level) => network[level].code ?? "?").join("/"),
  };
  return {
    meterId: raw.meterId.trim(),
    serialNumber: raw.serialNo.trim(),
    make: raw.make.trim(),
    phase: slug(raw.phaseType),
    status: slug(raw.installStatus),
    installationType: slug(raw.installType),
    build: slug(raw.build),
    transformerCode: network.transformer.code ?? raw.dtCode.trim(),
    location: raw.geo ? { latitude: raw.geo.lat, longitude: raw.geo.lng } : null,
    network: meterNetwork,
    dataIssues,
  };
}

function buildTransformers(
  meters: Meter[],
  rawTransformers: RawTransformer[],
  aliases: Map<string, Set<string>>,
): Transformer[] {
  const counts = new Map<string, number>();
  for (const m of meters) counts.set(m.transformerCode, (counts.get(m.transformerCode) ?? 0) + 1);

  return rawTransformers
    .map((t) => ({
      code: t.code,
      name: t.name,
      feederCode: t.feederCode,
      capacityKva: t.capacityKva,
      meterCount: counts.get(t.code) ?? 0,
      otherNamesSeen: [...(aliases.get(t.code) ?? [])].sort(),
    }))
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
}

/**
 * Below zone level the same code shows up under several parents (e.g. D-01 under C-01,
 * C-03 and C-05, with similar meter counts each). That is a property of the data, not
 * noise we can vote away, so we report it and key network nodes by full path instead.
 */
function findReusedCodes(meters: Meter[]): DataIssue[] {
  const out: DataIssue[] = [];
  for (let i = 1; i < NETWORK_LEVELS.length; i++) {
    const level = NETWORK_LEVELS[i]!;
    const parentLevel = NETWORK_LEVELS[i - 1]!;
    const parents = new Map<string, Set<string>>();
    for (const m of meters) {
      const code = m.network[level].code;
      const parent = m.network[parentLevel].code;
      if (code && parent) setAdd(parents, code, parent);
    }
    for (const [code, set] of parents) {
      if (set.size > 1) {
        out.push(issue("code_reused_across_parents", `${level}:${code}`, undefined,
          `${level} ${code} appears under ${set.size} different ${parentLevel}s: ${[...set].sort().join(", ")}.`));
      }
    }
  }
  return out;
}

interface LevelLookup {
  codesByName: Map<string, Map<string, number>>;
  namesByCode: Map<string, Map<string, number>>;
}

function buildLookups(rawMeters: RawMeter[], rawTransformers: RawTransformer[]): Record<NetworkLevel, LevelLookup> {
  const lookups = Object.fromEntries(
    NETWORK_LEVELS.map((l) => [l, { codesByName: new Map(), namesByCode: new Map() }]),
  ) as Record<NetworkLevel, LevelLookup>;

  const record = (level: NetworkLevel, code: string | null, name: string | null) => {
    if (!code || !name) return;
    bump(lookups[level].codesByName, name, code);
    bump(lookups[level].namesByCode, code, name);
  };
  for (const raw of rawMeters) {
    for (const level of NETWORK_LEVELS) {
      const ref = raw.hierarchy[RAW_LEVEL[level]];
      record(level, clean(ref.code), clean(ref.name));
    }
  }
  for (const t of rawTransformers) record("transformer", clean(t.code), clean(t.name));
  return lookups;
}

function issue(type: DataIssue["type"], entity: string, field: string | undefined, message: string): DataIssue {
  return field ? { type, entity, field, message } : { type, entity, message };
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** "CT Operated" -> "ct_operated" */
export function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function bump(map: Map<string, Map<string, number>>, key: string, value: string) {
  const inner = map.get(key) ?? new Map<string, number>();
  inner.set(value, (inner.get(value) ?? 0) + 1);
  map.set(key, inner);
}

function mostCommon(counts: Map<string, number> | undefined): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts ?? []) {
    if (count > bestCount) [best, bestCount] = [value, count];
  }
  return best;
}

function setAdd(map: Map<string, Set<string>>, key: string, value: string) {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}
