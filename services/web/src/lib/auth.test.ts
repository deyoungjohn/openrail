import { describe, expect, it, vi } from "vitest";
import { liveAuth, type AuthFetch } from "./auth";

const BASE = "https://api.example.test";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("liveAuth.session (restore on reload)", () => {
  it("asks the API with the cookie and returns the account", async () => {
    const f = vi.fn<AuthFetch>(async () =>
      json(200, { account_id: "acme.near", expires_at: "2026-11-09T10:00:00Z" }),
    );
    const s = await liveAuth(BASE, f).session();
    expect(s).toEqual({ account_id: "acme.near", expires_at: "2026-11-09T10:00:00Z" });
    expect(f).toHaveBeenCalledWith(`${BASE}/v1/auth/session`, {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
    });
  });

  it("401 means signed out, not an error", async () => {
    const f = vi.fn<AuthFetch>(async () =>
      json(401, { error: { code: "unauthorized", message: "no session" } }),
    );
    expect(await liveAuth(BASE, f).session()).toBeNull();
  });

  it("any other failure is an error the screen can retry", async () => {
    const f = vi.fn<AuthFetch>(async () =>
      json(500, { error: { code: "internal", message: "boom" } }),
    );
    await expect(liveAuth(BASE, f).session()).rejects.toThrow();
    const g = vi.fn<AuthFetch>(async () => {
      throw new TypeError("network");
    });
    await expect(liveAuth(BASE, g).session()).rejects.toThrow();
  });
});

describe("liveAuth.signOut", () => {
  it("posts to logout with the cookie and a JSON content type", async () => {
    const f = vi.fn<AuthFetch>(async () => new Response(null, { status: 204 }));
    await liveAuth(BASE, f).signOut();
    expect(f).toHaveBeenCalledWith(`${BASE}/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{}",
    });
  });

  it("fails loudly when the server could not clear the session", async () => {
    const f = vi.fn<AuthFetch>(async () =>
      json(500, { error: { code: "internal", message: "x" } }),
    );
    await expect(liveAuth(BASE, f).signOut()).rejects.toThrow();
  });
});

describe("liveAuth.signIn", () => {
  it("challenge, wallet signature, verify; the token in the response is never returned to the page", async () => {
    const calls: string[] = [];
    const f = vi.fn<AuthFetch>(async (url, init) => {
      calls.push(`${init.method} ${url.replace(BASE, "")}`);
      if (url.endsWith("/v1/auth/challenge"))
        return json(200, { nonce: "AAEC", message: "sign in", recipient: "api.example.test" });
      return json(200, {
        session_token: "or_sess_secret",
        account_id: "acme.near",
        expires_at: "2026-11-09T10:00:00Z",
      });
    });
    const sign = vi.fn(async () => ({
      accountId: "acme.near",
      publicKey: "ed25519:K",
      signature: "sig",
    }));
    const s = await liveAuth(BASE, f).signIn(sign);
    expect(calls).toEqual(["POST /v1/auth/challenge", "POST /v1/auth/verify"]);
    expect(sign).toHaveBeenCalledWith({
      message: "sign in",
      nonce: "AAEC",
      recipient: "api.example.test",
    });
    expect(s).toEqual({ account_id: "acme.near", expires_at: "2026-11-09T10:00:00Z" });
    expect(JSON.stringify(s)).not.toContain("or_sess");
    const verifyBody = JSON.parse(String(f.mock.calls[1]![1].body));
    expect(verifyBody).toEqual({
      account_id: "acme.near",
      public_key: "ed25519:K",
      signature: "sig",
      nonce: "AAEC",
    });
    expect(f.mock.calls[1]![1].credentials).toBe("include");
  });
});

describe("liveAuth.signIn (the API issues the challenge for the connected account)", () => {
  it("sends account_id with the challenge request, then verifies the signed message", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const f: AuthFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/v1/auth/challenge")) {
        return new Response(
          JSON.stringify({ message: "m", nonce: "bm9uY2U=", recipient: "api.openrail.near" }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          account_id: "alice.near",
          expires_at: "2026-11-12T00:00:00Z",
          token: "t",
        }),
        { status: 200 },
      );
    };
    const session = await liveAuth(BASE, f).signIn(
      async () => ({ accountId: "alice.near", publicKey: "ed25519:K", signature: "ed25519:S" }),
      "alice.near",
    );
    expect(session.account_id).toBe("alice.near");
    expect(calls[0]?.body).toEqual({ account_id: "alice.near" });
    expect(calls[1]?.url.endsWith("/v1/auth/verify")).toBe(true);
  });
});
