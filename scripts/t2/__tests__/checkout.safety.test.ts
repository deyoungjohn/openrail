import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(REPO_ROOT, "scripts", "t2", "checkout.ts");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const WRITE_RPC = ["broadcast_tx_commit", "broadcast_tx_async", "send_tx"];

let rpcServer: Server;
let httpServer: Server;
let rpcUrl = "";
let httpUrl = "";
let writes: string[] = [];
let cwd = "";

function listen(server: Server): Promise<string> {
  return new Promise((ready) =>
    server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

beforeAll(async () => {
  rpcServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        method?: string;
        params?: { request_type?: string; method_name?: string };
      };
      const method = String(body.method ?? "");
      if (WRITE_RPC.includes(method)) writes.push(`rpc ${method}`);
      let result: unknown = {};
      if (method === "query" && body.params?.request_type === "view_account") {
        result = { code_hash: "HASH", amount: "1000000000000000000000000" };
      } else if (method === "query") {
        result = { result: [...Buffer.from(JSON.stringify(null))] };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  httpServer = createServer((req, res) => {
    if (req.method !== "GET") writes.push(`http ${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  rpcUrl = await listen(rpcServer);
  httpUrl = await listen(httpServer);
});

afterAll(async () => {
  await Promise.all([rpcServer, httpServer].map((s) => new Promise((d) => s.close(() => d(null)))));
});

function run(
  args: string[] = [],
  env: Record<string, string> = {},
  stdin = "",
): Promise<{ code: number; out: string }> {
  writes = [];
  cwd = mkdtempSync(join(tmpdir(), "checkout-t2-"));
  return new Promise((done) => {
    const child = spawn(TSX, [SCRIPT, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        NEAR_ENV: "mainnet",
        NEAR_ROOT_ACCOUNT: "openrail.invalid",
        NEAR_RPC_URL: rpcUrl,
        API_BASE_URL: httpUrl,
        WEB_BASE_URL: httpUrl,
        INDEXER_URL: httpUrl,
        H1_BUSINESS_ACCOUNT: "acme.near",
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("close", (code) => done({ code: code ?? 1, out }));
    child.stdin.end(stdin);
    setTimeout(() => child.kill(), 50_000);
  });
}

function reportOf(): { result: string; run: string } | null {
  const dir = join(cwd, "reports");
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => /^CHECKOUT-.*\.json$/.test(f));
  if (file === undefined) return null;
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as never;
}

describe("the checkout mainnet runner", () => {
  it("is a dry run by default: it lists all four steps and writes nothing", async () => {
    const { code, out } = await run();
    expect(code).toBe(0);
    expect(out).toContain("dry run complete: nothing was signed or sent");
    for (const step of [
      "$2 USDC on Base",
      "$2 in ETH on Arbitrum",
      "$1 partial payment",
      "1-minute checkout paid after",
    ]) {
      expect(out).toContain(step);
    }
    expect(writes).toEqual([]);
    expect(reportOf()).toBeNull();
  });

  it("refuses a confirmed run without MAX_SPEND_USD", async () => {
    const { code, out } = await run([], { OWED_CONFIRM_MAINNET: "yes" });
    expect(code).toBe(2);
    expect(out).toContain("MISSING_ENV: MAX_SPEND_USD");
    expect(writes).toEqual([]);
  });

  it("reports a missing secret by name and writes nothing", async () => {
    const { code, out } = await run([], {
      OWED_CONFIRM_MAINNET: "yes",
      MAX_SPEND_USD: "15",
    });
    expect(code).toBe(1);
    expect(out).toMatch(
      /MISSING_ENV: (OPENRAIL_API_KEY|H1_REFUND_EVM|H1_OWNER_ACCOUNT|H1_OWNER_PRIVATE_KEY)/,
    );
    expect(writes).toEqual([]);
  });

  it("stops before any write when the person types anything other than YES", async () => {
    const env = {
      OWED_CONFIRM_MAINNET: "yes",
      MAX_SPEND_USD: "15",
      OPENRAIL_API_KEY: "x",
      H1_REFUND_EVM: "0x" + "11".repeat(20),
      H1_OWNER_ACCOUNT: "acme.near",
      H1_OWNER_PRIVATE_KEY: "x",
    };
    for (const answer of ["yes\n", "no\n", "\n"]) {
      const { code, out } = await run([], env, answer);
      expect(code).toBe(1);
      expect(out).toContain("STOPPED");
      expect(writes).toEqual([]);
    }
  });
});
