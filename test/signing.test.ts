import { describe, expect, it } from "vitest";
import { signRequest } from "../src/portal/signing.js";

describe("signRequest", () => {
  it("matches an HMAC computed independently with openssl", () => {
    // printf 'GET\n/portal/export\npage=1\n1700000000' | openssl dgst -sha256 -hmac test-secret
    expect(signRequest("test-secret", "GET", "/portal/export", "page=1", 1_700_000_000)).toEqual({
      "x-timestamp": "1700000000",
      "x-signature": "b4b4d3dacaea949dfabeb63650cd8f500ebc3719cf8246de8306a2e31f18d4d6",
    });
  });

  it("floors fractional timestamps and upper-cases the method", () => {
    const a = signRequest("s", "get", "/p", "", 1_700_000_000.9);
    const b = signRequest("s", "GET", "/p", "", 1_700_000_000);
    expect(a).toEqual(b);
  });
});
