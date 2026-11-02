import { randomBytes } from "node:crypto";
import { KeyPair, KeyPairSigner } from "near-api-js";
import { describe, expect, it } from "vitest";
import { AuthError, AuthStore, hashApiKey, nep413Hash, verifyNep413 } from "./auth.js";

const clock = () => Date.parse("2026-11-02T10:00:00Z");

describe("API keys", () => {
  it("stores only a sha256 hash and returns the secret once", () => {
    const store = new AuthStore(clock);
    const { record, secret } = store.createApiKey("acme.openrail.near", "Production", "secret", [
      "invoices:read",
    ]);
    expect(secret.startsWith("or_sk_live_")).toBe(true);
    expect(record.hash).toBe(hashApiKey(secret));
    expect(JSON.stringify(record)).not.toContain(secret);
    const context = store.authenticate(secret);
    expect(context.accountId).toBe("acme.openrail.near");
    expect(context.kind).toBe("secret");
    expect(store.authenticate(secret).scopes).toEqual(["invoices:read"]);
  });

  it("rotates and revokes keys", () => {
    const store = new AuthStore(clock);
    const { record, secret } = store.createApiKey("acme.openrail.near", "Production");
    const rotated = store.rotateApiKey(record.id);
    expect(() => store.authenticate(secret)).toThrow(AuthError);
    expect(store.authenticate(rotated.secret).accountId).toBe("acme.openrail.near");
    store.revokeApiKey(record.id);
    expect(() => store.authenticate(rotated.secret)).toThrow(AuthError);
  });
});

describe("NEP-413 sign-in", () => {
  it("verifies a real NEP-413 signature and issues a 12 h session", async () => {
    const signer = KeyPairSigner.fromSecretKey(KeyPair.fromRandom("ed25519").toString());
    const publicKey = (await signer.getPublicKey()).toString();
    const store = new AuthStore(clock);
    const challenge = store.challenge("acme.openrail.near", "api.openrail.near");
    const nonce = new Uint8Array(Buffer.from(challenge.nonce, "base64"));
    const signed = await signer.signNep413Message("acme.openrail.near", {
      message: challenge.message,
      nonce,
      recipient: challenge.recipient,
    });

    const session = await store.verify(
      {
        accountId: "acme.openrail.near",
        publicKey,
        signature: Buffer.from(signed.signature).toString("base64"),
        nonce: challenge.nonce,
      },
      verifyNep413,
      async () => true,
    );

    expect(session.sessionToken.startsWith("or_sess_")).toBe(true);
    expect(session.expiresAt).toBe("2026-11-02T22:00:00.000Z");
    const context = store.authenticate(session.sessionToken);
    expect(context).toEqual({
      kind: "session",
      accountId: "acme.openrail.near",
      scopes: ["dashboard"],
    });
  });

  it("rejects a wrong signer, expired challenge and tampered message", async () => {
    const store = new AuthStore(clock);
    const challenge = store.challenge("acme.openrail.near", "api.openrail.near");
    await expect(
      store.verify(
        {
          accountId: "acme.openrail.near",
          publicKey: "ed25519:invalid",
          signature: "bad",
          nonce: challenge.nonce,
        },
        verifyNep413,
        async () => true,
      ),
    ).rejects.toThrow("invalid_signature");

    const goodStore = new AuthStore(clock);
    const good = goodStore.challenge("acme.openrail.near", "api.openrail.near");
    const payload = { message: good.message + "x", nonce: good.nonce, recipient: good.recipient };
    const signer = KeyPairSigner.fromSecretKey(KeyPair.fromRandom("ed25519").toString());
    const signed = await signer.signNep413Message("acme.openrail.near", {
      message: good.message,
      nonce: new Uint8Array(Buffer.from(good.nonce, "base64")),
      recipient: good.recipient,
    });
    expect(
      verifyNep413(
        (await signer.getPublicKey()).toString(),
        Buffer.from(signed.signature).toString("base64"),
        payload,
      ),
    ).toBe(false);
  });

  it("hashes the borsh NEP-413 payload deterministically", () => {
    const payload = {
      message: "hello",
      nonce: randomBytes(32).toString("base64"),
      recipient: "api.openrail.near",
    };
    expect(nep413Hash(payload).equals(nep413Hash(payload))).toBe(true);
  });
});
