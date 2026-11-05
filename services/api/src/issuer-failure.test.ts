import { describe, expect, it, vi } from "vitest";
import { issuerFailure } from "./defaults.js";

describe("issuerFailure: the issuer's own code reaches the caller", () => {
  it("keeps a mismatch so the api can retry", () => {
    const e = issuerFailure(
      409,
      '{"error":{"code":"TOKEN_ID_MISMATCH","message":"expected c-5, minted c-7"}}',
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe("token_id_mismatch");
  });
  it("turns a refused service key into a 502 that names the cause", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = issuerFailure(401, '{"error":{"code":"unauthorized"}}');
    expect(e.status).toBe(502);
    expect(e.code).toBe("issuer_unauthorized");
  });
  it("passes a client error through with its code", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = issuerFailure(400, '{"error":{"code":"invalid_request","message":"bad hash"}}');
    expect(e.status).toBe(400);
    expect(e.code).toBe("issuer_invalid_request");
  });
  it("turns a failed chain call into a 502 with the code, not a bare 500", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = issuerFailure(502, '{"error":{"code":"NEAR_CALL_FAILED"}}');
    expect(e.status).toBe(502);
    expect(e.code).toBe("issuer_unavailable");
    expect(e.message).toContain("NEAR_CALL_FAILED");
  });
});
