const RPC_URLS = [process.env.NEXT_PUBLIC_NEAR_RPC_URL, "https://free.rpc.fastnear.com"].filter(
  (u): u is string => typeof u === "string" && u !== "",
);

/** The verifier contract of NEAR Intents: a signed intent is accepted only from a key registered here. */
export const INTENTS_CONTRACT = "intents.near";

/**
 * The public keys `intents.near` accepts for an account (`public_keys_of`). `optimistic` reads the newest block, so a
 * key registered a moment ago shows at once.
 */
export async function intentsKeysOf(accountId: string): Promise<string[]> {
  let last: unknown = new Error("RPC: no url");
  for (const url of RPC_URLS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "query",
          params: {
            request_type: "call_function",
            finality: "optimistic",
            account_id: INTENTS_CONTRACT,
            method_name: "public_keys_of",
            args_base64: btoa(JSON.stringify({ account_id: accountId })),
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as { result?: { result?: number[] } };
      if (!body.result?.result) throw new Error("VIEW_FAILED");
      const keys = JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result)));
      return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/** The wallet transaction that registers a key with `intents.near` (the merchant signs it; 1 yoctoNEAR, as the method requires). */
export function addPublicKeyCall(publicKey: string) {
  return {
    receiverId: INTENTS_CONTRACT,
    methodName: "add_public_key",
    args: { public_key: publicKey },
    gas: "30000000000000",
    deposit: "1",
  };
}
