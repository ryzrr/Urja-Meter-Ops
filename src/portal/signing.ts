import { createHmac } from "node:crypto";

/**
 * Signature used by the portal's bulk export endpoint, reverse engineered from the
 * Transformers page bundle:
 *
 *   hex(HMAC-SHA256(secret, `${method}\n${path}\n${query}\n${unixSeconds}`))
 *
 * `query` is the raw query string without the leading "?". The portal accepts a
 * timestamp roughly +/- 5 minutes from its own clock.
 */
export function signRequest(
  secret: string,
  method: string,
  path: string,
  query: string,
  unixSeconds: number,
): { "x-timestamp": string; "x-signature": string } {
  const timestamp = String(Math.floor(unixSeconds));
  const payload = [method.toUpperCase(), path, query, timestamp].join("\n");
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return { "x-timestamp": timestamp, "x-signature": signature };
}
