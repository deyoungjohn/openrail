/**
 * Asserts that a late refund sent through 1Click arrives at the destination (blueprint 2.8, review 12).
 *
 * Polls GET /v0/status?depositAddress=<address> until status is SUCCESS,
 * and extracts the destination transaction hash.
 */
export interface RefundArrivalLookup {
  oneClickUrl?: string;
  oneClickJwt?: string;
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}

export interface RefundArrival {
  status: "SUCCESS";
  destinationTx: string;
  raw: Record<string, unknown>;
}

export async function waitForRefundArrival(
  ctx: RefundArrivalLookup,
  depositAddress: string,
): Promise<RefundArrival> {
  const url = ctx.oneClickUrl ?? "https://1click.chaindefuser.com";
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const attempts = ctx.attempts ?? 30;
  const intervalMs = ctx.intervalMs ?? 10_000;
  const headers: Record<string, string> = {};
  if (ctx.oneClickJwt) {
    headers["Authorization"] = `Bearer ${ctx.oneClickJwt}`;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const res = await ctx
      .fetchImpl(`${url}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
        headers,
      })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    if (res && typeof res === "object") {
      const record = res as Record<string, unknown>;
      const swapDetails = (record.swapDetails ?? {}) as Record<string, unknown>;
      const status = String(swapDetails.status ?? record.status ?? "");
      if (status === "SUCCESS") {
        const destTxs = Array.isArray(swapDetails.destinationChainTxHashes)
          ? (swapDetails.destinationChainTxHashes as string[])
          : Array.isArray(record.destinationChainTxHashes)
            ? (record.destinationChainTxHashes as string[])
            : [];
        const destinationTx = destTxs[0] ?? String(record.destinationTx ?? "");
        return {
          status: "SUCCESS",
          destinationTx,
          raw: record,
        };
      }
      if (status === "FAILED" || status === "REFUNDED") {
        throw new Error(`1Click refund failed with status: ${status}`);
      }
    }
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw new Error(`1Click refund did not reach SUCCESS within ${attempts} attempts`);
}
