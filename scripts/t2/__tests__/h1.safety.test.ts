/**
 * Safety tests for the H1 / REL-1 runner (`scripts/t2/h1.ts`). Every test spawns the real script
 * against local fake servers; nothing here can reach a real network or move value.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "t2", "h1.ts");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const WRITE_RPC = ["broadcast_tx_commit", "broadcast_tx_async", "send_tx"];

const svg = (text: string) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg><text>${text}</text></svg>`).toString("base64")}`;

const CLAIM = {
  status: "Paid",
  terms_hash: "0x" + "ab".repeat(32),
  owner_id: "owner.near",
  booked_total: "3000000",
  distributed_total: "2992500",
  fee_total: "7500",
  surplus: "0",
  claim_account: "c-1.openrail.invalid",
  settlement_assets: ["nep141:usdc"],
};

const VIEWS: Record<string, unknown> = {
  claim: CLAIM,
  config: { fee_bps: 25 },
  next_token_id: 4,
  nft_token: { token_id: "c-1", metadata: { media: svg("Paid $3.00 100%") } },
  sponsor_status: { pool: "0", cap: 5, used: 0 },
  payout_relayers: [],
  settlement_of: null,
};

let rpcServer: Server;
let httpServer: Server;
let rpcUrl = "";
let httpUrl = "";
let writes: string[] = [];
let calls: string[] = [];
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
        const name = String(body.params?.method_name);
        calls.push(name);
        result = { result: [...Buffer.from(JSON.stringify(VIEWS[name] ?? null))] };
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
  args: string[],
  env: Record<string, string> = {},
  stdin = "",
): Promise<{ code: number; out: string }> {
  writes = [];
  calls = [];
  cwd = mkdtempSync(join(tmpdir(), "h1-"));
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
        EXPECTED_CODE_HASH: "HASH",
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

function reportOf(): { result: string; run: string; steps: Array<{ status: string }> } | null {
  const dir = join(cwd, "reports");
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => /^(REL1|H1)-.*\.json$/.test(f));
  if (file === undefined) return null;
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as never;
}

describe("the H1 / REL-1 runner", () => {
  it("needs --set rel1 or --set h1", async () => {
    const { code, out } = await run([]);
    expect(code).toBe(2);
    expect(out).toContain("usage: pnpm t2:h1 --set rel1|h1");
    expect(writes).toEqual([]);
  });

  it("names the business account from the environment and exits without it", async () => {
    const { code, out } = await run(["--set", "rel1"], { H1_BUSINESS_ACCOUNT: "" });
    expect(code).toBe(1);
    expect(out).toContain("MISSING_ENV: H1_BUSINESS_ACCOUNT");
  });

  it("the h1 set is a dry run by default: it lists every step and writes nothing", async () => {
    const { code, out } = await run(["--set", "h1"]);
    expect(code).toBe(0);
    expect(out).toContain("dry run complete: nothing was signed or sent");
    for (const name of [
      "issue invoice A",
      "short deposit",
      "overpayment",
      "late payment",
      "stray token",
      "transfer during reconcile",
      "two payments in a row",
    ]) {
      expect(out).toContain(name);
    }
    expect(writes).toEqual([]);
    expect(reportOf()).toBeNull();
  });

  it("a confirmed run without a spend cap is refused", async () => {
    const { code, out } = await run(["--set", "h1"], { OWED_CONFIRM_MAINNET: "yes" });
    expect(code).toBe(2);
    expect(out).toContain("MISSING_ENV: MAX_SPEND_USD");
    expect(writes).toEqual([]);
  });

  it("a confirmed h1 run reports a missing secret by name and writes nothing", async () => {
    const { code, out } = await run(["--set", "h1"], {
      OWED_CONFIRM_MAINNET: "yes",
      MAX_SPEND_USD: "20",
    });
    expect(code).toBe(1);
    expect(out).toMatch(
      /MISSING_ENV: (ISSUER_PRIVATE_KEY|WATCHER_PRIVATE_KEY|ONECLICK_JWT|OPENRAIL_API_KEY|H1_REFUND_EVM|G1_EVM_DEBTOR_ADDRESS|H1_OWNER_ACCOUNT|H1_OWNER_PRIVATE_KEY)/,
    );
    expect(writes).toEqual([]);
  });

  it("a typed answer other than YES stops the first writing step with zero writes", async () => {
    const env = {
      OWED_CONFIRM_MAINNET: "yes",
      MAX_SPEND_USD: "20",
      ISSUER_PRIVATE_KEY: "x",
      WATCHER_PRIVATE_KEY: "x",
      ONECLICK_JWT: "x",
      OPENRAIL_API_KEY: "x",
      H1_REFUND_EVM: "0x" + "11".repeat(20),
      G1_EVM_DEBTOR_ADDRESS: "0x" + "22".repeat(20),
      H1_OWNER_ACCOUNT: "owner.near",
      H1_OWNER_PRIVATE_KEY: "x",
    };
    for (const answer of ["yes\n", "Yes\n", "y\n", "\n"]) {
      const { code, out } = await run(["--set", "h1"], env, answer);
      expect(code).toBe(1);
      expect(out).toContain("STOPPED");
      expect(writes).toEqual([]);
    }
  });

  it("the rel1 set only reads, even when confirmed, and its result follows from the checks", async () => {
    const { code, out } = await run(["--set", "rel1"], {
      OWED_CONFIRM_MAINNET: "yes",
      MAX_SPEND_USD: "1",
    });
    expect(out).toContain("PASS");
    expect(code).toBe(0);
    expect(writes).toEqual([]);
    const report = reportOf();
    expect(report?.run).toBe("REL1");
    expect(report?.result).toBe("PASS");
    expect(report?.steps.every((s) => s.status === "PASS")).toBe(true);
  });

  it("rel1 fails (and says so in the report) when the deployed code is not the expected build", async () => {
    const { code } = await run(["--set", "rel1"], { EXPECTED_CODE_HASH: "SOMETHING_ELSE" });
    expect(code).toBe(1);
    expect(reportOf()?.result).toBe("FAIL");
    expect(writes).toEqual([]);
  });

  it("rel1 fails when a paid claim is no longer paid", async () => {
    VIEWS.claim = { ...CLAIM, status: "Issued" };
    try {
      const { code } = await run(["--set", "rel1"]);
      expect(code).toBe(1);
      expect(reportOf()?.result).toBe("FAIL");
    } finally {
      VIEWS.claim = CLAIM;
    }
  });

  it("rel1 fails when the live picture does not follow the claim", async () => {
    VIEWS.nft_token = { token_id: "c-1", metadata: { media: svg("Issued $0.00 0%") } };
    try {
      const { code } = await run(["--set", "rel1"]);
      expect(code).toBe(1);
    } finally {
      VIEWS.nft_token = { token_id: "c-1", metadata: { media: svg("Paid $3.00 100%") } };
    }
  });
});
