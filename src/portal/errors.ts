export type PortalErrorKind =
  | "auth" // credentials rejected or session could not be re-established
  | "not_found" // portal said 404
  | "rate_limited" // still 429 after retries
  | "unavailable" // network error, timeout, 5xx
  | "contract"; // response did not match the shape we depend on

export class PortalError extends Error {
  override readonly name = "PortalError";

  constructor(
    message: string,
    readonly kind: PortalErrorKind,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}
