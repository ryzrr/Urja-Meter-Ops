import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import type { ZodType } from "zod";
import { z } from "../lib/zod.js";
import { PortalError } from "../portal/errors.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "invalid_request" }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi("Error");

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Invalid request parameters",
  404: "Resource not found",
  502: "The portal failed, rejected our credentials, or changed its response format",
  503: "The portal is rate limiting us or the catalog is not loaded yet; retry later",
};

/** OpenAPI response entries for the given error statuses. */
export function errorResponses(...statuses: number[]) {
  return Object.fromEntries(
    statuses.map((s) => [
      s,
      { description: ERROR_DESCRIPTIONS[s] ?? "Error", content: { "application/json": { schema: ErrorResponseSchema } } },
    ]),
  );
}

export function parseOr400<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new ApiError(400, "invalid_request", "Request validation failed", details);
  }
  return result.data;
}

function send(res: Response, status: number, code: string, message: string, details?: unknown) {
  res.status(status).json({ error: details === undefined ? { code, message } : { code, message, details } });
}

export const notFoundHandler: RequestHandler = (req, res) => {
  send(res, 404, "route_not_found", `No route for ${req.method} ${req.path}`);
};

export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof ApiError) return send(res, err.status, err.code, err.message, err.details);

  if (err instanceof PortalError) {
    switch (err.kind) {
      case "not_found":
        return send(res, 404, "not_found", "The portal has no such resource");
      case "rate_limited":
        res.set("Retry-After", "30");
        return send(res, 503, "upstream_rate_limited", "The portal is rate limiting requests; retry in about 30 seconds");
      case "auth":
        return send(res, 502, "upstream_auth_failed", "Could not authenticate with the portal");
      case "contract":
        return send(res, 502, "upstream_contract_changed", err.message);
      case "unavailable":
        return send(res, 502, "upstream_unavailable", err.message);
    }
  }

  // Malformed JSON bodies and similar errors raised by Express itself.
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return send(res, status, "invalid_request", (err as Error).message);
  }

  console.error(err);
  send(res, 500, "internal_error", "Unexpected error");
};
