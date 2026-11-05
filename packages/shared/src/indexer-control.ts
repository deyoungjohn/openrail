/** Loopback control calls to the indexer (`/poke`, `/register-tx`). */
export type IndexerControlFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface IndexerControl {
  poke(): Promise<void>;
  registerTx(hash: string): Promise<void>;
}

export function createIndexerControl(
  baseUrl: string,
  signer: string,
  fetchImpl: IndexerControlFetchLike = (input, init) => fetch(input, init),
): IndexerControl {
  const base = baseUrl.replace(/\/+$/, "");
  const post = async (path: string, body?: unknown): Promise<void> => {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`INDEXER_CONTROL_HTTP_${response.status}`);
  };
  return {
    poke: () => post("/poke"),
    registerTx: (hash) => post("/register-tx", { hash, signer }),
  };
}
