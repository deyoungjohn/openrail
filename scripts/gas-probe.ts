#!/usr/bin/env -S pnpm exec tsx
/**
 * P0.4H sign-gas probe: calls v1.signer::sign at 100, 150 and 250 Tgas and records the
 * minimum that works (blueprint §1.5 rule 3).
 *
 * Dry run by default: prints the exact commands, sends nothing.
 * To send:
 *   OWED_CONFIRM_MAINNET=yes MAX_SPEND_USD=<usd> NEAR_USD=<usd-per-near> \
 *     pnpm exec tsx scripts/gas-probe.ts --send
 * Sending additionally requires typing YES. The spend guard is self-contained until the
 * P0.5 shared libs (env/spend/report) land; it will be replaced, not extended.
 *
 * No secret is read, printed or logged. The signer key stays in the near-cli keychain
 * (`sign-with-keychain`). Gas and the 1-yocto deposit are the only value moved.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

const LEVELS_TGAS = [100, 150, 250] as const;
const SIGNER = "v1.signer";
const PATH = "evm-1";
const DOMAIN_ID = 0;

type Result = {
  gas_tgas: number;
  command: string[];
  exit_code: number | null;
  success: boolean;
  at: string;
  error?: string;
};

function missing(name: string): never {
  console.error(`MISSING_ENV: ${name}`);
  process.exit(2);
}

function numberEnv(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") missing(name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${name} must be a positive number`);
    process.exit(2);
  }
  return value;
}

function quote(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function shell(command: string[]): string {
  return command.map(quote).join(" ");
}

function jsonArgs(): string {
  const payload = createHash("sha256").update("openrail vault sign gas probe").digest("hex");
  return JSON.stringify({
    request: {
      payload_v2: { Ecdsa: payload },
      path: PATH,
      domain_id: DOMAIN_ID,
    },
  });
}

function commandFor(level: number, account: string, network: string): string[] {
  return [
    process.env.NEAR_CLI ?? "near",
    "contract",
    "call-function",
    "as-transaction",
    SIGNER,
    "sign",
    "json-args",
    jsonArgs(),
    "prepaid-gas",
    `${level} Tgas`,
    "attached-deposit",
    "1 yoctoNEAR",
    "sign-as",
    account,
    "network-config",
    network,
    "sign-with-keychain",
    "send",
  ];
}

async function gasPriceYoctoPerGas(rpcUrl: string): Promise<bigint> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "openrail-gas-probe",
      method: "gas_price",
      params: [null],
    }),
  });
  if (!response.ok) {
    throw new Error(`gas_price RPC failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    result?: { gas_price?: string };
    error?: unknown;
  };
  const price = body.result?.gas_price;
  if (!price) throw new Error(`gas_price RPC returned ${JSON.stringify(body)}`);
  return BigInt(price);
}

function reportPath(): string {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "Z");
  return resolve(`reports/gas-probe-${stamp}.json`);
}

async function main(): Promise<void> {
  const send = process.argv.includes("--send") && process.env.DRY_RUN !== "1";
  const account = process.env.PROBE_ACCOUNT_ID ?? process.env.NEAR_ROOT_ACCOUNT;
  if (!account) missing("NEAR_ROOT_ACCOUNT");
  const network = process.env.NEAR_ENV === "testnet" ? "testnet" : "mainnet";
  const rpcUrl =
    process.env.NEAR_RPC_URL ??
    (network === "testnet" ? "https://rpc.testnet.near.org" : "https://rpc.mainnet.near.org");

  const commands = LEVELS_TGAS.map((level) => commandFor(level, account!, network));

  if (!send) {
    console.log("DRY RUN: no transaction will be sent.");
    console.log(`network: ${network}   signer: ${account}`);
    for (const command of commands) console.log(`\n${shell(command)}`);
    console.log(
      [
        "\nTo send, re-run with:",
        "  OWED_CONFIRM_MAINNET=yes MAX_SPEND_USD=<usd> NEAR_USD=<usd-per-near> \\",
        "    pnpm exec tsx scripts/gas-probe.ts --send",
        "and type YES at the prompt.",
      ].join("\n"),
    );
    return;
  }

  if (process.env.OWED_CONFIRM_MAINNET !== "yes") {
    console.error("refusing to send: OWED_CONFIRM_MAINNET must be exactly yes");
    process.exit(2);
  }
  const maxSpendUsd = numberEnv("MAX_SPEND_USD");
  const nearUsd = numberEnv("NEAR_USD");

  const cli = process.env.NEAR_CLI ?? "near";
  const probe = spawnSync(cli, ["--version"], { encoding: "utf8" });
  if (probe.error) {
    console.error(`near CLI not found (${cli}); install near-cli-rs or set NEAR_CLI`);
    process.exit(2);
  }

  const gasPrice = await gasPriceYoctoPerGas(rpcUrl);
  const totalGas = LEVELS_TGAS.reduce((sum, level) => sum + level, 0) * 1_000_000_000_000;
  // Blueprint §1.5 rule 5: the account must hold about 10x the gas price as prepaid gas.
  const worstYocto = BigInt(totalGas) * gasPrice * 10n + 3n;
  const worstNear = Number(worstYocto) / 1e24;
  const worstUsd = worstNear * nearUsd;
  if (worstUsd > maxSpendUsd) {
    console.error(
      `refusing to send: worst case ${worstUsd.toFixed(6)} USD (${worstNear.toFixed(6)} NEAR ` +
        `at NEAR_USD=${nearUsd}) exceeds MAX_SPEND_USD=${maxSpendUsd}`,
    );
    process.exit(2);
  }
  console.log(`spend guard: worst case ${worstUsd.toFixed(6)} USD <= MAX_SPEND_USD=${maxSpendUsd}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `PROBE: send 3 mainnet transactions from ${account}? Type YES to continue: `,
  );
  rl.close();
  if (answer.trim() !== "YES") {
    console.error("aborted: YES was not typed");
    process.exit(2);
  }

  const results: Result[] = [];
  for (let i = 0; i < LEVELS_TGAS.length; i++) {
    const level = LEVELS_TGAS[i];
    const command = commands[i];
    console.log(`\n[${level} Tgas] ${shell(command)}`);
    const run = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
    const success = run.status === 0;
    results.push({
      gas_tgas: level,
      command,
      exit_code: run.status,
      success,
      at: new Date().toISOString(),
      ...(run.error ? { error: run.error.message } : {}),
    });
    console.log(`[${level} Tgas] ${success ? "SUCCESS" : "FAILED"}`);
  }

  const working = results
    .filter((result) => result.success)
    .map((result) => result.gas_tgas)
    .sort((a, b) => a - b);
  const minimum = working.length > 0 ? working[0] : null;
  const report = {
    run: "P0.4H-vault-sign-gas",
    at: new Date().toISOString(),
    network,
    signer: SIGNER,
    account,
    request: JSON.parse(jsonArgs()),
    levels_tgas: LEVELS_TGAS,
    results,
    minimum_working_tgas: minimum,
    rule: "minimum = smallest Tgas level whose transaction succeeded; null means none did",
  };
  const path = reportPath();
  mkdirSync(resolve("reports"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nminimum working gas: ${minimum === null ? "none" : `${minimum} Tgas`}`);
  console.log(`report: ${path}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
