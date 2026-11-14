import { describe, expect, it } from "vitest";
import { DepositWatch, DEPOSIT_PAUSE_MS } from "./deposit-watch.js";
import type { PaySession } from "./quote.js";
import { paymentStatusOf } from "./app.js";

const NOW = 1_800_000_000_000;

function session(id: string, tokenId: string, deadlineInMs = 3_600_000): PaySession {
  return {
    id,
    token_id: tokenId,
    route_id: "base-usdc",
    quote_id: `q-${id}`,
    deposit_address: `addr-${id}`,
    deadline: new Date(NOW + deadlineInMs).toISOString(),
    deadline_requested: Math.floor((NOW + deadlineInMs) / 1000),
    amount_in: "1000000",
    amount_out: "1000000",
    amount_usd: "1.00",
    spread_bps: 0,
    claim_account: `${tokenId}.openrail.near`,
    terms_hash: "0x",
    status: "pending_deposit",
    created_at: new Date(NOW).toISOString(),
  };
}

function harness(sessions: PaySession[], words: Record<string, string[]>) {
  let now = NOW;
  const asked: string[] = [];
  const pokes: string[] = [];
  const saved: PaySession[] = [];
  let fail = false;
  const watch = new DepositWatch({
    openSessions: () =>
      sessions.filter((s) => s.status === "pending_deposit" || s.status === "processing"),
    save: (s) => {
      saved.push(s);
      const i = sessions.findIndex((x) => x.id === s.id);
      sessions[i] = s;
    },
    status: async (address) => {
      if (fail) throw new Error("ONECLICK_HTTP_429");
      asked.push(address);
      const list = words[address] ?? ["PENDING_DEPOSIT"];
      return { status: list.length > 1 ? (list.shift() as string) : (list[0] as string) };
    },
    poke: async (tokenId) => {
      pokes.push(tokenId);
    },
    statusOf: paymentStatusOf,
    clock: () => now,
  });
  return {
    watch,
    asked,
    pokes,
    saved,
    advance: (ms: number) => {
      now += ms;
    },
    failNext: (v: boolean) => {
      fail = v;
    },
  };
}

describe("deposit watch (the provider triggers, the watcher confirms)", () => {
  it("never pokes while the deposit address is waiting", async () => {
    const h = harness([session("ps1", "c-1")], {});
    for (let i = 0; i < 30; i++) {
      await h.watch.runOnce();
      h.advance(1_000);
    }
    expect(h.pokes).toEqual([]);
    // Every 5 s per session, not every 1 s round: 30 s of rounds is 6 asks.
    expect(h.asked.length).toBe(6);
  });

  it("pokes once per change of word, and stores the final word", async () => {
    const sessions = [session("ps1", "c-7")];
    const h = harness(sessions, {
      "addr-ps1": ["PENDING_DEPOSIT", "PROCESSING", "PROCESSING", "SUCCESS"],
    });
    for (let i = 0; i < 4; i++) {
      await h.watch.runOnce();
      h.advance(5_000);
    }
    expect(h.pokes).toEqual(["c-7", "c-7"]);
    expect(h.saved.at(-1)?.status).toBe("success");
    // Final: not asked again.
    const before = h.asked.length;
    await h.watch.runOnce();
    expect(h.asked.length).toBe(before);
  });

  it("stops asking an hour after the deadline", async () => {
    const h = harness([session("ps1", "c-1", 60_000)], {});
    h.advance(60_000 + 60 * 60_000 + 1);
    await h.watch.runOnce();
    expect(h.asked).toEqual([]);
  });

  it("pauses a minute when the provider refuses (rate limit)", async () => {
    const h = harness([session("ps1", "c-1"), session("ps2", "c-2")], {});
    h.failNext(true);
    await h.watch.runOnce();
    h.failNext(false);
    h.advance(DEPOSIT_PAUSE_MS - 1_000);
    await h.watch.runOnce();
    expect(h.asked).toEqual([]);
    expect(h.watch.health().paused).toBe(true);
    h.advance(1_000);
    await h.watch.runOnce();
    expect(h.asked.length).toBe(2);
  });

  it("a word seen first by the payer's page pokes at once, and the round does not poke it again", async () => {
    const s = session("ps1", "c-9");
    const h = harness([s], { "addr-ps1": ["PROCESSING"] });
    await h.watch.observe(s, "PROCESSING");
    await h.watch.runOnce();
    expect(h.pokes).toEqual(["c-9"]);
  });
});
