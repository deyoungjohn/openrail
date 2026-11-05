import { describe, expect, it } from "vitest";
import { baseEncode } from "near-api-js";
import { implicitKeyMatches } from "./auth.js";
import { createAccessKeyPort } from "./defaults.js";

const HEX = "dd1eaee441064bcc4a4c8ff51762754737caecee0fe01291dbddd0ed274f308c";
const KEY = `ed25519:${baseEncode(Buffer.from(HEX, "hex"))}`;

type Reply = { result?: unknown; error?: { message: string; cause: { name: string } } };
function chain(replies: Record<string, Reply | "down">) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const type = (JSON.parse(String(init?.body)) as { params: { request_type: string } }).params
      .request_type;
    const reply = replies[type];
    if (reply === "down" || reply === undefined) throw new Error("fetch failed");
    return new Response(JSON.stringify(reply), { status: 200 });
  };
}
const NO_KEY: Reply = { result: { error: "access key does not exist while viewing" } };
const NO_ACCOUNT: Reply = { error: { message: "no account", cause: { name: "UNKNOWN_ACCOUNT" } } };

describe("implicitKeyMatches", () => {
  it("accepts an implicit account's own key and nothing else", () => {
    expect(implicitKeyMatches(HEX, KEY)).toBe(true);
    expect(implicitKeyMatches(HEX, "ed25519:6E8Cxn2yZfs1x7hRbp2QPrNmCc3qFUq5Tn8Z2TUrjMLK")).toBe(
      false,
    );
    expect(implicitKeyMatches("alice.near", KEY)).toBe(false);
    expect(implicitKeyMatches(HEX, "secp256k1:abc")).toBe(false);
  });
});

describe("access key port", () => {
  it("is true when the chain lists the key", async () => {
    const port = createAccessKeyPort(
      "http://rpc",
      chain({ view_access_key: { result: { nonce: 5 } } }),
    );
    expect(await port.has("alice.near", KEY)).toBe(true);
  });
  it("is false for a key the chain does not list on a named account", async () => {
    const port = createAccessKeyPort("http://rpc", chain({ view_access_key: NO_KEY }));
    expect(await port.has("alice.near", KEY)).toBe(false);
  });
  it("accepts an unfunded implicit account's own key (the account is not on chain yet)", async () => {
    const port = createAccessKeyPort(
      "http://rpc",
      chain({ view_access_key: NO_KEY, view_account: NO_ACCOUNT }),
    );
    expect(await port.has(HEX, KEY)).toBe(true);
  });
  it("refuses another key for an unfunded implicit account", async () => {
    const port = createAccessKeyPort(
      "http://rpc",
      chain({ view_access_key: NO_KEY, view_account: NO_ACCOUNT }),
    );
    expect(await port.has(HEX, "ed25519:6E8Cxn2yZfs1x7hRbp2QPrNmCc3qFUq5Tn8Z2TUrjMLK")).toBe(false);
  });
  it("refuses the default key once the implicit account exists without it", async () => {
    const port = createAccessKeyPort(
      "http://rpc",
      chain({ view_access_key: NO_KEY, view_account: { result: { amount: "1" } } }),
    );
    expect(await port.has(HEX, KEY)).toBe(false);
  });
  it("answers 503, not a silent no, when the chain cannot be read", async () => {
    const port = createAccessKeyPort("http://rpc", chain({ view_access_key: "down" }));
    await expect(port.has("alice.near", KEY)).rejects.toMatchObject({ status: 503 });
  });
});
