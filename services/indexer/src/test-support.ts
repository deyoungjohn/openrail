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
  constructor(
    private readonly blocks: SourceBlock[],
    private head = blocks[blocks.length - 1]?.height ?? 0,
  ) {}

  setHead(height: number): void {
    this.head = height;
  }

  async finalHead(): Promise<number> {
    return this.head;
  }

  async fetchRange(fromHeight: number, toHeight: number): Promise<SourceBlock[]> {
    return this.blocks.filter((block) => block.height >= fromHeight && block.height <= toHeight);
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
