import { describe, expect, it } from "vitest";
import { startHealthServer, type HealthSnapshot } from "./health.js";

const SNAPSHOT: HealthSnapshot = {
  status: "ok",
  last_block_height: 123,
  near_balance_yocto: "1500000000000000000000000",
  near_balance_near: 1.5,
  min_balance_near: 0.5,
  claims_tracked: 4,
  fast_claims: 3,
  slow_claims: 1,
  last_tick_at: "2026-11-02T12:00:00Z",
  last_error: null,
};

describe("watcher health endpoint", () => {
  it("serves last block and NEAR balance on /health", async () => {
    const server = await startHealthServer(0, () => SNAPSHOT);
    try {
      const response = await fetch(server.url);
      expect(response.status).toBe(200);
      const body = (await response.json()) as HealthSnapshot;
      expect(body.last_block_height).toBe(123);
      expect(body.near_balance_near).toBe(1.5);
      expect(body.claims_tracked).toBe(4);
    } finally {
      await server.close();
    }
  });

  it("returns 404 for other paths", async () => {
    const server = await startHealthServer(0, () => SNAPSHOT);
    try {
      const response = await fetch(server.url.replace("/health", "/other"));
      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("watcher poke endpoint", () => {
  it("POST /poke?token_id= tells the watcher which claim just got a price, and refuses a bad id", async () => {
    const poked: string[] = [];
    const server = await startHealthServer(
      0,
      () => SNAPSHOT,
      "127.0.0.1",
      (id) => poked.push(id),
    );
    const base = server.url.replace(/\/health$/, "");
    try {
      const ok = await fetch(`${base}/poke?token_id=iamyoungjohn-near-8fe6b5802dce`, {
        method: "POST",
      });
      expect(ok.status).toBe(202);
      expect(poked).toEqual(["iamyoungjohn-near-8fe6b5802dce"]);
      const bad = await fetch(`${base}/poke?token_id=${encodeURIComponent("a b/../c")}`, {
        method: "POST",
      });
      expect(bad.status).toBe(400);
      const get = await fetch(`${base}/poke?token_id=c-1`);
      expect(get.status).toBe(404);
      expect(poked).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
