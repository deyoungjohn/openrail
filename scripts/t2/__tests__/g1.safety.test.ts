/**
 * Safety tests for the human-run G1 runner (`scripts/t2/g1.ts`).
 *
 * Written from Blueprint 3.5 and AGENTS rules 1 and 2, before the script exists.
 * Every test spawns the real script as a child process against local fake
 * servers; nothing here can reach a real network or move value.
 *
 * Assumptions about the runner's surface are collected in `CONTRACT` below. If
 * the script legitimately differs, change the constant (one line), never the
 * assertions that follow from it.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "t2", "g1.ts");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

const CONTRACT = {
  /** Secrets a sending run needs (names from `.env.example`). Each one missing must be reported. */
  requiredSecrets: ["ISSUER_PRIVATE_KEY", "WATCHER_PRIVATE_KEY", "ONECLICK_JWT"],
  /** Other secrets that may be present in the environment and must never leak. */
  otherSecrets: ["ISSUER_SERVICE_KEY", "NEARBLOCKS_API_KEY"],
  /** JSON-RPC methods that put a transaction on chain. */
  rpcWriteMethods: ["broadcast_tx_commit", "broadcast_tx_async", "send_tx"],
  /** Report location, relative to the working directory the script is started in. */
  reportGlob: /^G1-.*\.json$/,
  reportDir: "reports",
  /** Per-run time budget for the child process. */
  timeoutMs: 60_000,
};

// ---------------------------------------------------------------------------
// Fake chain RPC and fake HTTP server (they share one write ledger)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  server: "rpc" | "http";
  method: string;
  path: string;
  body: string;
  isWrite: boolean;
}

class World {
  requests: RecordedRequest[] = [];
  /** 1-based indices of writes (across both servers) that answer with an error. */
  failWrites = new Set<number>();
  private writeCount = 0;
  private servers: Server[] = [];
  rpcUrl = "";
  httpUrl = "";

  get writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.isWrite);
  }

  async start(): Promise<void> {
    this.rpcUrl = await this.listen("rpc");
    this.httpUrl = await this.listen("http");
  }

  async stop(): Promise<void> {
    await Promise.all(this.servers.map((s) => new Promise((done) => s.close(() => done(null)))));
  }

  reset(): void {
    this.requests = [];
    this.failWrites = new Set();
    this.writeCount = 0;
  }

  private listen(kind: "rpc" | "http"): Promise<string> {
    return new Promise((ready) => {
      const server = createServer((req, res) => this.handle(kind, req, res));
      this.servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
  }

  private handle(kind: "rpc" | "http", req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const method = req.method ?? "GET";
      let isWrite: boolean;
      let rpcMethod = "";
      if (kind === "rpc") {
        try {
          rpcMethod = String((JSON.parse(body) as { method?: unknown }).method ?? "");
        } catch {
          rpcMethod = "";
        }
        isWrite = CONTRACT.rpcWriteMethods.includes(rpcMethod);
      } else {
        isWrite = !["GET", "HEAD", "OPTIONS"].includes(method);
      }
      this.requests.push({
        server: kind,
        method: kind === "rpc" ? rpcMethod : method,
        path: req.url ?? "/",
        body,
        isWrite,
      });
      if (isWrite) {
        this.writeCount += 1;
        if (this.failWrites.has(this.writeCount)) {
          // The error body reflects the request headers, as sloppy upstreams do:
          // a runner that prints upstream errors verbatim would leak secrets here.
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "injected failure", echo: req.headers, body }));
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (kind === "rpc") {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "dontcare",
            result: {
              transaction: { hash: `FakeTxHash${this.writeCount}` },
              status: { SuccessValue: "" },
              final_execution_status: "FINAL",
            },
          }),
        );
      } else {
        res.end(JSON.stringify({ ok: true, id: `fake-${this.writeCount}`, status: "ok" }));
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Child-process runner
// ---------------------------------------------------------------------------

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  cwd: string;
}

const world = new World();
const tmpDirs: string[] = [];

function freshDir(prefix: string, git = false): string {
  const dir = mkdtempSync(join(tmpdir(), `g1safety-${prefix}-`));
  tmpDirs.push(dir);
  if (git) execFileSync("git", ["init", "-q", dir]);
  return dir;
}

