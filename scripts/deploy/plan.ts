/**
 * Prints the human-run mainnet deploy plan. It never signs or sends a transaction.
 *
 * The script reads only public values: account IDs, public keys and the wasm path.
 * Private keys are never read or printed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ROOT = "openrail.near";
const DEFAULT_FEE = "fees.openrail.near";
const DEFAULT_VAULT = "HXX9ic98ura2nYQqGxgpT1BMiUgWNogMWZEq5UbejU5r";
const DEFAULT_ALLOWANCE = "0.25 NEAR";
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
const allowance = process.env.KEY_ALLOWANCE_NEAR?.trim() || DEFAULT_ALLOWANCE;
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
  vault_code_hash: hex(vaultBytes),
  fee_account: fee,
  watchers,
  quote_writers: quoteWriters,
  issuers,
  issue_paused: false,
};

const nearNetwork = `network-config ${network} sign-with-keychain send`;
const deploy = [
  `near contract deploy ${root} use-file ${wasmRel}`,
  `with-init-call new json-args ${shellJson(config)}`,
  `prepaid-gas '300 Tgas' attached-deposit '0 NEAR' ${nearNetwork}`,
].join(" ");

const setConfig = [
  `near contract call-function as-transaction ${root} set_config`,
  `json-args ${shellJson(config)}`,
  `prepaid-gas '100 Tgas' attached-deposit '0 NEAR'`,
  `sign-as ${root} ${nearNetwork}`,
].join(" ");

function addKey(account: string, publicKey: string, functions: string, label: string): string {
  return [
    `# ${label}`,
    `near account add-key ${account} grant-function-call-access`,
    `--allowance '${allowance}' --contract-account-id ${root}`,
    `--function-names '${functions}'`,
    `use-manually-provided-public-key ${publicKey} ${nearNetwork}`,
  ].join(" ");
}

console.log(`# Openrail deploy plan (${network})`);
console.log(`# Read-only: this script did not sign or send anything.`);
console.log(`# wasm: ${wasmRel} (from the repository root)`);
console.log(`# size: ${wasm.length} bytes`);
console.log(`# code hash (hex):    ${hex(codeHashHex)}`);
console.log(`# code hash (base58): ${codeHashBase58}`);
console.log(`# vault code hash:    ${vaultBase58} (${hex(vaultBytes)})`);
console.log(`# enabled features:   ${enabled}`);
console.log("");
console.log("## 1. Deploy and initialize");
console.log(deploy);
console.log("");
console.log("## 2. Apply configuration to an existing deployment");
console.log(setConfig);
console.log("");
console.log("## 3. Restricted function-call keys (public keys only)");
console.log(
  addKey(
    watcherAccount || watchers[0],
    process.env.WATCHER_PUBLIC_KEY!,
    "reconcile,retry_distribution,clear_stale_lock",
    "watcher",
  ),
);
console.log(
  addKey(
    issuerAccount || issuers[0],
    process.env.ISSUER_PUBLIC_KEY!,
    "issue_for,log_quote",
    "issuer",
  ),
);
console.log(
  addKey(
    process.env.RELAYER_ACCOUNT_ID!,
    process.env.RELAYER_PUBLIC_KEY!,
    "acknowledge_evm",
    "relayer",
  ),
);
console.log("");
console.log("## 4. Verify after the human runs the commands");
console.log(
  `near contract call-function as-read-only ${root} config json-args '{}' network-config ${network} now`,
);
console.log(
  `near contract call-function as-read-only ${root} contract_source_metadata json-args '{}' network-config ${network} now`,
);
