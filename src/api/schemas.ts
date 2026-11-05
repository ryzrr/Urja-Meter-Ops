import {
  ConsumptionPointSchema,
  DataIssueSchema,
  MeterSchema,
  NetworkLevelSchema,
  NetworkNodeSchema,
  ReadingSchema,
  TransformerSchema,
} from "../domain/models.js";
import { daysBetween, isIsoDate } from "../lib/dates.js";
import { z } from "../lib/zod.js";

export const MAX_RANGE_DAYS = 92;

// ---------- shared ----------

const page = z.coerce.number().int().min(1).default(1).openapi({ example: 1 });
const pageSize = z.coerce.number().int().min(1).max(500).default(50).openapi({ example: 50 });
const code = (example: string) => z.string().trim().min(1).optional().openapi({ example });
const list = (description: string, example: string) => z.string().optional().openapi({ description, example });

export const MeterIdParams = z.object({
  meterId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "Invalid meter id").openapi({ example: "J100001" }),
});

export const TransformerCodeParams = z.object({
  code: z.string().min(1).max(32).openapi({ example: "DT-007" }),
});

const SnapshotMeta = z.object({
  dataAsOf: z.string().openapi({ description: "When the catalog snapshot was loaded from the portal" }),
});
const ListMeta = SnapshotMeta.extend({ total: z.number().int() });
const PagedMeta = ListMeta.extend({ page: z.number().int(), pageSize: z.number().int() });

// ---------- meters ----------

export const MeterListQuery = z.object({
  q: z.string().trim().min(1).optional().openapi({
    description: "Case-insensitive substring of meter ID or serial number",
    example: "J10000",
  }),
  status: list("Comma-separated: installed, faulty, decommissioned", "faulty,decommissioned"),
  make: list("Comma-separated, case-insensitive", "Genus,HPL"),
  phase: list("single, three", "three"),
  installationType: list("whole_current, ct_operated", "ct_operated"),
  build: list("legacy, v2", "v2"),
  zone: code("Z-01"),
  circle: code("C-01"),
  division: code("D-07"),
  subdivision: code("SD-07"),
  substation: code("SS-07"),
  feeder: code("F-007"),
  transformer: code("DT-007"),
  nodeId: z.string().trim().min(1).optional().openapi({
    description: "Only meters under this network node (see /v1/network)",
    example: "Z-01/C-01",
  }),
  near: z
    .string()
    .regex(/^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/, "Expected lat,lng")
    .optional()
    .openapi({ description: "lat,lng. Returns meters within radiusKm, nearest first", example: "26.9124,75.7873" }),
  radiusKm: z.coerce.number().positive().max(100).default(1).openapi({ example: 2 }),
  page,
  pageSize,
});

export const MeterListItemSchema = MeterSchema.extend({
  distanceKm: z.number().optional().openapi({ description: "Present when `near` is used" }),
}).openapi("MeterListItem");

export const MeterListResponse = z
  .object({ data: z.array(MeterListItemSchema), meta: PagedMeta })
  .openapi("MeterList");

export const MeterResponse = z.object({ data: MeterSchema, meta: SnapshotMeta }).openapi("MeterResponse");

// ---------- readings ----------

const isoDate = z.string().refine(isIsoDate, "Expected a calendar date as YYYY-MM-DD");

const rangeFields = {
  from: isoDate.optional().openapi({ description: "Start date, inclusive (portal local time)", example: "2026-06-01" }),
  to: isoDate.optional().openapi({ description: "End date, inclusive (portal local time)", example: "2026-06-07" }),
};

function checkRange(v: { from?: string | undefined; to?: string | undefined }, ctx: z.RefinementCtx) {
  if (Boolean(v.from) !== Boolean(v.to)) {
    ctx.addIssue({ code: "custom", path: ["from"], message: "Provide both from and to, or neither" });
    return;
  }
  if (v.from && v.to && isIsoDate(v.from) && isIsoDate(v.to)) {
    const days = daysBetween(v.from, v.to);
    if (days < 0) ctx.addIssue({ code: "custom", path: ["to"], message: "to must not be before from" });
    if (days >= MAX_RANGE_DAYS) {
      ctx.addIssue({ code: "custom", path: ["to"], message: `Range is limited to ${MAX_RANGE_DAYS} days` });
    }
  }
}

export const RangeQuery = z.object(rangeFields).superRefine(checkRange);

export const ConsumptionQuery = z
  .object({
    ...rangeFields,
    granularity: z.enum(["interval", "day"]).default("day").openapi({
      description: "interval = one point per reading gap (30 min or 1 day depending on meter); day = daily totals",
    }),
  })
  .superRefine(checkRange);

const readingWindow = {
  meterId: z.string().openapi({ example: "J100001" }),
  from: z.string().nullable().openapi({ example: "2026-06-01" }),
  to: z.string().nullable().openapi({ example: "2026-06-07" }),
  interval: z.string().nullable().openapi({
    description: "Inferred reading interval (ISO 8601 duration). PT30M or P1D on this portal.",
    example: "PT30M",
  }),
};

export const ReadingsResponse = z
  .object({
    data: z.object({ ...readingWindow, readings: z.array(ReadingSchema) }),
    dataIssues: z.array(DataIssueSchema),
  })
  .openapi("ReadingsResponse");

export const ConsumptionResponse = z
  .object({
    data: z.object({
      ...readingWindow,
      granularity: z.enum(["interval", "day"]),
      totalKwh: z.number().nullable(),
      totalKvah: z.number().nullable(),
      points: z.array(ConsumptionPointSchema),
    }),
    dataIssues: z.array(DataIssueSchema),
  })
  .openapi("ConsumptionResponse");

// ---------- transformers ----------

export const TransformerListResponse = z
  .object({ data: z.array(TransformerSchema), meta: ListMeta })
  .openapi("TransformerList");

export const TransformerResponse = z
  .object({ data: TransformerSchema, meta: SnapshotMeta })
  .openapi("TransformerResponse");

// ---------- network ----------

export const NetworkQuery = z.object({
  level: NetworkLevelSchema.optional().openapi({ description: "Only nodes at this level" }),
  parentId: z.string().trim().min(1).optional().openapi({ description: "Only direct children of this node", example: "Z-01" }),
});

export const NetworkResponse = z
  .object({ data: z.array(NetworkNodeSchema), meta: ListMeta })
  .openapi("NetworkResponse");

// ---------- data quality ----------

export const DataQualityQuery = z.object({
  type: DataIssueSchema.shape.type.optional(),
});

export const DataQualityResponse = z
  .object({
    data: z.object({
      summary: z.record(z.string(), z.number().int()).openapi({ example: { missing_code_filled: 14 } }),
      issues: z.array(DataIssueSchema),
    }),
    meta: SnapshotMeta,
  })
  .openapi("DataQualityResponse");

// ---------- health ----------

export const HealthResponse = z
  .object({
    status: z.enum(["ok", "degraded", "starting"]),
    catalog: z.object({
      loaded: z.boolean(),
      loadedAt: z.string().nullable(),
      ageSeconds: z.number().nullable(),
      stale: z.boolean(),
      meterCount: z.number().int(),
      lastRefreshError: z.string().nullable(),
    }),
  })
  .openapi("Health");
