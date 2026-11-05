import { z } from "../lib/zod.js";

/**
 * Clean models exposed by the API. Each schema is the single source for the TypeScript
 * type and for the OpenAPI component of the same name.
 */

export const NETWORK_LEVELS = [
  "zone",
  "circle",
  "division",
  "subdivision",
  "substation",
  "feeder",
  "transformer",
] as const;
export const NetworkLevelSchema = z.enum(NETWORK_LEVELS).openapi("NetworkLevel");
export type NetworkLevel = z.infer<typeof NetworkLevelSchema>;

export const DataIssueSchema = z
  .object({
    type: z.enum([
      "missing_code_filled",
      "missing_name_filled",
      "name_differs_from_master",
      "unresolved_value",
      "code_reused_across_parents",
      "duplicate_reading_dropped",
      "register_decreased",
    ]),
    entity: z.string().openapi({ example: "meter:J100011" }),
    field: z.string().optional().openapi({ example: "network.circle.code" }),
    message: z.string(),
  })
  .openapi("DataIssue", { description: "A problem found in portal data and what was done about it." });
export type DataIssue = z.infer<typeof DataIssueSchema>;

export const NetworkRefSchema = z
  .object({
    code: z.string().nullable().openapi({ example: "C-01" }),
    name: z.string().nullable().openapi({ example: "Circle 1" }),
  })
  .openapi("NetworkRef");
export type NetworkRef = z.infer<typeof NetworkRefSchema>;

export const MeterNetworkSchema = z
  .object({
    zone: NetworkRefSchema,
    circle: NetworkRefSchema,
    division: NetworkRefSchema,
    subdivision: NetworkRefSchema,
    substation: NetworkRefSchema,
    feeder: NetworkRefSchema,
    transformer: NetworkRefSchema,
    nodeId: z.string().openapi({
      description:
        "ID of the meter's transformer node in /v1/network. Codes below zone level are reused " +
        "under different parents, so a node is identified by its full code path.",
      example: "Z-01/C-01/D-07/SD-07/SS-07/F-007/DT-007",
    }),
  })
  .openapi("MeterNetwork");
export type MeterNetwork = z.infer<typeof MeterNetworkSchema>;

export const LocationSchema = z
  .object({
    latitude: z.number().openapi({ example: 26.8221 }),
    longitude: z.number().openapi({ example: 75.9072 }),
  })
  .openapi("Location");

export const MeterSchema = z
  .object({
    meterId: z.string().openapi({ example: "J100001" }),
    serialNumber: z.string().openapi({ example: "GE84132" }),
    make: z.string().openapi({ example: "L&T" }),
    phase: z.string().openapi({ description: "single | three", example: "single" }),
    status: z.string().openapi({ description: "installed | faulty | decommissioned", example: "installed" }),
    installationType: z.string().openapi({ description: "whole_current | ct_operated", example: "ct_operated" }),
    build: z.string().openapi({
      description: "Portal record generation (legacy | v2). Only affects how the portal stores the record.",
      example: "legacy",
    }),
    transformerCode: z.string().openapi({ example: "DT-002" }),
    location: LocationSchema.nullable(),
    network: MeterNetworkSchema,
    dataIssues: z.array(DataIssueSchema).openapi({ description: "Repairs applied to this record, if any." }),
  })
  .openapi("Meter");
export type Meter = z.infer<typeof MeterSchema>;

export const TransformerSchema = z
  .object({
    code: z.string().openapi({ example: "DT-007" }),
    name: z.string().openapi({ example: "Sanganer DT 7" }),
    feederCode: z.string().openapi({ example: "F-007" }),
    capacityKva: z.number().openapi({ example: 63 }),
    meterCount: z.number().int(),
    otherNamesSeen: z.array(z.string()).openapi({
      description: "Names that meter records use for this transformer but that differ from the master list.",
      example: ["Old Malviya Nagar Xfmr"],
    }),
  })
  .openapi("Transformer");
export type Transformer = z.infer<typeof TransformerSchema>;

export const NetworkNodeSchema = z
  .object({
    id: z.string().openapi({ example: "Z-01/C-01" }),
    parentId: z.string().nullable().openapi({ example: "Z-01" }),
    level: NetworkLevelSchema,
    code: z.string().nullable().openapi({ example: "C-01" }),
    name: z.string().nullable().openapi({ example: "Circle 1" }),
    meterCount: z.number().int(),
    childCount: z.number().int(),
  })
  .openapi("NetworkNode");
export type NetworkNode = z.infer<typeof NetworkNodeSchema>;

export const ReadingSchema = z
  .object({
    timestamp: z.string().openapi({ description: "ISO 8601 with offset", example: "2026-06-24T00:00:00+05:30" }),
    cumulativeKwh: z.number().nullable().openapi({ description: "Active energy register (kWh)", example: 42594.47 }),
    cumulativeKvah: z.number().nullable().openapi({ description: "Apparent energy register (kVAh)", example: 46002.02 }),
    voltageR: z.number().nullable().openapi({ description: "R phase voltage (V)", example: 230 }),
  })
  .openapi("Reading");
export type Reading = z.infer<typeof ReadingSchema>;

export const ConsumptionPointSchema = z
  .object({
    start: z.string().openapi({ example: "2026-06-24T00:00:00+05:30" }),
    end: z.string().openapi({ example: "2026-06-24T00:30:00+05:30" }),
    kwh: z.number().nullable().openapi({ description: "Energy used in the interval (register delta)", example: 0.42 }),
    kvah: z.number().nullable().openapi({ example: 0.45 }),
  })
  .openapi("ConsumptionPoint");
export type ConsumptionPoint = z.infer<typeof ConsumptionPointSchema>;