function testSecrets(): Record<string, string> {
  const rand = () =>
    Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  const out: Record<string, string> = {};
  for (const name of [...CONTRACT.requiredSecrets, ...CONTRACT.otherSecrets]) {
    out[name] = name.endsWith("PRIVATE_KEY")
      ? `ed25519${":"}${"3QzXk9" + rand() + rand() + "Wm7pRt"}`
      : `zzsentinel_${name.toLowerCase()}_${rand()}`;
  }
  return out;
}

interface RunOptions {
  cwd?: string;
  args?: string[];
  stdin?: string;
  env?: Record<string, string | undefined>;
  /** Start from a full secret set and a sending configuration. Default true. */
  secrets?: Record<string, string>;
}

function baseEnv(home: string, secrets: Record<string, string>): Record<string, string> {
  // Whitelisted environment: no ambient credentials or real endpoints can reach the child.
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: home,
    NEAR_ENV: "mainnet",
    NEAR_RPC_URL: `${world.rpcUrl}/`,
    NEAR_RPC_URL_FALLBACK: `${world.rpcUrl}/`,
    API_BASE_URL: world.httpUrl,
    PAY_BASE_URL: world.httpUrl,
    ONECLICK_API_URL: world.httpUrl,
    INDEXER_URL: world.httpUrl,
    ISSUER_URL: world.httpUrl,
    NEARBLOCKS_API_URL: world.httpUrl,
    EVM_RPC_URL: world.httpUrl,
    ALERT_WEBHOOK_URL: world.httpUrl,
    NEAR_ROOT_ACCOUNT: "root.test.invalid",
    FEE_ACCOUNT: "fee.test.invalid",
    ISSUER_ACCOUNT_ID: "issuer.test.invalid",
    WATCHER_ACCOUNT_ID: "watcher.test.invalid",
    ...secrets,
  };
}

function confirmedEnv(): Record<string, string> {
  return { OWED_CONFIRM_MAINNET: "yes", MAX_SPEND_USD: "5" };
}

function run(opts: RunOptions = {}): Promise<RunResult> {
  if (!existsSync(SCRIPT)) {
    throw new Error(`scripts/t2/g1.ts does not exist yet (expected by the G1 safety tests)`);
  }
  const cwd = opts.cwd ?? freshDir("cwd", true);
  const home = join(cwd, "..", `${cwd.split("/").pop()}-home`);
  mkdirSync(home, { recursive: true });
  tmpDirs.push(home);
  const env: Record<string, string> = baseEnv(home, opts.secrets ?? testSecrets());
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((done, fail) => {
    const child = spawn(TSX, [SCRIPT, ...(opts.args ?? [])], { cwd, env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`g1.ts did not finish in ${CONTRACT.timeoutMs} ms (waiting on a prompt?)`));
    }, CONTRACT.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (/Cannot find (module|package)|ERR_MODULE_NOT_FOUND|ENOENT.*g1\.ts/.test(stderr)) {
        fail(new Error(`g1.ts failed to load:\n${stderr.slice(0, 500)}`));
        return;
      }
      done({ code, stdout, stderr, cwd });
    });
    child.stdin.on("error", () => undefined); // the script may exit before reading all answers
    child.stdin.end(opts.stdin ?? "");
  });
}

const YES = (n: number) => "YES\n".repeat(n);

