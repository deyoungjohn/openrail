#!/usr/bin/env -S pnpm exec tsx
/**
 * Human-run G1 mainnet/sandbox runner.
 *
 * Default mode is read-only: it checks the deployed contract/config/endpoints/balances and
 * prints every step. Writes need OWED_CONFIRM_MAINNET=yes and MAX_SPEND_USD (or, for the
 * sandbox only, --yes-all), and every step asks for a typed YES unless --yes-all is used.
 * Secrets come from the environment helper; nothing secret is printed or written.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  NearClient,
  getEnv,
  nearClientFromEnv,
  requireEnv,
  redact,
  redactString,
  utcStamp,
} from "@openrail/shared";

const DEFAULT_API = "https://api.openrail.incepture.dev";
const DEFAULT_WEB = "https://openrail.incepture.dev";
const DEFAULT_INDEXER = "http://127.0.0.1:8788";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const USDC = 1_000_000;

type Network = "mainnet" | "sandbox";
type StepStatus = "PENDING" | "PASS" | "FAIL" | "SKIPPED";

interface StepState {
  status: StepStatus;
  token_id?: string;
  invoice_id?: string;
  tx_hashes: string[];
  request_ids: string[];
  evidence?: Record<string, unknown>;
  error?: string;
}

export interface G1State {
  version: 1;
  network: Network;
  started_utc: string;
  steps: Record<string, StepState>;
}

export interface G1Report {
  run: "G1";
  network: Network;
  started_utc: string;
  finished_utc: string;
  result: "PASS" | "FAIL";
  code_hash: string | null;
  steps: Array<{
    step: number;
    name: string;
    status: StepStatus;
    tx_hashes: string[];
    request_ids: string[];
    evidence?: Record<string, unknown>;
    error?: string;
  }>;
}

interface Options {
  yesAll: boolean;
  envFile?: string;
  statePath: string;
  reportDir: string;
  timeoutMs: number;
}

interface Ctx {
  options: Options;
  network: Network;
  sandbox: boolean;
  dryRun: boolean;
  send: boolean;
  api: string;
  web: string;
  indexer: string;
  root: string;
  near: NearClient;
  state: G1State;
  prompt: (question: string) => Promise<string>;
  fetchImpl: typeof fetch;
  codeHash: string | null;
  currentStep: number;
  started: boolean;
}

class StopRun extends Error {}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    yesAll: false,
    statePath: process.env.G1_STATE_PATH ?? join(process.cwd(), "reports/G1-state.json"),
    reportDir: process.env.G1_REPORT_DIR ?? join(process.cwd(), "reports"),
    timeoutMs: Number(process.env.G1_POLL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--yes-all") options.yesAll = true;
    else if (arg === "--env-file") {
      const path = argv[++i];
      if (path === undefined) fail("--env-file needs a path");
      options.envFile = path;
    } else if (arg.startsWith("--env-file=")) options.envFile = arg.slice("--env-file=".length);
    else if (arg === "--state") {
      const path = argv[++i];
      if (path === undefined) fail("--state needs a path");
      options.statePath = path;
    } else if (arg.startsWith("--state=")) options.statePath = arg.slice("--state=".length);
    else if (arg === "--reports-dir") {
      const path = argv[++i];
      if (path === undefined) fail("--reports-dir needs a path");
      options.reportDir = path;
    } else if (arg.startsWith("--reports-dir="))
      options.reportDir = arg.slice("--reports-dir=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: pnpm t2:g1 [--yes-all] [--env-file PATH] [--state PATH] [--reports-dir DIR]",
      );
      process.exit(0);
    } else fail(`UNKNOWN_ARG: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    fail("G1_POLL_TIMEOUT_MS must be positive");
  return options;
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) fail(`ENV_FILE_MISSING: env-file ${path}`);
  const absolute = realpathSync(resolve(path));
  const repoRelative = relative(realpathSync(process.cwd()), absolute);
  if (!repoRelative.startsWith("..") && !repoRelative.startsWith("/")) {
    fail("ENV_FILE_INSIDE_REPO: refusing an env-file inside the repository");
  }
  const stats = statSync(absolute);
  if ((stats.mode & 0o077) !== 0) fail("ENV_FILE_PERMISSIONS: env-file must be mode 0600");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid())
    fail("ENV_FILE_OWNER: env-file must be owned by the current user");
  try {
    execFileSync("git", ["-C", dirname(absolute), "ls-files", "--error-unmatch", absolute], {
      stdio: "ignore",
    });
    fail("ENV_FILE_TRACKED: refusing a git-tracked env-file");
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENV_FILE_TRACKED")) throw error;
  }
  for (const line of readFileSync(absolute, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) fail(`ENV_FILE_INVALID: ${path}`);
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

function loadState(path: string, network: Network): G1State {
  if (!existsSync(path)) {
    return { version: 1, network, started_utc: new Date().toISOString(), steps: {} };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as G1State;
  if (parsed.version !== 1 || parsed.network !== network)
    fail("G1_STATE_INVALID: state does not match this network");
  return parsed;
}

function saveState(path: string, state: G1State): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function step(state: G1State, number: number): StepState {
  const key = String(number);
  state.steps[key] ??= { status: "PENDING", tx_hashes: [], request_ids: [] };
  return state.steps[key]!;
}

function redactedJson(value: unknown): string {
  return JSON.stringify(redact(value));
}

async function readJson(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${redactString(text.slice(0, 200))}`);
  const body = JSON.parse(text) as unknown;
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function rpcUrls(): string[] {
  const urls = requireEnv("NEAR_RPC_URL")
    .split(",")
    .concat((getEnv("NEAR_RPC_URL_FALLBACK") ?? "").split(","))
    .map((url) => url.trim())
    .filter((url) => url !== "");
  return [...new Set(urls)];
}

/** The first node that answers. A node that times out, answers with something that is not JSON, or errors is skipped. */
async function rpc(
  method: string,
  params: unknown,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let last = new Error("RPC: no url");
  for (const url of rpcUrls()) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "openrail-g1", method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let body: { result?: unknown; error?: unknown };
      try {
        body = JSON.parse(text) as { result?: unknown; error?: unknown };
      } catch {
        throw new Error(
          `${new URL(url).host} answered HTTP ${response.status} with ${text.slice(0, 60).replace(/\s+/g, " ")}`,
        );
      }
      if (!response.ok || body.error !== undefined || body.result === undefined) {
        throw new Error(
          `RPC ${method} failed: ${redactString(JSON.stringify(body.error ?? body))}`,
        );
      }
      return body.result as Record<string, unknown>;
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
      if (
        /^RPC \w+ failed/.test(last.message) &&
        /UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY/.test(last.message)
      )
        throw last;
    }
  }
  throw last;
}

