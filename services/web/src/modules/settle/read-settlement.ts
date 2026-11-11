import type { Settlement } from "./settle";

const RPC_URLS = [process.env.NEXT_PUBLIC_NEAR_RPC_URL, "https://free.rpc.fastnear.com"].filter(
  (u): u is string => typeof u === "string" && u !== "",
);

/** The merchant's payout destination on the root contract, or null when none is set. */
export async function readSettlement(root: string, accountId: string): Promise<Settlement | null> {
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
            finality: "final",
            account_id: root,
            method_name: "settlement_of",
            args_base64: btoa(JSON.stringify({ account_id: accountId })),
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as { result?: { result?: number[] } };
      if (!body.result?.result) throw new Error("VIEW_FAILED");
      return JSON.parse(
        new TextDecoder().decode(Uint8Array.from(body.result.result)),
      ) as Settlement | null;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}
