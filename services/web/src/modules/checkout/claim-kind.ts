import { mockClaims } from "../../lib/mock-data";

/**
 * Resolves the kind of a claim for route dispatching on `/c/<id>`:
 * - 0: invoice (kind 0) -> redirect to `/pay/<id>`
 * - 1: checkout (kind 1) -> render hosted checkout
 * - null: unknown / not found
 */
export async function resolveClaimKind(id: string): Promise<number | null> {
  // 1. In mock/fixture data, mockClaims contains invoices (kind 0)
  if (id in mockClaims) {
    return 0;
  }

  // 2. Try on-chain view if contract is in live mode
  if (process.env.NEXT_PUBLIC_API_MODE === "live") {
    try {
      const root = process.env.NEXT_PUBLIC_ROOT_CONTRACT ?? "openrail.near";
      const rpcUrls = [
        process.env.NEXT_PUBLIC_NEAR_RPC_URL,
        "https://rpc.mainnet.fastnear.com",
        "https://free.rpc.fastnear.com",
      ].filter((x): x is string => Boolean(x));

      for (const url of rpcUrls) {
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
                method_name: "claim",
                args_base64: btoa(JSON.stringify({ token_id: id })),
              },
            }),
            signal: AbortSignal.timeout(3000),
          });
          const body = (await response.json()) as { result?: { result?: number[] } };
          if (body.result?.result) {
            const raw = JSON.parse(
              new TextDecoder().decode(Uint8Array.from(body.result.result)),
            ) as { kind?: number } | null;
            if (raw && typeof raw.kind === "number") {
              return raw.kind;
            }
          }
        } catch {
          // try next RPC url
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Try API public endpoints
  const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787";

  try {
    const res = await fetch(`${API_URL}/v1/public/checkouts/${encodeURIComponent(id)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      return 1;
    }
  } catch {
    // API not reachable
  }

  try {
    const res = await fetch(`${API_URL}/v1/pay/claims/${encodeURIComponent(id)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = (await res.json()) as { token_id?: string; kind?: number };
      if (typeof data.kind === "number") {
        return data.kind;
      }
      if (data.token_id === id) {
        return 0;
      }
    }
  } catch {
    // API not reachable
  }

  return null;
}
