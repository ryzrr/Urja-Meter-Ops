import { z } from "zod";

/**
 * Shapes of the portal's JSON responses that this service depends on. They are checked
 * at runtime so that an upstream change fails loudly with a clear message instead of
 * leaking undefined values into our API.
 */

const HierarchyRef = z.object({ name: z.string(), code: z.string() });

export const RawMeterSchema = z.object({
  meterId: z.string(),
  serialNo: z.string(),
  make: z.string(),
  phaseType: z.string(),
  installStatus: z.string(),
  installType: z.string(),
  build: z.string(),
  dtCode: z.string(),
  hierarchy: z.object({
    zone: HierarchyRef,
    circle: HierarchyRef,
    division: HierarchyRef,
    subdivision: HierarchyRef,
    substation: HierarchyRef,
    feeder: HierarchyRef,
    dt: HierarchyRef,
  }),
  geo: z.object({ lat: z.number(), lng: z.number() }).nullable(),
});
export type RawMeter = z.infer<typeof RawMeterSchema>;
export type RawHierarchyLevel = keyof RawMeter["hierarchy"];

export const ExportResponseSchema = z.object({
  data: z.array(RawMeterSchema),
  total: z.number(),
});

export const RawTransformerSchema = z.object({
  code: z.string(),
  name: z.string(),
  feederCode: z.string(),
  capacityKva: z.number(),
});
export type RawTransformer = z.infer<typeof RawTransformerSchema>;

export const TransformerPageSchema = z.object({
  data: z.array(RawTransformerSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

// Readings arrive as strings ("42594.05"), and occasionally as "" for a missing value.
const ReadingValue = z.union([z.string(), z.number()]).nullish();

export const RawReadingSchema = z.object({
  timestamp: z.string(),
  kwh: ReadingValue,
  kvah: ReadingValue,
  voltR: ReadingValue,
});
export type RawReading = z.infer<typeof RawReadingSchema>;

export const ReadingsResponseSchema = z.object({ data: z.array(RawReadingSchema) });

export const KeysResponseSchema = z.object({
  data: z.object({ signingSecret: z.string().min(1) }),
});