/** Every file the run left behind (state, reports, logs) under cwd and its sibling home dir. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function leftovers(r: RunResult): string[] {
  return [...filesUnder(r.cwd), ...filesUnder(join(r.cwd, "..", `${r.cwd.split("/").pop()}-home`))];
}

function findReport(r: RunResult): { path: string; json: Record<string, unknown> } | undefined {
  const dir = join(r.cwd, CONTRACT.reportDir);
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((f) => CONTRACT.reportGlob.test(f));
  if (!name) return undefined;
  const path = join(dir, name);
  return { path, json: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> };
}

beforeAll(async () => {
  await world.start();
});
afterAll(async () => {
  await world.stop();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => world.reset());

// ---------------------------------------------------------------------------
// 1. No confirmation flag: nothing is signed or sent
// ---------------------------------------------------------------------------

describe("g1 safety: dry run by default", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["no", "no"],
    ["true", "true"],
    ["1", "1"],
    ["YES (wrong case)", "YES"],
  ])("OWED_CONFIRM_MAINNET %s: zero writes even if every prompt is answered YES", async (_l, v) => {
    await run({
      env: { OWED_CONFIRM_MAINNET: v, MAX_SPEND_USD: "5" },
      stdin: YES(50),
    });
    expect(world.writes).toEqual([]);
  });

  it("dry run with no flag at all still performs only reads and signs nothing", async () => {
    const r = await run({ stdin: YES(50) });
    expect(world.writes).toEqual([]);
    expect(r.stdout + r.stderr).not.toMatch(/FakeTxHash/);
  });
});

// ---------------------------------------------------------------------------
// 2. Flag without a spend cap
// ---------------------------------------------------------------------------

describe("g1 safety: spend cap", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["not a number", "abc"],
    ["negative", "-1"],
  ])("confirm flag with MAX_SPEND_USD %s exits non-zero and sends nothing", async (_l, v) => {
    const r = await run({
      env: { OWED_CONFIRM_MAINNET: "yes", MAX_SPEND_USD: v },
      stdin: YES(50),
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/MAX_SPEND_USD/);
    expect(world.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Only an exact YES continues
// ---------------------------------------------------------------------------

describe("g1 safety: typed confirmation", () => {
  it.each([["yes"], ["Yes"], ["YES "], [" YES"], ["Y"], ["y"], ["ok"], ["true"], [""]])(
    "first answer %j is not YES: stops with zero writes",
    async (answer) => {
      const r = await run({ env: confirmedEnv(), stdin: `${answer}\n${YES(50)}` });
      expect(r.code).not.toBe(0);
      expect(world.writes).toEqual([]);
    },
  );

  it("a non-YES answer after one YES stops the run: at most one write, later steps not attempted", async () => {
    const r = await run({ env: confirmedEnv(), stdin: `YES\nnope\n${YES(50)}` });
    expect(r.code).not.toBe(0);
    expect(world.writes.length).toBeLessThanOrEqual(1);
  });

  it("closed stdin (no answer at all) is not consent", async () => {
    const r = await run({ env: confirmedEnv(), stdin: "" });
    expect(r.code).not.toBe(0);
    expect(world.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. --yes-all only in the sandbox
// ---------------------------------------------------------------------------

describe("g1 safety: --yes-all", () => {
  it.each([["mainnet"], ["testnet"], [""], ["Sandbox"]])(
    "refused when NEAR_ENV=%j: non-zero, nothing sent",
    async (nearEnv) => {
      const r = await run({
        args: ["--yes-all"],
        env: { ...confirmedEnv(), NEAR_ENV: nearEnv },
        stdin: "",
      });
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/--yes-all|NEAR_ENV/);
      expect(world.writes).toEqual([]);
    },
  );

  it("refused when NEAR_ENV is unset", async () => {
    const r = await run({
      args: ["--yes-all"],
      env: { ...confirmedEnv(), NEAR_ENV: undefined },
      stdin: "",
    });
    expect(r.code).not.toBe(0);
    expect(world.writes).toEqual([]);
  });

  it("accepted in the sandbox (positive control): proceeds without prompts", async () => {
    await run({
      args: ["--yes-all"],
      env: { ...confirmedEnv(), NEAR_ENV: "sandbox" },
      stdin: "",
    });
    expect(world.writes.length).toBeGreaterThan(0);
  });

  it("--yes-all does not bypass the confirm flag or the spend cap", async () => {
    await run({
      args: ["--yes-all"],
      env: { NEAR_ENV: "sandbox", OWED_CONFIRM_MAINNET: undefined },
    });
    await run({
      args: ["--yes-all"],
      env: { NEAR_ENV: "sandbox", OWED_CONFIRM_MAINNET: "yes", MAX_SPEND_USD: undefined },
    });
    expect(world.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. No secret value in any output
// ---------------------------------------------------------------------------

describe("g1 safety: secrets never leave the process", () => {
  it.each([
    ["dry run", {}, ""],
    ["confirmed run, all YES", confirmedEnv(), YES(50)],
    ["confirmed run, upstream fails and echoes headers", confirmedEnv(), YES(50)],
  ])("%s: no secret value in stdout, stderr, report or state", async (label, env, stdin) => {
    const secrets = testSecrets();
    if (label.includes("fails")) world.failWrites = new Set([1, 2, 3, 4, 5, 6]);
    const r = await run({ secrets, env, stdin });
    const haystacks: [string, string][] = [
      ["stdout", r.stdout],
      ["stderr", r.stderr],
      ...leftovers(r).map((p): [string, string] => [p, readFileSync(p, "utf8")]),
    ];
    for (const [name, value] of Object.entries(secrets)) {
      for (const [where, text] of haystacks) {
        // Report the name, never the value, if this fails.
        expect(text.includes(value), `${name} appears in ${where.replace(r.cwd, "<cwd>")}`).toBe(
          false,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. --env-file restrictions
// ---------------------------------------------------------------------------

describe("g1 safety: --env-file", () => {
  function writeEnvFile(dir: string, mode: number): string {
    const file = join(dir, "g1.env");
    const lines = Object.entries(testSecrets()).map(([k, v]) => `${k}=${v}`);
    writeFileSync(file, lines.join("\n") + "\n");
    chmodSync(file, mode);
    return file;
  }

  // Secrets come only from the file in these runs.
  const noSecrets = Object.fromEntries(
    [...CONTRACT.requiredSecrets, ...CONTRACT.otherSecrets].map((n) => [n, undefined]),
  );

  async function runWithFile(file: string, cwd: string): Promise<RunResult> {
    return run({ cwd, secrets: {}, args: ["--env-file", file], env: { ...noSecrets }, stdin: "" });
  }

  it("refuses a file inside the repository", async () => {
    const cwd = freshDir("repo", true);
    const file = writeEnvFile(cwd, 0o600);
    const r = await runWithFile(file, cwd);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/env-file/i);
    expect(world.writes).toEqual([]);
  });

  it("refuses a file in a subdirectory of the repository", async () => {
    const cwd = freshDir("repo", true);
    mkdirSync(join(cwd, "secrets"));
    const file = writeEnvFile(join(cwd, "secrets"), 0o600);
    const r = await runWithFile(file, cwd);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/env-file/i);
  });

  it.each([[0o640], [0o604], [0o644], [0o660]])(
    "refuses a group/world-accessible file (mode %o) outside the repo",
    async (mode) => {
      const cwd = freshDir("repo", true);
      const outside = freshDir("outside");
      const file = writeEnvFile(outside, mode);
      const r = await runWithFile(file, cwd);
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/env-file|mode|permission/i);
      expect(world.writes).toEqual([]);
    },
  );

  it("refuses a git-tracked file even when it is outside the working repository", async () => {
    const cwd = freshDir("repo", true);
    const otherRepo = freshDir("other", true);
    const file = writeEnvFile(otherRepo, 0o600);
    execFileSync("git", ["-C", otherRepo, "add", "g1.env"]);
    const r = await runWithFile(file, cwd);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/env-file|tracked/i);
  });

  it("refuses a symlink that resolves into the repository", async () => {
    const cwd = freshDir("repo", true);
    const inside = writeEnvFile(cwd, 0o600);
    const outside = freshDir("outside");
    const link = join(outside, "link.env");
    execFileSync("ln", ["-s", inside, link]);
    const r = await runWithFile(link, cwd);
    expect(r.code).not.toBe(0);
  });

  it("refuses a missing file", async () => {
    const cwd = freshDir("repo", true);
    const r = await runWithFile(join(freshDir("outside"), "nope.env"), cwd);
    expect(r.code).not.toBe(0);
  });

  it("accepts a 0600, untracked file outside the repository (positive control)", async () => {
    const cwd = freshDir("repo", true);
    const outside = freshDir("outside");
    const file = writeEnvFile(outside, 0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const r = await runWithFile(file, cwd);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/MISSING_ENV/);
  });
});

// ---------------------------------------------------------------------------
// 7. Missing secret
// ---------------------------------------------------------------------------

describe("g1 safety: missing secrets", () => {
  it.each(CONTRACT.requiredSecrets.map((n) => [n]))(
    "%s missing: exits non-zero with MISSING_ENV and writes nothing",
    async (name) => {
      const r = await run({
        env: { ...confirmedEnv(), [name]: undefined },
        stdin: YES(50),
      });
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toContain(`MISSING_ENV: ${name}`);
      expect(world.writes).toEqual([]);
      // No partial state: no report, no state file, nothing created at all.
      expect(leftovers(r)).toEqual([]);
    },
  );

  it("an empty value counts as missing", async () => {
    const r = await run({
      env: { ...confirmedEnv(), ISSUER_PRIVATE_KEY: "" },
      stdin: YES(50),
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("MISSING_ENV: ISSUER_PRIVATE_KEY");
    expect(world.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. Resume after a failure
// ---------------------------------------------------------------------------

describe("g1 safety: resume", () => {
  it("rerun after a failure at write N re-sends only write N onwards", async () => {
    // Baseline: how many writes does a clean, fully confirmed run perform?
    const baseline = await run({ env: confirmedEnv(), stdin: YES(100) });
    expect(baseline.code).toBe(0);
    const total = world.writes.length;
    expect(total).toBeGreaterThanOrEqual(2);
    world.reset();

    // Run 1: the second write fails.
    const cwd = freshDir("resume", true);
    const secrets = testSecrets();
    world.failWrites = new Set([2]);
    const first = await run({ cwd, secrets, env: confirmedEnv(), stdin: YES(100) });
    expect(first.code).not.toBe(0);
    const sentBefore = world.writes.length;
    expect(sentBefore).toBeGreaterThanOrEqual(2);
    world.reset();

    // Run 2: same working directory and state, the failure is gone.
    const second = await run({ cwd, secrets, env: confirmedEnv(), stdin: YES(100) });
    expect(second.code).toBe(0);
    // Write 1 succeeded in run 1 and must not be sent again; the failed write is retried.
    expect(world.writes.length).toBe(total - 1);
  }, 30_000);

  it("a run that already finished does not send anything again", async () => {
    const cwd = freshDir("resume", true);
    const secrets = testSecrets();
    const first = await run({ cwd, secrets, env: confirmedEnv(), stdin: YES(100) });
    expect(first.code).toBe(0);
    world.reset();
    await run({ cwd, secrets, env: confirmedEnv(), stdin: YES(100) });
    expect(world.writes).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 9. The report's verdict follows from the recorded results
// ---------------------------------------------------------------------------

type Step = Record<string, unknown>;

function verdictOf(report: Record<string, unknown>): unknown {
  return report.result ?? report.verdict ?? report.overall;
}

function stepsOf(report: Record<string, unknown>): Step[] {
  return (report.steps ?? []) as Step[];
}

function statusOf(step: Step): unknown {
  return step.status ?? step.result;
}

describe("g1 safety: mechanical verdict", () => {
  it("a failing step makes the report FAIL, and a clean run is PASS", async () => {
    const good = await run({ env: confirmedEnv(), stdin: YES(100) });
    const goodReport = findReport(good);
    expect(good.code).toBe(0);
    expect(goodReport, "a clean run must write reports/G1-<UTC>.json").toBeDefined();
    expect(verdictOf(goodReport!.json)).toBe("PASS");
    expect(stepsOf(goodReport!.json).every((s) => statusOf(s) === "PASS")).toBe(true);
    world.reset();

    world.failWrites = new Set([2]);
    const bad = await run({ env: confirmedEnv(), stdin: YES(100) });
    const badReport = findReport(bad);
    expect(bad.code).not.toBe(0);
    expect(badReport, "a failed run must still write its report").toBeDefined();
    expect(stepsOf(badReport!.json).some((s) => statusOf(s) === "FAIL")).toBe(true);
    expect(verdictOf(badReport!.json)).toBe("FAIL");
  });

  it("the report carries the transaction hashes the fake chain returned", async () => {
    const r = await run({ env: confirmedEnv(), stdin: YES(100) });
    const report = findReport(r);
    expect(JSON.stringify(report?.json)).toMatch(/FakeTxHash1/);
  });

  it("a dry run never reports PASS for steps it did not execute", async () => {
    const r = await run({ stdin: "" });
    const report = findReport(r);
    if (report) {
      for (const step of stepsOf(report.json)) {
        expect(["DRY_RUN", "SKIPPED", "DRY-RUN"]).toContain(String(statusOf(step)));
      }
      expect(verdictOf(report.json)).not.toBe("PASS");
    }
    expect(world.writes).toEqual([]);
  });
});
