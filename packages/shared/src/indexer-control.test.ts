import { describe, expect, it, vi } from "vitest";
import { createIndexerControl } from "./indexer-control.js";

describe("indexer control", () => {
  it("pokes and registers a transaction on the loopback indexer", async () => {
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}", { status: 200 }),
    );
    const control = createIndexerControl("http://127.0.0.1:8788/", "issuer.near", fetchImpl);
    await control.poke();
    await control.registerTx("tx-1");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8788/poke");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:8788/register-tx");
    expect(JSON.parse(String((fetchImpl.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      hash: "tx-1",
      signer: "issuer.near",
    });
  });

  it("throws on a failed control call", async () => {
    const control = createIndexerControl(
      "http://127.0.0.1:8788",
      "a.near",
      async () => new Response("", { status: 500 }),
    );
    await expect(control.poke()).rejects.toThrow("INDEXER_CONTROL_HTTP_500");
  });
});
