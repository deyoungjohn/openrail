/** Emits indexed events to the API only. The sink is called once per newly inserted event. */
import { createHmac } from "node:crypto";
import type { EventSink, ParsedEvent } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpEventSink implements EventSink {
  private readonly url: string;
  private readonly secret: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    url: string,
    secret: string,
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.url = url;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
  }

  async emit(event: ParsedEvent): Promise<void> {
    const body = JSON.stringify({
      type: event.event,
      token_id: event.tokenId,
      block_height: event.blockHeight,
      tx_hash: event.txHash,
      data: event.data,
    });
    const signature =
      this.secret === ""
        ? undefined
        : `sha256=${createHmac("sha256", this.secret).update(body).digest("hex")}`;
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature === undefined ? {} : { "x-openrail-signature": signature }),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`WEBHOOK_HTTP_${response.status}`);
  }
}
