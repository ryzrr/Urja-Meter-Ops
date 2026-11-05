import { existsSync } from "node:fs";
import { z } from "zod";

const seconds = (fallback: number) => z.coerce.number().positive().default(fallback);

const EnvSchema = z.object({
  PORTAL_BASE_URL: z.url().default("https://urja-ops.flockenergy.tech"),
  PORTAL_EMAIL: z.string().min(1, "PORTAL_EMAIL is required"),
  PORTAL_PASSWORD: z.string().min(1, "PORTAL_PASSWORD is required"),
  PORT: z.coerce.number().int().positive().default(3000),
  SNAPSHOT_TTL_SECONDS: seconds(600),
  READINGS_TTL_SECONDS: seconds(900),
  PORTAL_MAX_REQUESTS: z.coerce.number().int().positive().default(90),
  PORTAL_WINDOW_SECONDS: seconds(30),
  PORTAL_TIMEOUT_SECONDS: seconds(15),
  PORTAL_UTC_OFFSET: z
    .string()
    .regex(/^[+-]\d{2}:\d{2}$/, "PORTAL_UTC_OFFSET must look like +05:30")
    .default("+05:30"),
});

export interface Config {
  portal: {
    baseUrl: string;
    email: string;
    password: string;
    timeoutMs: number;
    maxRequests: number;
    windowMs: number;
    utcOffset: string;
  };
  port: number;
  snapshotTtlMs: number;
  readingsTtlMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && existsSync(".env")) process.loadEnvFile(".env");

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }
  const e = parsed.data;

  return {
    portal: {
      baseUrl: e.PORTAL_BASE_URL.replace(/\/+$/, ""),
      email: e.PORTAL_EMAIL,
      password: e.PORTAL_PASSWORD,
      timeoutMs: e.PORTAL_TIMEOUT_SECONDS * 1000,
      maxRequests: e.PORTAL_MAX_REQUESTS,
      windowMs: e.PORTAL_WINDOW_SECONDS * 1000,
      utcOffset: e.PORTAL_UTC_OFFSET,
    },
    port: e.PORT,
    snapshotTtlMs: e.SNAPSHOT_TTL_SECONDS * 1000,
    readingsTtlMs: e.READINGS_TTL_SECONDS * 1000,
  };
}
