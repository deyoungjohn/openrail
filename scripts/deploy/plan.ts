/**
 * Prints the human-run mainnet deploy plan. It never signs or sends a transaction.
 *
 * The script reads only public values: account IDs, public keys and the wasm path.
 * Private keys are never read or printed.
 *
 * It also writes a review file (deploy-plans/deploy-plan-<UTC>.md) with the checks a human should read
 * before running any command: git state, wasm identity, what is on chain now, balances and accounts.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ROOT = "openrail.near";
const DEFAULT_FEE = "fees.openrail.near";
const DEFAULT_VAULT = "HXX9ic98ura2nYQqGxgpT1BMiUgWNogMWZEq5UbejU5r";
const DEFAULT_WATCHER_ALLOWANCE = "1 NEAR";
const DEFAULT_ISSUER_ALLOWANCE = "1 NEAR";
const DEFAULT_RELAYER_ALLOWANCE = "0.5 NEAR";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

type Routes = { settlementAssets: string[] };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readRoutes(): Routes {
  const path = join(ROOT, "config/routes.json");
  if (!existsSync(path)) fail(`missing routes file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as Routes;
}

function requiredEnv(names: string[]): void {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    for (const name of missing) console.error(`MISSING_ENV: ${name}`);
    process.exit(1);
  }
}

function decodeBase58(value: string): Uint8Array {
  let n = 0n;
  for (const char of value) {
    const digit = B58.indexOf(char);
    if (digit < 0) fail(`invalid base58 value: ${value}`);
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = n * 256n + BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function shellJson(value: unknown): string {
  return `'${JSON.stringify(value)}'`;
}

function featureListFromManifest(): string {
  const path = join(ROOT, "contracts/openrail/Cargo.toml");
  const text = readFileSync(path, "utf8");
  const block = /container_build_command\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? "";
  const match = /"([^"]*standing[^"]*)"/.exec(block);
  return match?.[1] ?? "";
}

function enabledFeatures(): string {
  const path = join(ROOT, "openrail.modules.json");
  const modules = JSON.parse(readFileSync(path, "utf8")) as {
    modules: { id: string; enabled: boolean }[];
  };
  return modules.modules
    .filter((m) => m.enabled)
    .map((m) => m.id)
    .join(",");
}

const routes = readRoutes();
requiredEnv([
  "WATCHER_PUBLIC_KEY",
  "ISSUER_PUBLIC_KEY",
  "RELAYER_PUBLIC_KEY",
  "RELAYER_ACCOUNT_ID",
]);

const root = process.env.NEAR_ROOT_ACCOUNT?.trim() || DEFAULT_ROOT;
const fee = process.env.FEE_ACCOUNT?.trim() || DEFAULT_FEE;
const network = process.env.NEAR_ENV?.trim() || "mainnet";
function nearAmount(name: string, fallback: string): string {
  const raw = process.env[name]?.trim() || fallback;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(?:NEAR)?$/i.exec(raw);
  if (!match) fail(`${name} must be a NEAR amount such as "1" or "0.5 NEAR"`);
  return `${match[1]} NEAR`;
}

const watcherAllowance = nearAmount("WATCHER_KEY_ALLOWANCE_NEAR", DEFAULT_WATCHER_ALLOWANCE);
const issuerAllowance = nearAmount("ISSUER_KEY_ALLOWANCE_NEAR", DEFAULT_ISSUER_ALLOWANCE);
const relayerAllowance = nearAmount("RELAYER_KEY_ALLOWANCE_NEAR", DEFAULT_RELAYER_ALLOWANCE);
const balanceRaw = process.env.ACCOUNT_BALANCE_NEAR?.trim();
if (balanceRaw) {
  const balance = Number(balanceRaw.replace(/\s*NEAR$/i, ""));
  if (!Number.isFinite(balance) || balance <= 0)
    fail("ACCOUNT_BALANCE_NEAR must be a positive number");
  for (const [name, allowance] of [
    ["WATCHER_KEY_ALLOWANCE_NEAR", watcherAllowance],
    ["ISSUER_KEY_ALLOWANCE_NEAR", issuerAllowance],
    ["RELAYER_KEY_ALLOWANCE_NEAR", relayerAllowance],
  ] as const) {
    if (Number(allowance.split(" ")[0]) > balance) {
      fail(`${name} (${allowance}) exceeds ACCOUNT_BALANCE_NEAR (${balanceRaw})`);
    }
  }
}
const wasmRel = "target/near/openrail/openrail.wasm";
const wasmPath = join(ROOT, wasmRel);
const vaultBase58 = process.env.VAULT_GLOBAL_HASH?.trim() || DEFAULT_VAULT;
const vaultBytes = decodeBase58(vaultBase58);
if (vaultBytes.length !== 32)
  fail(`VAULT_GLOBAL_HASH must decode to 32 bytes (got ${vaultBytes.length})`);

const watcherAccount = process.env.WATCHER_ACCOUNT_ID?.trim() ?? "";
const issuerAccount = process.env.ISSUER_ACCOUNT_ID?.trim() ?? "";
const watchers = splitList(process.env.WATCHERS || watcherAccount);
const issuers = splitList(process.env.ISSUERS || issuerAccount);
const quoteWriters = splitList(process.env.QUOTE_WRITERS || issuerAccount);
if (!watchers.length) fail("MISSING_ENV: WATCHERS or WATCHER_ACCOUNT_ID");
if (!issuers.length) fail("MISSING_ENV: ISSUERS or ISSUER_ACCOUNT_ID");
if (!quoteWriters.length) fail("MISSING_ENV: QUOTE_WRITERS or ISSUER_ACCOUNT_ID");
if (!["mainnet", "testnet"].includes(network)) fail(`NEAR_ENV must be mainnet or testnet`);

const enabled = enabledFeatures();
const manifestFeatures = featureListFromManifest();
if (enabled !== manifestFeatures) {
  fail(
    `reproducible build features differ: openrail.modules.json=${enabled || "(none)"} ` +
      `contracts/openrail/Cargo.toml=${manifestFeatures || "(none)"}. Update container_build_command.`,
  );
}

if (!existsSync(wasmPath)) {
  fail(`missing ${wasmPath}; run scripts/deploy/plan.sh (it builds first)`);
}
const wasm = readFileSync(wasmPath);
const codeHashHex = createHash("sha256").update(wasm).digest();
const codeHashBase58 = encodeBase58(codeHashHex);

const config = {
  settlement_assets: [...new Set(routes.settlementAssets)],
  vault_code_hash: `0x${hex(vaultBytes)}`,
  fee_account: fee,
  watchers,
  quote_writers: quoteWriters,
  issuers,
  issue_paused: false,
};

const nearNetwork = `network-config ${network} sign-with-keychain send`;
// The deploy only runs if the file on disk still has the hash this plan was made from.
const hashGuard = `echo '${hex(codeHashHex)}  ${wasmRel}' | sha256sum -c -`;
const deploy = [
  `${hashGuard} && near contract deploy ${root} use-file ${wasmRel}`,
  `with-init-call new json-args ${shellJson({ config })}`,
  `prepaid-gas '300 Tgas' attached-deposit '0 NEAR' ${nearNetwork}`,
].join(" ");

const setConfig = [
  `near contract call-function as-transaction ${root} set_config`,
  `json-args ${shellJson(config)}`,
  `prepaid-gas '100 Tgas' attached-deposit '0 NEAR'`,
  `sign-as ${root} ${nearNetwork}`,
].join(" ");

function addKey(
  account: string,
  publicKey: string,
  functions: string,
  allowance: string,
  label: string,
): string {
  return [
    `# ${label}`,
    [
      `near account add-key ${account} grant-function-call-access`,
      `--allowance '${allowance}' --contract-account-id ${root}`,
      `--function-names '${functions}'`,
      `use-manually-provided-public-key ${publicKey} ${nearNetwork}`,
    ].join(" "),
  ].join("\n");
}

const planLines: string[] = [];
const emit = (line = ""): void => {
  planLines.push(line);
};

emit(`# Openrail deploy plan (${network})`);
emit(`# Read-only: this script did not sign or send anything.`);
emit(`# wasm: ${wasmRel} (from the repository root)`);
emit(`# size: ${wasm.length} bytes`);
emit(`# code hash (hex):    ${hex(codeHashHex)}`);
emit(`# code hash (base58): ${codeHashBase58}`);
emit(`# vault code hash:    ${vaultBase58} (${hex(vaultBytes)})`);
emit(`# enabled features:   ${enabled}`);
emit("");
emit("## 1. Deploy and initialize");
emit(deploy);
emit("");
emit("## 2. Apply configuration to an existing deployment");
emit(setConfig);
emit("");
emit("## 3. Restricted function-call keys (public keys only)");
emit(
  addKey(
    watcherAccount || watchers[0]!,
    process.env.WATCHER_PUBLIC_KEY!,
    "reconcile,retry_distribution,clear_stale_lock",
    watcherAllowance,
    "watcher",
  ),
);
emit(
  addKey(
    issuerAccount || issuers[0]!,
    process.env.ISSUER_PUBLIC_KEY!,
    "issue_for,log_quote",
    issuerAllowance,
    "issuer",
  ),
);
emit(
  addKey(
    process.env.RELAYER_ACCOUNT_ID!,
    process.env.RELAYER_PUBLIC_KEY!,
    "acknowledge_evm",
    relayerAllowance,
    "relayer",
  ),
);
emit("");
emit("## 4. Verify after the human runs the commands");
emit(
  `near contract call-function as-read-only ${root} config json-args '{}' network-config ${network} now`,
);
emit(
  `near contract call-function as-read-only ${root} contract_source_metadata json-args '{}' network-config ${network} now`,
);

// ---------------------------------------------------------------------------------------------
// Review file. Every check is PASS, WARN (could not verify, or worth a look) or FAIL (do not deploy).
// Chain reads are public, read-only RPC calls. A failed read is a WARN, never a PASS.
// ---------------------------------------------------------------------------------------------
type Level = "PASS" | "WARN" | "FAIL";
const checks: { level: Level; name: string; detail: string }[] = [];
const check = (level: Level, name: string, detail: string): void => {
  checks.push({ level, name, detail });
};

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const rpcUrl =
  process.env.NEAR_RPC_URL?.trim() ||
  (network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org");
const YOCTO = 10n ** 24n;
const BYTE_COST = 10n ** 19n;
const nearOf = (yocto: bigint): string => (Number((yocto * 10000n) / YOCTO) / 10000).toFixed(4);

async function rpc(method: string, params: unknown): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "plan", method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as {
    result?: unknown;
    error?: { cause?: { name?: string }; data?: unknown };
  };
  if (body.error) {
    const name = body.error.cause?.name ?? JSON.stringify(body.error.data ?? body.error);
    throw new Error(String(name));
  }
  return body.result;
}

type Account = { amount: string; locked: string; code_hash: string; storage_usage: number };
async function viewAccount(id: string): Promise<Account | "missing" | "unreachable"> {
  try {
    return (await rpc("query", {
      request_type: "view_account",
      finality: "final",
      account_id: id,
    })) as Account;
  } catch (e) {
    return (e as Error).message.includes("UNKNOWN_ACCOUNT") ? "missing" : "unreachable";
  }
}

// 1. git state: the wasm must come from a clean tree at a commit that is on origin/main.
const head = git("rev-parse", "HEAD");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const dirty = git("status", "--porcelain");
check(
  dirty ? "FAIL" : "PASS",
  "git tree clean",
  dirty ? `uncommitted changes:\n${dirty}` : `HEAD ${head.slice(0, 12)} on ${branch}`,
);
const originMain = git("rev-parse", "origin/main");
if (!originMain) check("WARN", "HEAD is origin/main", "no origin/main ref; run git fetch");
else if (originMain === head) check("PASS", "HEAD is origin/main", head.slice(0, 12));
else
  check(
    "WARN",
    "HEAD is origin/main",
    `HEAD ${head.slice(0, 12)} differs from origin/main ${originMain.slice(0, 12)} (run git fetch && git pull; a reproducible build needs a pushed commit)`,
  );

// 2. wasm identity: it must be newer than the last commit that touched contract code.
const lastContractCommit = Number(
  git(
    "log",
    "-1",
    "--format=%ct",
    "--",
    "contracts/openrail",
    "contracts/vault",
    "Cargo.lock",
    "Cargo.toml",
  ) || "0",
);
const wasmMtime = Math.floor(statSync(wasmPath).mtimeMs / 1000);
check(
  wasmMtime >= lastContractCommit ? "PASS" : "FAIL",
  "wasm is newer than the last contract commit",
  `wasm built ${new Date(wasmMtime * 1000).toISOString()}; last contract commit ${new Date(lastContractCommit * 1000).toISOString()}`,
);
check(
  wasm.length > 50_000 && wasm.length < 1_500_000 ? "PASS" : "FAIL",
  "wasm size is plausible",
  `${wasm.length} bytes (the gate run measured about 400 KB)`,
);
check("PASS", "enabled features match the reproducible build command", enabled || "(none)");
try {
  const out = execFileSync("node", ["scripts/wasm-check.mjs", wasmRel], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  check(
    "PASS",
    "wasm import check (no gas_key or universal_state import)",
    out.replace(/\s+/g, " ").slice(0, 160),
  );
} catch (e) {
  check(
    "FAIL",
    "wasm import check (no gas_key or universal_state import)",
    String((e as Error).message).slice(0, 300),
  );
}

// 3. the chain today.
const rootAcc = await viewAccount(root);
const needStorage = BigInt(wasm.length) * BYTE_COST;
if (rootAcc === "unreachable") {
  check(
    "WARN",
    `${root} on chain`,
    `could not read ${rpcUrl}; verify with: near account view-account-summary ${root} network-config ${network} now`,
  );
} else if (rootAcc === "missing") {
  check("FAIL", `${root} on chain`, "account does not exist");
} else {
  const hasCode = rootAcc.code_hash !== "11111111111111111111111111111111";
  const sameCode = rootAcc.code_hash === codeHashBase58;
  check(
    !hasCode ? "PASS" : sameCode ? "WARN" : "WARN",
    `${root} current contract`,
    !hasCode
      ? "no contract deployed yet: this is a first deploy"
      : sameCode
        ? `already runs this exact code (${rootAcc.code_hash}); deploying again changes nothing`
        : `ALREADY HAS A CONTRACT (code hash ${rootAcc.code_hash}). Deploying will REPLACE it. Only do this if you mean to (AGENTS rule 9).`,
  );
  const free = BigInt(rootAcc.amount) - BigInt(rootAcc.storage_usage) * BYTE_COST;
  const extra = hasCode ? 0n : needStorage; // a first deploy locks the code size in storage
  const margin = (5n * YOCTO) / 10n;
  check(
    free >= extra + margin ? "PASS" : "FAIL",
    `${root} balance covers the deploy`,
    `balance ${nearOf(BigInt(rootAcc.amount))} NEAR, free after current storage ${nearOf(free)} NEAR, code storage needed ${nearOf(extra)} NEAR, margin 0.5 NEAR`,
  );
}

// 4. the vault code the contract will clone must exist on chain as a global contract.
try {
  const res = (await rpc("query", {
    request_type: "view_global_contract_code",
    finality: "final",
    code_hash: vaultBase58,
  })) as { code_base64: string };
  const code = Buffer.from(res.code_base64, "base64");
  const actual = encodeBase58(createHash("sha256").update(code).digest());
  check(
    actual === vaultBase58 ? "PASS" : "FAIL",
    "vault global contract exists on chain",
    `${vaultBase58}, ${code.length} bytes on chain (the vault published on 2 Nov is 7,361 bytes), sha256 of the returned code ${actual === vaultBase58 ? "matches" : "DOES NOT MATCH"}`,
  );
} catch (e) {
  const msg = (e as Error).message;
  check(
    msg.includes("NO_GLOBAL_CONTRACT_CODE") ? "FAIL" : "WARN",
    "vault global contract exists on chain",
    msg.includes("NO_GLOBAL_CONTRACT_CODE")
      ? `no global contract with hash ${vaultBase58}: every claim account would fail to be created`
      : `could not confirm (${msg}); confirm yourself before deploying`,
  );
}

// 5. the other accounts named in the plan.
const roles: [string, string, string?][] = [
  ["fee account", fee],
  ...watchers.map((a): [string, string] => ["watcher account", a]),
  ...issuers.map((a): [string, string] => ["issuer account", a]),
  ["relayer account", process.env.RELAYER_ACCOUNT_ID!],
];
const allowanceOf: Record<string, bigint> = {};
const addAllowance = (acct: string, a: string): void => {
  allowanceOf[acct] =
    (allowanceOf[acct] ?? 0n) +
    BigInt(Math.round(Number(a.split(" ")[0]) * 1000)) * (YOCTO / 1000n);
};
addAllowance(watcherAccount || watchers[0]!, watcherAllowance);
addAllowance(issuerAccount || issuers[0]!, issuerAllowance);
addAllowance(process.env.RELAYER_ACCOUNT_ID!, relayerAllowance);
for (const [label, id] of roles) {
  const acc = await viewAccount(id);
  if (acc === "unreachable") check("WARN", `${label} ${id}`, "could not read the chain");
  else if (acc === "missing") check("FAIL", `${label} ${id}`, "account does not exist");
  else {
    const need = allowanceOf[id] ?? 0n;
    const bal = BigInt(acc.amount);
    check(
      need > 0n && bal < need ? "WARN" : "PASS",
      `${label} ${id}`,
      `balance ${nearOf(bal)} NEAR${need > 0n ? `; key allowances on it total ${nearOf(need)} NEAR` : ""}`,
    );
  }
}
const keys = [
  process.env.WATCHER_PUBLIC_KEY!,
  process.env.ISSUER_PUBLIC_KEY!,
  process.env.RELAYER_PUBLIC_KEY!,
];
check(
  keys.every((k) => /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(k)) && new Set(keys).size === 3
    ? "PASS"
    : "FAIL",
  "three distinct ed25519 public keys",
  keys.map((k) => k.slice(0, 16) + "...").join(", "),
);
check(
  new Set([root, fee, ...watchers, ...issuers]).size === 1 + 1 + watchers.length + issuers.length
    ? "PASS"
    : "WARN",
  "no role reuses the root or fee account",
  `root ${root}, fee ${fee}`,
);

// 6. write the file.
const fails = checks.filter((c) => c.level === "FAIL").length;
const warns = checks.filter((c) => c.level === "WARN").length;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(ROOT, "deploy-plans");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `deploy-plan-${stamp}.md`);
const verdict = fails
  ? `DO NOT DEPLOY: ${fails} failed check(s)`
  : warns
    ? `REVIEW: ${warns} warning(s), read each one`
    : "ALL CHECKS PASSED";
const file = [
  `# Openrail deploy review (${network}), ${new Date().toISOString()}`,
  "",
  `**Verdict: ${verdict}.** A passing verdict is not an approval; it only lists what this script could check. Read the file, then run the commands yourself.`,
  "",
  "## What will be deployed",
  "",
  `| | |`,
  `|---|---|`,
  `| target account | \`${root}\` (${network}) |`,
  `| git commit | \`${head}\` on \`${branch}\` |`,
  `| wasm | \`${wasmRel}\`, ${wasm.length} bytes |`,
  `| sha256 (hex) | \`${hex(codeHashHex)}\` |`,
  `| code hash (base58, what the chain shows) | \`${codeHashBase58}\` |`,
  `| vault global hash | \`${vaultBase58}\` |`,
  `| enabled modules | ${enabled || "(none)"} |`,
  `| settlement assets | ${config.settlement_assets.join(", ")} |`,
  `| fee account | \`${fee}\` |`,
  `| watchers / issuers / quote writers | ${watchers.join(", ")} / ${issuers.join(", ")} / ${quoteWriters.join(", ")} |`,
  "",
  "## Checks",
  "",
  ...checks.map((c) => `- **${c.level}** ${c.name}: ${c.detail}`),
  "",
  "## After the deploy",
  "",
  `The code hash the chain reports for \`${root}\` must be exactly \`${codeHashBase58}\`:`,
  "",
  "```bash",
  `near account view-account-summary ${root} network-config ${network} now`,
  "```",
  "",
  "## Commands (run from the repository root, in this order)",
  "",
  "```bash",
  ...planLines,
  "```",
  "",
].join("\n");
writeFileSync(outPath, file);

for (const line of planLines) console.log(line);
console.error("");
console.error(`REVIEW FILE: ${outPath}`);
console.error(`VERDICT: ${verdict}`);
if (fails) process.exit(2);
