import { describe, expect, it } from "vitest";
import { base58, checkIntent, ed25519Signature, signedIntent } from "./withdraw";

describe("base58", () => {
  it("matches known vectors", () => {
    expect(base58(new Uint8Array([]))).toBe("");
    expect(base58(new Uint8Array([0]))).toBe("1");
    expect(base58(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
  });
});

describe("ed25519Signature", () => {
  it("keeps an already prefixed signature", () => {
    expect(ed25519Signature("ed25519:abc")).toBe("ed25519:abc");
  });
  it("converts a 64-byte base64 signature to ed25519:<base58>", () => {
    const raw = new Uint8Array(64).fill(7);
    const b64 = btoa(String.fromCharCode(...raw));
    expect(ed25519Signature(b64)).toBe(`ed25519:${base58(raw)}`);
  });
  it("refuses a signature of the wrong length", () => {
    expect(() => ed25519Signature(btoa("short"))).toThrow("BAD_SIGNATURE_LENGTH");
  });
});

describe("the intent", () => {
  const intent = {
    standard: "nep413",
    payload: { message: "{}", nonce: "bm9uY2U=", recipient: "intents.near" },
  };
  it("passes the payload on exactly as generated", () => {
    const out = signedIntent(intent, { publicKey: "ed25519:pk", signature: "ed25519:sig" });
    expect(out.payload).toBe(intent.payload);
    expect(out).toMatchObject({
      standard: "nep413",
      public_key: "ed25519:pk",
      signature: "ed25519:sig",
    });
  });
  it("refuses an intent for another contract or standard", () => {
    expect(() =>
      checkIntent({ ...intent, payload: { ...intent.payload, recipient: "evil.near" } }),
    ).toThrow("UNEXPECTED_INTENT_RECIPIENT");
    expect(() => checkIntent({ ...intent, standard: "erc191" })).toThrow(
      "UNEXPECTED_INTENT_STANDARD",
    );
    expect(() => checkIntent(intent)).not.toThrow();
  });
});
