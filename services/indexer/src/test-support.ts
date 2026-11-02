import { createLogger, type Logger } from "@openrail/shared";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IndexerStore } from "./store.js";
import type {
  ClaimReader,
  ClaimViewTotals,
  EventSink,
  EventSource,
  ParsedEvent,
  ReceiptEnricher,
  ReceiptEvidence,
  SourceBlock,
  SourcePage,
} from "./types.js";

export const ROOT = "openrail.near";

export function loadBlocks(): SourceBlock[] {
  const path = fileURLToPath(new URL("./fixtures/blocks.json", import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { blocks: SourceBlock[] }).blocks;
}

export function memoryStore(): IndexerStore {
  return new IndexerStore(":memory:", ROOT);
}

export class FakeSource implements EventSource {
  private calls = 0;
  constructor(
    private readonly blocks: SourceBlock[],
    private head = blocks[blocks.length - 1]?.height ?? 0,
  ) {}

  setHead(height: number): void {
    this.head = height;
  }

  callCounts(): Record<string, number> {
    return { "fake.fetch": this.calls };
  }

  async fetch(cursor: string | null): Promise<SourcePage> {
    this.calls += 1;
    const stored = cursor === null ? 0 : Number(cursor.replace("h:", ""));
    const blocks = this.blocks
      .filter((block) => block.height > stored && block.height <= this.head)
      .sort((a, b) => a.height - b.height);
    const latest = blocks[blocks.length - 1]?.height ?? stored;
    return {
      blocks,
      cursor: `h:${latest}`,
      done: true,
      latestBlock: this.head,
    };
  }
}

export class RecordingSink implements EventSink {
  readonly events: ParsedEvent[] = [];
  constructor(private readonly fail = false) {}

  async emit(event: ParsedEvent): Promise<void> {
    if (this.fail) throw new Error("sink down");
    this.events.push(event);
  }
}

export class FakeEnricher implements ReceiptEnricher {
  calls = 0;
  constructor(private readonly evidence?: ReceiptEvidence) {}

  async enrich(): Promise<ReceiptEvidence> {
    this.calls += 1;
    return (
      this.evidence ?? {
        origin_tx: {
          chain: "base",
          hash: "0x" + "cc".repeat(32),
          sender: "0x" + "ee".repeat(20),
          amount: "12500000",
        },
        near_tx_hashes: ["NearHash1", "NearHash2"],
        verified: true,
      }
    );
  }
}

export class FakeClaimReader implements ClaimReader {
  constructor(private readonly claims: Record<string, ClaimViewTotals> = {}) {}

  async claim(tokenId: string): Promise<ClaimViewTotals | null> {
    return this.claims[tokenId] ?? null;
  }
}

export function silentLogger(): Logger {
  return createLogger("indexer-test", () => {});
}