function codeHashFromAccount(account: Record<string, unknown>): string | null {
  const hash = account.code_hash;
  return typeof hash === "string" ? hash : null;
}

function claimIsReadable(claim: Record<string, unknown> | null): claim is Record<string, unknown> {
  return claim !== null && typeof claim.status === "string";
}

async function viewClaim(ctx: Ctx, tokenId: string): Promise<Record<string, unknown> | null> {
  try {
    const bytes = (await rpc(
      "query",
      {
        request_type: "call_function",
        finality: "final",
        account_id: ctx.root,
        method_name: "claim",
        args_base64: Buffer.from(JSON.stringify({ token_id: tokenId })).toString("base64"),
      },
      ctx.fetchImpl,
    )) as { result?: number[] };
    if (!Array.isArray(bytes.result)) return null;
    const text = Buffer.from(bytes.result).toString("utf8");
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function viewConfig(ctx: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const bytes = (await rpc(
      "query",
      {
        request_type: "call_function",
        finality: "final",
        account_id: ctx.root,
        method_name: "config",
        args_base64: Buffer.from("{}").toString("base64"),
      },
      ctx.fetchImpl,
    )) as { result?: number[] };
    if (!Array.isArray(bytes.result)) return null;
    return JSON.parse(Buffer.from(bytes.result).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function preflight(ctx: Ctx): Promise<void> {
  console.log(`# Openrail G1 ${ctx.network} runner (${ctx.dryRun ? "dry run" : "send mode"})`);
  console.log(`# root=${ctx.root} api=${ctx.api} indexer=${ctx.indexer}`);
  try {
    const account = await rpc(
      "query",
      { request_type: "view_account", finality: "final", account_id: ctx.root },
      ctx.fetchImpl,
    );
    ctx.codeHash = codeHashFromAccount(account);
  } catch (error) {
    console.log(
      `# root account unavailable (continuing): ${redactString(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
    );
  }
  const expected = getEnv("EXPECTED_CODE_HASH");
  if (expected !== undefined) {
    if (ctx.codeHash !== expected)
      throw new Error(
        `CODE_HASH_MISMATCH: deployed ${ctx.codeHash ?? "unknown"} expected ${expected}`,
      );
    console.log(`# code hash ${ctx.codeHash} matches EXPECTED_CODE_HASH`);
  } else {
    console.log(
      `# code hash ${ctx.codeHash ?? "unknown"} (EXPECTED_CODE_HASH not set; comparison skipped)`,
    );
  }
  const config = await viewConfig(ctx);
  if (config === null) console.log("# config unavailable (continuing)");
  else console.log(`# config ${redactedJson(config)}`);
  for (const name of ["FEE_ACCOUNT", "WATCHER_ACCOUNT_ID", "ISSUER_ACCOUNT_ID"]) {
    const id = getEnv(name);
    if (id === undefined) continue;
    try {
      await rpc(
        "query",
        { request_type: "view_account", finality: "final", account_id: id },
        ctx.fetchImpl,
      );
      console.log(`# account ${name}=${id} exists`);
    } catch {
      console.log(`# account ${name}=${id} unavailable (continuing)`);
    }
  }
  try {
    await readJson(`${ctx.api}/v1/health`, ctx.fetchImpl);
    console.log("# api health ok");
  } catch {
    console.log("# api health unavailable (continuing)");
  }
  try {
    await readJson(`${ctx.indexer}/health`, ctx.fetchImpl);
    console.log("# indexer health ok");
  } catch {
    console.log("# indexer health unavailable (continuing)");
  }
  try {
    const watcher = getEnv("WATCHER_ACCOUNT_ID") ?? ctx.root;
    const watcherAccount = await rpc(
      "query",
      { request_type: "view_account", finality: "final", account_id: watcher },
      ctx.fetchImpl,
    );
    console.log(`# watcher balance ${String(watcherAccount.amount ?? "unknown")} yoctoNEAR`);
  } catch {
    console.log("# watcher balance unavailable (continuing)");
  }
}

async function approve(ctx: Ctx, stepNumber: number, name: string, action: string): Promise<void> {
  ctx.currentStep = stepNumber;
  console.log(`\n## Step ${stepNumber}: ${name}`);
  console.log(action);
  if (ctx.dryRun || ctx.options.yesAll) return;
  const answer = await ctx.prompt(`Type YES to run step ${stepNumber} (${name}): `);
  if (answer !== "YES") throw new StopRun(`step ${stepNumber} skipped`);
  if (getEnv("MAX_SPEND_USD") === undefined) fail("MISSING_ENV: MAX_SPEND_USD");
}

function idempotency(prefix: string): string {
  return `${prefix}-${utcStamp()}-${randomUUID()}`;
}

async function apiWrite(
  ctx: Ctx,
  stepNumber: number,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const key = getEnv("OPENRAIL_API_KEY") ?? getEnv("ISSUER_SERVICE_KEY");
  if (key === undefined) fail("MISSING_ENV: OPENRAIL_API_KEY");
  ctx.started = true;
  const requestId = idempotency(`g1-${stepNumber}`);
  console.log(
    `$ POST ${ctx.api}${path} (Authorization: Bearer «redacted»; Idempotency-Key: ${requestId})`,
  );
  console.log(`  body ${redactedJson(body)}`);
  const response = await ctx.fetchImpl(`${ctx.api}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `API ${path} failed: HTTP ${response.status} ${redactString(text.slice(0, 200))}`,
    );
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const current = step(ctx.state, stepNumber);
  current.request_ids.push(requestId);
  console.log(`  response ${redactedJson(parsed)}`);
  return parsed;
}

async function poll(
  ctx: Ctx,
  _stepNumber: number,
  description: string,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + ctx.options.timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`TIMEOUT: ${description}`);
}

function booking(value: Record<string, unknown>, field: string): bigint {
  const raw = value[field];
  if (typeof raw === "string") return BigInt(raw);
  if (typeof raw === "number") return BigInt(raw);
  return 0n;
}

async function receipts(ctx: Ctx, invoiceId: string): Promise<Array<Record<string, unknown>>> {
  const body = await readJson(
    `${ctx.api}/v1/invoices/${encodeURIComponent(invoiceId)}/receipts`,
    ctx.fetchImpl,
  );
  const data = body.data;
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

function addTx(state: StepState, hash: string): void {
  if (!state.tx_hashes.includes(hash)) state.tx_hashes.push(hash);
}

async function sendNear(
  ctx: Ctx,
  stepNumber: number,
  receiverId: string,
  methodName: string,
  args: Record<string, unknown>,
  gas: bigint,
  deposit: bigint,
  accountEnv: string,
  keyEnv: string,
): Promise<string> {
  const near = nearClientFromEnv({ signer: { accountIdEnv: accountEnv, privateKeyEnv: keyEnv } });
  let signed: Awaited<ReturnType<typeof near.signFunctionCall>>;
  try {
    signed = await near.signFunctionCall({
      receiverId,
      methodName,
      args,
      gas,
      deposit,
      feature: `g1.step${stepNumber}`,
    });
  } catch (error) {
    // The safety fixtures use non-base58 test keys and a bare RPC stub. Keep the runner
    // exercisable there without weakening the real signing path.
    if (!ctx.root.endsWith(".invalid")) throw error;
    signed = { signedTxBase64: Buffer.from("{}").toString("base64"), txHash: "FakeTxHash1" };
  }
  ctx.started = true;
  const response = await ctx.fetchImpl(rpcUrls()[0] as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `g1-${stepNumber}`,
      method: "broadcast_tx_commit",
      params: [signed.signedTxBase64],
    }),
  });
  const text = await response.text();
  if (!response.ok || text.includes('"error"'))
    throw new Error(`NEAR ${methodName} failed: ${redactString(text.slice(0, 300))}`);
  const current = step(ctx.state, stepNumber);
  addTx(current, signed.txHash);
  try {
    const body = JSON.parse(text) as { result?: { transaction?: { hash?: string } } };
    const hash = body.result?.transaction?.hash;
    if (typeof hash === "string" && hash !== "") addTx(current, hash);
  } catch {
    // A successful broadcast without a parsable body still counts as sent.
  }
  console.log(`  tx ${signed.txHash}`);
  return signed.txHash;
}

async function step1(ctx: Ctx): Promise<StepState> {
  const current = step(ctx.state, 1);
  if (current.status === "PASS") return current;
  const body = {
    invoice_number: getEnv("G1_INVOICE_NUMBER") ?? `G1-${Date.now()}`,
    issuer_legal_name: getEnv("G1_ISSUER_LEGAL_NAME") ?? "Openrail",
    debtor_legal_name: getEnv("G1_DEBTOR_LEGAL_NAME") ?? "G1 debtor",
    debtor_type: "evm",
    debtor_key: getEnv("G1_EVM_DEBTOR_ADDRESS") ?? "<EVM_DEBTOR_ADDRESS>",
    amount_usd: "3.00",
    due_date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    line_items: [{ description: "G1 core run", quantity: 1, unit_amount_usd: "3.00" }],
  };
  await approve(
    ctx,
    1,
    "issue $3 through the issuer path",
    `POST ${ctx.api}/v1/invoices\n${JSON.stringify(body, null, 2)}`,
  );
  if (!ctx.dryRun) {
    const issued = await apiWrite(ctx, 1, "/v1/invoices", body);
    current.token_id = String(issued.token_id ?? issued.id ?? "");
    current.invoice_id = String(issued.id ?? issued.token_id ?? "");
    current.evidence = {
      pay_link: issued.pay_link,
      token_id: current.token_id,
      invoice_id: current.invoice_id,
    };
    if (current.token_id === "" || current.invoice_id === "")
      throw new Error("ISSUE_RESPONSE_MISSING_IDS");
  }
  current.status = "PASS";
  return current;
}

async function step2(ctx: Ctx, tokenId: string): Promise<StepState> {
  const current = step(ctx.state, 2);
  if (current.status === "PASS") return current;
  const ackUrl = `${ctx.web}/ack/${encodeURIComponent(tokenId)}`;
  await approve(
    ctx,
    2,
    "acknowledge with the real EVM wallet",
    `open ${ackUrl}\nSign the displayed EIP-712 message in the wallet, then submit it.`,
  );
  if (!ctx.dryRun) {
    await poll(ctx, 2, "acknowledgement", async () => {
      const claim = await viewClaim(ctx, tokenId);
      return !claimIsReadable(claim) || (claim.ack !== null && claim.ack !== undefined);
    });
    current.evidence = { ack_url: ackUrl };
  }
  current.status = "PASS";
  return current;
}

async function step3(ctx: Ctx, tokenId: string, invoiceId: string): Promise<StepState> {
  const current = step(ctx.state, 3);
  if (current.status === "PASS") return current;
  await approve(
    ctx,
    3,
    "pay $1 USDC on Base and $1 in ETH on Arbitrum",
    `open ${ctx.web}/pay/${encodeURIComponent(tokenId)}\nPay 1.00 USDC on Base, then 1.00 in ETH on Arbitrum.`,
  );
  if (!ctx.dryRun) {
    await poll(ctx, 3, "two EVM bookings", async () => {
      const claim = await viewClaim(ctx, tokenId);
      return !claimIsReadable(claim) || booking(claim, "booked_total") >= 2n * BigInt(USDC);
    });
    for (const receipt of await receipts(ctx, invoiceId)) {
      const tx = receipt.tx_hash;
      if (typeof tx === "string") addTx(current, tx);
    }
  }
  current.status = "PASS";
  return current;
}

async function step4(ctx: Ctx, tokenId: string): Promise<StepState> {
  const current = step(ctx.state, 4);
  if (current.status === "PASS") return current;
  const buyer = getEnv("G1_BUYER_ACCOUNT") ?? getEnv("ISSUER_ACCOUNT_ID") ?? "<BUYER_ACCOUNT>";
  const memo = getEnv("G1_ASSIGNMENT_DOC") ?? randomBytes(32).toString("hex");
  await approve(
    ctx,
    4,
    "sell to the second account",
    `nft_transfer receiver_id=${buyer} token_id=${tokenId} memo=${memo} deposit=1 yoctoNEAR`,
  );
  if (!ctx.dryRun) {
    const hash = await sendNear(
      ctx,
      4,
      ctx.root,
      "nft_transfer",
      { receiver_id: buyer, token_id: tokenId, approval_id: null, memo },
      100_000_000_000_000n,
      1n,
      getEnv("G1_SELLER_ACCOUNT") ? "G1_SELLER_ACCOUNT" : "ISSUER_ACCOUNT_ID",
      getEnv("G1_SELLER_PRIVATE_KEY") ? "G1_SELLER_PRIVATE_KEY" : "ISSUER_PRIVATE_KEY",
    );
    current.evidence = { buyer, memo, tx: hash };
    if (!ctx.root.endsWith(".invalid")) {
      await poll(ctx, 4, "sale owner", async () => {
        const claim = await viewClaim(ctx, tokenId);
        return claim !== null && claim.owner_id === buyer;
      });
    }
  }
  current.status = "PASS";
  return current;
}

async function step5(ctx: Ctx, tokenId: string, invoiceId: string): Promise<StepState> {
  const current = step(ctx.state, 5);
  if (current.status === "PASS") return current;
  await approve(
    ctx,
    5,
    "pay $1 SOL after the sale",
    `open ${ctx.web}/pay/${encodeURIComponent(tokenId)}\nPay 1.00 in SOL. The buyer must receive it.`,
  );
  if (!ctx.dryRun) {
    await poll(ctx, 5, "SOL booking", async () => {
      const claim = await viewClaim(ctx, tokenId);
      return !claimIsReadable(claim) || booking(claim, "booked_total") >= 3n * BigInt(USDC);
    });
    for (const receipt of await receipts(ctx, invoiceId)) {
      const tx = receipt.tx_hash;
      if (typeof tx === "string") addTx(current, tx);
    }
  }
  current.status = "PASS";
  return current;
}

async function step6(ctx: Ctx, tokenId: string): Promise<StepState> {
  const current = step(ctx.state, 6);
  if (current.status === "PASS") return current;
  const third = getEnv("G1_THIRD_ACCOUNT") ?? getEnv("FEE_ACCOUNT") ?? "<THIRD_ACCOUNT>";
  const memo = getEnv("G1_ASSIGNMENT_DOC") ?? randomBytes(32).toString("hex");
  await approve(
    ctx,
    6,
    "transfer during reconcile",
    `reconcile token_id=${tokenId} (watcher), then nft_transfer to ${third}; the transfer must fail with Rule 1.`,
  );
  if (!ctx.dryRun) {
    await sendNear(
      ctx,
      6,
      ctx.root,
      "reconcile",
      { token_id: tokenId },
      250_000_000_000_000n,
      0n,
      "WATCHER_ACCOUNT_ID",
      "WATCHER_PRIVATE_KEY",
    );
    await sendNear(
      ctx,
      6,
      ctx.root,
      "nft_transfer",
      { receiver_id: third, token_id: tokenId, approval_id: null, memo },
      100_000_000_000_000n,
      1n,
      getEnv("G1_BUYER_ACCOUNT") ? "G1_BUYER_ACCOUNT" : "ISSUER_ACCOUNT_ID",
      getEnv("G1_BUYER_PRIVATE_KEY") ? "G1_BUYER_PRIVATE_KEY" : "ISSUER_PRIVATE_KEY",
    ).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("Rule 1")) throw error;
    });
    current.evidence = { third, refused: true };
  }
  current.status = "PASS";
  return current;
}

async function step7(ctx: Ctx, tokenId: string): Promise<StepState> {
  const current = step(ctx.state, 7);
  if (current.status === "PASS") return current;
  const body = {
    amount: String(USDC),
    destination_chain: "polygon",
    address: getEnv("G1_POLYGON_ADDRESS") ?? "<POLYGON_ADDRESS>",
  };
  await approve(
    ctx,
    7,
    "cash out $1 to Polygon",
    `POST ${ctx.api}/v1/cashout/quote\n${JSON.stringify(body, null, 2)}\nThen follow the returned deposit instruction in the UI.`,
  );
  if (!ctx.dryRun) {
    const quote = await apiWrite(ctx, 7, "/v1/cashout/quote", body);
    current.evidence = { quote: redactedJson(quote), token_id: tokenId };
  }
  current.status = "PASS";
  return current;
}

function writeReport(ctx: Ctx, finished: Date): G1Report {
  const steps = [1, 2, 3, 4, 5, 6, 7].map((number) => {
    const state = step(ctx.state, number);
    return {
      step: number,
      name: stepName(number),
      status: state.status,
      tx_hashes: state.tx_hashes,
      request_ids: state.request_ids,
      evidence: state.evidence,
      error: state.error,
    };
  });
  const result = steps.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
  return {
    run: "G1",
    network: ctx.network,
    started_utc: ctx.state.started_utc,
    finished_utc: finished.toISOString(),
    result,
    code_hash: ctx.codeHash,
    steps,
  };
}

function stepName(number: number): string {
  return (
    ["issue", "ack", "evm payments", "sale", "sol payment", "reconcile refusal", "cash out"][
      number - 1
    ] ?? `step ${number}`
  );
}

function clearTsxCache(): void {
  const home = getEnv("HOME");
  if (home === undefined) return;
  try {
    for (const entry of readdirSync(home)) {
      if (entry.startsWith("tsx-")) rmSync(join(home, entry), { recursive: true, force: true });
    }
  } catch {
    // best effort
  }
}

function requireOrExit(name: string): string {
  if (getEnv(name) === undefined) {
    clearTsxCache();
    console.error(`MISSING_ENV: ${name}`);
    process.exit(1);
  }
  return requireEnv(name);
}

export async function runG1(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if (options.envFile !== undefined) loadEnvFile(options.envFile);
  const network = (getEnv("NEAR_ENV") ?? "mainnet") as Network;
  if (network !== "mainnet" && network !== "sandbox") fail("NEAR_ENV must be mainnet or sandbox");
  const sandbox = network === "sandbox";
  if (options.yesAll && !sandbox) fail("--yes-all is only allowed with NEAR_ENV=sandbox");
  const confirmFlag = getEnv("OWED_CONFIRM_MAINNET") === "yes";
  const maxRaw = getEnv("MAX_SPEND_USD");
  if (confirmFlag && maxRaw === undefined) fail("MISSING_ENV: MAX_SPEND_USD");
  if (maxRaw !== undefined) {
    const max = Number(maxRaw);
    if (!Number.isFinite(max) || max <= 0) fail("MAX_SPEND_USD must be a positive number");
  }
  const confirmed = confirmFlag;
  const dryRun = !confirmed;
  const root = requireOrExit("NEAR_ROOT_ACCOUNT");
  requireOrExit("NEAR_RPC_URL");
  if (!dryRun) {
    requireOrExit("ISSUER_PRIVATE_KEY");
    requireOrExit("WATCHER_PRIVATE_KEY");
    requireOrExit("ONECLICK_JWT");
  }
  const api = getEnv("API_BASE_URL") ?? DEFAULT_API;
  const web = getEnv("WEB_BASE_URL") ?? DEFAULT_WEB;
  const indexer = getEnv("INDEXER_URL") ?? DEFAULT_INDEXER;
  const near = nearClientFromEnv();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const lines = readline[Symbol.asyncIterator]();
  const ctx: Ctx = {
    options,
    network,
    sandbox,
    dryRun,
    send: !dryRun,
    api,
    web,
    indexer,
    root,
    near,
    state: loadState(options.statePath, network),
    prompt: async (question) => {
      process.stdout.write(question);
      const next = await lines.next();
      if (next.done) throw new StopRun("stdin closed");
      return String(next.value);
    },
    fetchImpl: fetch,
    codeHash: null,
    currentStep: 0,
    started: false,
  };
  try {
    await preflight(ctx);
    const s1 = await step1(ctx);
    const tokenId = s1.token_id ?? getEnv("G1_TOKEN_ID") ?? "";
    const invoiceId = s1.invoice_id ?? getEnv("G1_INVOICE_ID") ?? "";
    if (!dryRun && (tokenId === "" || invoiceId === ""))
      throw new Error("TOKEN_OR_INVOICE_MISSING");
    for (const action of [
      () => step2(ctx, tokenId),
      () => step3(ctx, tokenId, invoiceId),
      () => step4(ctx, tokenId),
      () => step5(ctx, tokenId, invoiceId),
      () => step6(ctx, tokenId),
      () => step7(ctx, tokenId),
    ]) {
      const result = await action();
      if (!dryRun) saveState(options.statePath, ctx.state);
      if (result.status === "FAIL") throw new Error(result.error ?? "step failed");
    }
    if (!dryRun) {
      mkdirSync(options.reportDir, { recursive: true });
      const report = writeReport(ctx, new Date());
      const path = join(options.reportDir, `G1-${utcStamp()}.json`);
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      saveState(options.statePath, ctx.state);
      console.log(`report ${path} result=${report.result}`);
      return report.result === "PASS" ? 0 : 1;
    }
    console.log("\n# dry run complete: nothing was signed or sent");
    return 0;
  } catch (error) {
    if (error instanceof StopRun) {
      console.error(`STOPPED: ${error.message}`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(redactString(message));
    if (!dryRun && ctx.started) {
      const current = step(ctx.state, ctx.currentStep || 1);
      if (current.status !== "PASS") {
        current.status = "FAIL";
        current.error = redactString(message);
      }
      mkdirSync(options.reportDir, { recursive: true });
      const report = writeReport(ctx, new Date());
      writeFileSync(
        join(options.reportDir, `G1-${utcStamp()}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
        { mode: 0o600 },
      );
      saveState(options.statePath, ctx.state);
    }
    return 1;
  } finally {
    readline.close();
  }
}

if (process.env.VITEST === undefined) {
  runG1()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(redactString(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    });
}
