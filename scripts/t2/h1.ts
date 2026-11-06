#!/usr/bin/env -S pnpm exec tsx
/**
 * Human-run mainnet runner for the two sets that follow G1.
 *
 *   pnpm t2:h1 --set rel1   read-only checks of the REL-1 upgrade (never writes, never moves value)
 *   pnpm t2:h1 --set h1     the adversarial set: late payment after a transfer, overpayment, short
 *                           deposit, expired quote, stray token, transfer during reconcile, two
 *                           payments in a row (blueprint 4.5, H1)
 *
 * It uses the same safety model as G1 (`g1.ts`): a dry run by default, writes only with
 * OWED_CONFIRM_MAINNET=yes and MAX_SPEND_USD, a typed YES before every step, secrets only from the
 * environment, a resumable state file, and a report whose result follows from the checks below.
 * The runner never pays: where money must move, it prints the address and the amount and waits
 * for the person to send it, then checks the outcome on chain and in the API.
 * Existing claims are reused where that is meaningful (c-1 to c-3 are all paid); three scenarios need
 * an unpaid invoice and issue one each (0.02 NEAR each, from the sponsor pool or the credit).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getEnv, nearClientFromEnv, redactString, utcStamp } from "@openrail/shared";
import {
  StopRun,
  apiWrite,
  approve,
  claimIsReadable,
  fail,
  loadEnvFile,
  loadState,
  parseArgs,
  preflight,
  readJson,
  requireOrExit,
  rpc,
  saveState,
  sendNear,
  step,
  viewClaim,
  type Ctx,
  type StepState,
} from "./g1.js";

type SetName = "rel1" | "h1";

interface StepDef {
  name: string;
  /** Dollars this step asks the person to send (0 when none). Counted against MAX_SPEND_USD. */
  usd: number;
  /** A step that reads only; it runs in a dry run too. */
  readOnly: boolean;
  run: (ctx: H1Ctx, state: StepState) => Promise<void>;
  /** A step that cannot run on mainnet; it names the test that covers it and never counts as passed. */
  sandboxOnly?: string;
}

interface H1Ctx extends Ctx {
  set: SetName;
  business: string;
  /** Invoice issued by this run, kept between steps (also recovered from the state file). */
  tokens: Record<string, string>;
}

const USDC = 1_000_000n;
const POLL_MS = 3_000;
const FEE_BPS = 25n;
const SPONSOR_RAW = 20_000_000_000_000_000_000_000n; // 0.02 NEAR in yocto

// ---------------------------------------------------------------------------------------------
// small helpers

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function until(
  description: string,
  limitMs: number,
  check: () => Promise<boolean>,
): Promise<void> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(POLL_MS);
  }
  throw new Error(`TIMEOUT: ${description}`);
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`CHECK_FAILED: ${message}`);
}

function big(value: unknown): bigint {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return 0n;
}

async function viewJson(
  ctx: Ctx,
  account: string,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = (await rpc(
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: account,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
    ctx.fetchImpl,
  )) as { result?: number[] };
  if (!Array.isArray(result.result)) throw new Error(`VIEW_FAILED: ${account}.${method}`);
  return JSON.parse(Buffer.from(result.result).toString("utf8")) as unknown;
}

async function claimOf(ctx: H1Ctx, tokenId: string): Promise<Record<string, unknown>> {
  const claim = await viewClaim(ctx, tokenId);
  must(claimIsReadable(claim), `claim ${tokenId} unreadable`);
  return claim;
}

function formatUnits(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

interface SessionView {
  id: string;
  route_id: string;
  deposit_address: string;
  amount_in: string;
  amount_usd: string;
  deadline: string;
  deadline_requested: number;
  status: string;
}

interface RouteView {
  id: string;
  payer_asset: string;
  origin_chain: string;
  origin_decimals: number;
  swap_type: string;
  evm_chain_id: number | null;
}

async function routesOf(ctx: H1Ctx, tokenId: string): Promise<RouteView[]> {
  const body = await readJson(
    `${ctx.api}/v1/pay/claims/${encodeURIComponent(tokenId)}`,
    ctx.fetchImpl,
  );
  return Array.isArray(body.routes) ? (body.routes as RouteView[]) : [];
}

async function newSession(
  ctx: H1Ctx,
  stepNumber: number,
  tokenId: string,
  routeId: string,
  amountUsd: string | undefined,
  deadlineSeconds: number,
): Promise<SessionView> {
  const refund = getEnv("H1_REFUND_EVM");
  if (refund === undefined) fail("MISSING_ENV: H1_REFUND_EVM");
  const created = await apiWrite(ctx, stepNumber, "/v1/pay/sessions", {
    token_id: tokenId,
    route_id: routeId,
    refund_to: refund,
    deadline_seconds: deadlineSeconds,
    ...(amountUsd === undefined ? {} : { amount_usd: amountUsd }),
  });
  return created as unknown as SessionView;
}

async function sessionStatus(
  ctx: H1Ctx,
  id: string,
): Promise<{ status: string; swap: string; refunded?: string }> {
  const body = await readJson(
    `${ctx.api}/v1/pay/sessions/${encodeURIComponent(id)}`,
    ctx.fetchImpl,
  );
  const swap = (body.swap_details ?? {}) as Record<string, unknown>;
  return {
    status: String(body.status ?? ""),
    swap: String(swap.status ?? ""),
    ...(typeof swap.refunded_amount === "string" ? { refunded: swap.refunded_amount } : {}),
  };
}

function tellToPay(
  ctx: H1Ctx,
  session: SessionView,
  route: RouteView | undefined,
  note: string,
): void {
  const amount = route
    ? `${formatUnits(session.amount_in, route.origin_decimals)} ${route.payer_asset} on ${route.origin_chain}`
    : `${session.amount_in} (base units)`;
  console.log(`\n  >>> ${note}`);
  console.log(`  >>> deposit address: ${session.deposit_address}`);
  console.log(`  >>> quote amount:    ${amount}   (valid until ${session.deadline})`);
  console.log(`  >>> price page:      ${ctx.web}/pay/${session.id}`);
}

async function issueInvoice(ctx: H1Ctx, stepNumber: number, label: string): Promise<string> {
  const debtor = getEnv("G1_EVM_DEBTOR_ADDRESS");
  if (debtor === undefined) fail("MISSING_ENV: G1_EVM_DEBTOR_ADDRESS");
  const body = {
    invoice_number: `H1-${label}-${Date.now()}`,
    issuer_legal_name: getEnv("G1_ISSUER_LEGAL_NAME") ?? "Openrail",
    debtor_legal_name: getEnv("G1_DEBTOR_LEGAL_NAME") ?? "H1 debtor",
    debtor_type: "evm",
    debtor_key: debtor,
    amount_usd: "3.00",
    due_date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    line_items: [{ description: `H1 ${label}`, quantity: 1, unit_amount_usd: "3.00" }],
  };
  const issued = await apiWrite(ctx, stepNumber, "/v1/invoices", body);
  const tokenId = String(issued.token_id ?? issued.id ?? "");
  must(tokenId !== "", "issue returned no token id");
  ctx.tokens[label] = tokenId;
  return tokenId;
}

function recorded(ctx: H1Ctx, label: string): string {
  const id = ctx.tokens[label];
  if (id === undefined || id === "")
    throw new Error(`MISSING_INVOICE: run the step that issues ${label}`);
  return id;
}

// ---------------------------------------------------------------------------------------------
// the rel1 set: read-only checks of the upgrade

const REL1: StepDef[] = [
  {
    name: "upgrade integrity: code, claims, counter",
    usd: 0,
    readOnly: true,
    async run(ctx, state) {
      must(ctx.codeHash !== null, "the root account's code hash is unknown");
      const expected = getEnv("EXPECTED_CODE_HASH");
      must(expected !== undefined, "set EXPECTED_CODE_HASH to the REL-1 hash");
      must(ctx.codeHash === expected, `code hash ${ctx.codeHash} is not ${expected}`);
      const seen: Record<string, unknown> = {};
      for (const id of ["c-1", "c-2", "c-3"]) {
        const claim = await claimOf(ctx, id);
        must(claim.status === "Paid", `${id} should still be Paid, is ${String(claim.status)}`);
        must(typeof claim.terms_hash === "string", `${id} lost its terms hash`);
        must(
          big(claim.booked_total) >= big(claim.distributed_total) + big(claim.fee_total),
          `${id}: booked is less than paid out plus fee`,
        );
        seen[id] = { owner: claim.owner_id, booked: String(claim.booked_total) };
      }
      const next = await viewJson(ctx, ctx.root, "next_token_id", {});
      must(typeof next === "number" && next >= 4, `next_token_id is ${String(next)}`);
      state.evidence = { code_hash: ctx.codeHash, claims: seen, next_token_id: next };
    },
  },
  {
    name: "live invoice NFT: media follows the claim",
    usd: 0,
    readOnly: true,
    async run(ctx, state) {
      const token = (await viewJson(ctx, ctx.root, "nft_token", { token_id: "c-1" })) as {
        metadata?: { media?: string | null };
      } | null;
      const media = token?.metadata?.media;
      must(
        typeof media === "string" && media.startsWith("data:image/svg+xml"),
        "c-1 has no live media",
      );
      const comma = media.indexOf(",");
      const raw = media.slice(comma + 1);
      const svg = media.includes(";base64,")
        ? Buffer.from(raw, "base64").toString("utf8")
        : decodeURIComponent(raw);
      must(svg.includes("Paid"), "the picture of a paid claim does not say Paid");
      must(svg.includes("100%"), "the picture of a paid claim does not show 100%");
      state.evidence = { token_id: "c-1", svg_bytes: svg.length };
    },
  },
  {
    name: "new views answer: sponsor pool, payout relayers, settlement",
    usd: 0,
    readOnly: true,
    async run(ctx, state) {
      const sponsor = (await viewJson(ctx, ctx.root, "sponsor_status", {
        account_id: ctx.business,
      })) as { pool?: string; cap?: number; used?: number };
      must(
        typeof sponsor.cap === "number" && sponsor.cap === 5,
        `sponsor cap is ${String(sponsor.cap)}`,
      );
      const relayers = await viewJson(ctx, ctx.root, "payout_relayers", {});
      must(Array.isArray(relayers), "payout_relayers is not a list");
      const settlement = await viewJson(ctx, ctx.root, "settlement_of", {
        account_id: ctx.business,
      });
      state.evidence = { sponsor, relayers, settlement: settlement === null ? "none" : "set" };
    },
  },
];

// ---------------------------------------------------------------------------------------------
// the h1 set: adversarial cases

const H1: StepDef[] = [
  {
    name: "issue invoice A and check the sponsor accounting",
    usd: 0,
    readOnly: false,
    async run(ctx, state) {
      const readCredit = async (): Promise<bigint> => {
        const v = await viewJson(ctx, ctx.root, "storage_credit_of", { account_id: ctx.business });
        return big(v);
      };
      const readSponsor = async (): Promise<{ pool: bigint; used: number }> => {
        const v = (await viewJson(ctx, ctx.root, "sponsor_status", {
          account_id: ctx.business,
        })) as { pool?: string; used?: number };
        return { pool: big(v.pool), used: Number(v.used ?? 0) };
      };
      const before = { credit: await readCredit(), sponsor: await readSponsor() };
      const tokenId = await issueInvoice(ctx, 1, "A");
      state.token_id = tokenId;
      const after = { credit: await readCredit(), sponsor: await readSponsor() };
      const ownCredit = before.credit - after.credit === SPONSOR_RAW;
      const sponsored =
        before.sponsor.pool - after.sponsor.pool === SPONSOR_RAW &&
        after.sponsor.used === before.sponsor.used + 1 &&
        before.credit === after.credit;
      must(
        ownCredit || sponsored,
        "the 0.02 NEAR came from neither the credit nor the sponsor pool",
      );
      if (before.credit >= SPONSOR_RAW) must(ownCredit, "own credit must be used before the pool");
      const claim = await claimOf(ctx, tokenId);
      must(claim.status === "Issued", `new claim is ${String(claim.status)}`);
      state.evidence = { token_id: tokenId, paid_from: ownCredit ? "own credit" : "sponsor pool" };
    },
  },
  {
    name: "expired quote: a price past its deadline changes nothing until it is paid",
    usd: 0,
    readOnly: false,
    async run(ctx, state) {
      const tokenId = recorded(ctx, "A");
      const routes = await routesOf(ctx, tokenId);
      const route = routes.find((r) => r.swap_type === "FLEX_INPUT" && r.evm_chain_id !== null);
      must(route !== undefined, "no USDC route offered");
      // The deadline that counts is the one logged on chain (`deadline_requested`). The swap provider
      // keeps its deposit address open for three days after it, so the session is kept for step 4.
      const session = await newSession(ctx, 2, tokenId, route.id, undefined, 300);
      const lapse = Number(session.deadline_requested) * 1000;
      console.log(
        `  quote ${session.id} lapses (on chain) at ${new Date(lapse).toISOString()}; waiting`,
      );
      await until("our quote deadline", 8 * 60_000, async () => lapse + 10_000 < Date.now());
      const claim = await claimOf(ctx, tokenId);
      must(big(claim.booked_total) === 0n, "an unpaid quote changed the claim");
      state.evidence = { session, route_id: route.id, booked_total: "0" };
    },
  },
  {
    name: "short deposit: less than the price waits, and a top-up completes it",
    usd: 3,
    readOnly: false,
    async run(ctx, state) {
      const tokenId = await issueInvoice(ctx, 3, "B");
      state.token_id = tokenId;
      const routes = await routesOf(ctx, tokenId);
      const route = routes.find((r) => r.swap_type === "FLEX_INPUT" && r.evm_chain_id !== null);
      must(route !== undefined, "no USDC route offered");
      const session = await newSession(ctx, 3, tokenId, route.id, undefined, 3600);
      tellToPay(
        ctx,
        session,
        route,
        "Send exactly 1.00 USDC (less than the 3.00 price) to this address:",
      );
      await until("the provider sees the short deposit", 12 * 60_000, async () => {
        return (await sessionStatus(ctx, session.id)).swap === "INCOMPLETE_DEPOSIT";
      });
      const waiting = await claimOf(ctx, tokenId);
      must(big(waiting.booked_total) === 0n, "a short deposit was booked");
      console.log(
        "  the short deposit waits and nothing is booked. Now send the other 2.00 USDC to the SAME address.",
      );
      await until("the top-up completes the payment", 25 * 60_000, async () => {
        return big((await claimOf(ctx, tokenId)).booked_total) >= 3n * USDC;
      });
      const claim = await claimOf(ctx, tokenId);
      must(
        big(claim.booked_total) === 3n * USDC,
        `booked ${String(claim.booked_total)}, expected exactly 3000000`,
      );
      must(claim.status === "Paid", `status is ${String(claim.status)}`);
      state.evidence = {
        session: session.id,
        token_id: tokenId,
        booked: "3000000",
        note: "the provider returns an uncompleted deposit only after its own three-day deadline; that return was not exercised",
      };
    },
  },
  {
    name: "overpayment on an expired quote: it is booked, the extra becomes surplus",
    usd: 4,
    readOnly: false,
    async run(ctx, state) {
      const tokenId = recorded(ctx, "A");
      const kept = (step(ctx.state, 2).evidence ?? {}) as {
        session?: SessionView;
        route_id?: string;
      };
      must(kept.session !== undefined, "run step 2 first: it keeps the quote that is paid here");
      const session = kept.session;
      const routes = await routesOf(ctx, tokenId);
      tellToPay(
        ctx,
        session,
        routes.find((r) => r.id === kept.route_id),
        "This quote is past its on-chain deadline. Send 4.00 USDC (more than the 3.00 price) to this address:",
      );
      await until("the overpayment is booked", 25 * 60_000, async () => {
        return big((await claimOf(ctx, tokenId)).booked_total) > 0n;
      });
      const claim = await claimOf(ctx, tokenId);
      const booked = big(claim.booked_total);
      must(booked > 3n * USDC, `booked ${booked} is not more than the invoice`);
      must(claim.status === "Paid", `status is ${String(claim.status)}`);
      must(
        big(claim.surplus) === booked - 3n * USDC,
        "surplus is not exactly the part above the invoice",
      );
      const fee = (3n * USDC * FEE_BPS) / 10_000n;
      must(big(claim.fee_total) === fee, `fee ${String(claim.fee_total)} is not ${fee}`);
      must(
        big(claim.distributed_total) === 3n * USDC - fee,
        "paid out is not the invoice minus the fee",
      );
      state.evidence = {
        token_id: tokenId,
        booked: booked.toString(),
        surplus: String(claim.surplus),
      };
    },
  },
  {
    name: "late payment after a transfer: it becomes surplus for the owner, nothing is charged again",
    usd: 1,
    readOnly: false,
    async run(ctx, state) {
      const tokenId = getEnv("H1_LATE_TOKEN") ?? "c-3";
      const before = await claimOf(ctx, tokenId);
      must(before.status === "Paid", `${tokenId} is not a paid claim`);
      const routes = await routesOf(ctx, tokenId);
      // A stablecoin quote made now. (An old ETH or SOL quote is no use: the price has moved and the
      // swap would be returned, as happened on 6 Nov.) The API quotes an explicit amount on a paid claim.
      const route = routes.find((r) => r.swap_type === "FLEX_INPUT" && r.evm_chain_id !== null);
      must(route !== undefined, "no USDC route offered");
      const session = await newSession(ctx, 5, tokenId, route.id, "1.00", 1800);
      tellToPay(
        ctx,
        session,
        route,
        `Send 1.00 USDC to this address. It is a payment on an already paid claim (owner ${String(before.owner_id)}):`,
      );
      await until("the late payment is booked", 25 * 60_000, async () => {
        return big((await claimOf(ctx, tokenId)).booked_total) > big(before.booked_total);
      });
      const after = await claimOf(ctx, tokenId);
      const delta = big(after.booked_total) - big(before.booked_total);
      must(delta === USDC, `booked ${delta}, expected 1000000`);
      must(after.status === "Paid", `status is ${String(after.status)}`);
      must(
        big(after.surplus) - big(before.surplus) === delta,
        "the late payment is not all surplus",
      );
      must(
        big(after.distributed_total) === big(before.distributed_total),
        "a late payment was paid out again",
      );
      must(big(after.fee_total) === big(before.fee_total), "a fee was taken on a late payment");
      must(after.owner_id === before.owner_id, "the owner changed");
      state.evidence = {
        token_id: tokenId,
        delta: delta.toString(),
        owner: String(after.owner_id),
      };
    },
  },
  {
    name: "stray token: a token that is not a settlement asset is never booked",
    usd: 0,
    readOnly: false,
    async run(ctx, state) {
      const tokenId = getEnv("H1_STRAY_TOKEN") ?? "c-1";
      const claim = await claimOf(ctx, tokenId);
      const account = String(claim.claim_account);
      const sender = getEnv("H1_STRAY_ACCOUNT") ?? "<your NEAR account>";
      const asset = "nep141:wrap.near";
      must(
        !(claim.settlement_assets as string[]).includes(asset),
        "wrap.near is a settlement asset here",
      );
      console.log(
        `\n  >>> Run these two commands (0.01 NEAR of wNEAR goes to ${account} on Intents):`,
      );
      console.log(
        `  >>> near contract call-function as-transaction wrap.near near_deposit json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as ${sender} network-config mainnet sign-with-legacy-keychain send`,
      );
      console.log(
        `  >>> near contract call-function as-transaction wrap.near ft_transfer_call json-args '{"receiver_id":"intents.near","amount":"10000000000000000000000","msg":"{\\"receiver_id\\":\\"${account}\\"}"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${sender} network-config mainnet sign-with-legacy-keychain send`,
      );
      await until("the stray token reaches the claim's Intents balance", 10 * 60_000, async () => {
        const bal = (await viewJson(ctx, "intents.near", "mt_batch_balance_of", {
          account_id: account,
          token_ids: [asset],
        })) as string[];
        return big(bal[0]) > 0n;
      });
      const before = await claimOf(ctx, tokenId);
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
      await sleep(45_000);
      const after = await claimOf(ctx, tokenId);
      for (const field of ["booked_total", "surplus", "distributed_total", "fee_total"]) {
        must(
          String(after[field]) === String(before[field]),
          `${field} moved: a stray token was booked`,
        );
      }
      state.evidence = { token_id: tokenId, asset, booked_total: String(after.booked_total) };
    },
  },
  {
    name: "transfer during reconcile is refused (Rule 1)",
    usd: 0,
    readOnly: false,
    async run(ctx, state) {
      const tokenId = getEnv("H1_TRANSFER_TOKEN") ?? "c-3";
      const third = getEnv("G1_THIRD_ACCOUNT") ?? getEnv("FEE_ACCOUNT");
      must(third !== undefined, "set G1_THIRD_ACCOUNT");
      const owner = String((await claimOf(ctx, tokenId)).owner_id);
      must(
        owner === getEnv("G1_BUYER_ACCOUNT"),
        `the owner ${owner} is not the account whose key is in G1_BUYER_ACCOUNT`,
      );
      await sendNear(
        ctx,
        7,
        ctx.root,
        "reconcile",
        { token_id: tokenId },
        250_000_000_000_000n,
        0n,
        "WATCHER_ACCOUNT_ID",
        "WATCHER_PRIVATE_KEY",
      );
      let refused = false;
      try {
        await sendNear(
          ctx,
          7,
          ctx.root,
          "nft_transfer",
          { receiver_id: third, token_id: tokenId, approval_id: null, memo: null },
          100_000_000_000_000n,
          1n,
          "G1_BUYER_ACCOUNT",
          "G1_BUYER_PRIVATE_KEY",
        );
      } catch (error) {
        refused = error instanceof Error && error.message.includes("Rule 1");
        if (!refused) throw error;
      }
      must(refused, "the transfer was not refused with Rule 1");
      must(String((await claimOf(ctx, tokenId)).owner_id) === owner, "the owner changed");
      state.evidence = { token_id: tokenId, refused: true };
    },
  },
  {
    name: "two payments in a row are each booked exactly once",
    usd: 3,
    readOnly: false,
    async run(ctx, state) {
      const tokenId = await issueInvoice(ctx, 8, "C");
      state.token_id = tokenId;
      const routes = (await routesOf(ctx, tokenId)).filter(
        (r) => r.swap_type === "FLEX_INPUT" && r.evm_chain_id !== null,
      );
      must(routes.length >= 2, "need two USDC routes");
      const [first, second] = routes as [RouteView, RouteView];
      const one = await newSession(ctx, 8, tokenId, first.id, "1.50", 3600);
      const two = await newSession(ctx, 8, tokenId, second.id, "1.50", 3600);
      tellToPay(ctx, one, first, "Payment 1 of 2: send this amount, then immediately payment 2:");
      tellToPay(ctx, two, second, "Payment 2 of 2 (send within a minute of payment 1):");
      await until("both payments are booked", 30 * 60_000, async () => {
        return big((await claimOf(ctx, tokenId)).booked_total) >= 3n * USDC;
      });
      await sleep(30_000);
      const claim = await claimOf(ctx, tokenId);
      must(
        big(claim.booked_total) === 3n * USDC,
        `booked ${String(claim.booked_total)}, expected exactly 3000000 (no double booking)`,
      );
      must(claim.status === "Paid", `status is ${String(claim.status)}`);
      must(big(claim.surplus) === 0n, "unexpected surplus");
      state.evidence = { token_id: tokenId, booked: "3000000" };
    },
  },
  {
    name: "forced failed leg and retry_distribution",
    usd: 0,
    readOnly: true,
    sandboxOnly:
      "contracts/tests/tests/c4_reconcile_tests.rs::test_c4_mutation_break_4_d_s8_failed_leg_preserves_status_and_booked",
    async run() {
      /* covered in the sandbox: no way to make a payee refuse on mainnet */
    },
  },
];

const SETS: Record<SetName, StepDef[]> = { rel1: REL1, h1: H1 };

// ---------------------------------------------------------------------------------------------
// run

export interface H1Report {
  run: "REL1" | "H1";
  network: string;
  started_utc: string;
  finished_utc: string;
  result: "PASS" | "FAIL";
  code_hash: string | null;
  steps: Array<{
    step: number;
    name: string;
    status: string;
    covered_by?: string;
    tx_hashes: string[];
    request_ids: string[];
    evidence?: Record<string, unknown>;
    error?: string;
  }>;
}

function writeReport(ctx: H1Ctx, defs: StepDef[], finished: Date): H1Report {
  const steps = defs.map((def, index) => {
    const state = step(ctx.state, index + 1);
    return {
      step: index + 1,
      name: def.name,
      status: def.sandboxOnly ? "SANDBOX_ONLY" : state.status,
      ...(def.sandboxOnly ? { covered_by: def.sandboxOnly } : {}),
      tx_hashes: state.tx_hashes,
      request_ids: state.request_ids,
      ...(state.evidence === undefined ? {} : { evidence: state.evidence }),
      ...(state.error === undefined ? {} : { error: state.error }),
    };
  });
  const result = steps.every((s) => s.status === "PASS" || s.status === "SANDBOX_ONLY")
    ? "PASS"
    : "FAIL";
  return {
    run: ctx.set === "rel1" ? "REL1" : "H1",
    network: ctx.network,
    started_utc: ctx.state.started_utc,
    finished_utc: finished.toISOString(),
    result,
    code_hash: ctx.codeHash,
    steps,
  };
}

function committedUsd(ctx: H1Ctx, defs: StepDef[], upTo: number): number {
  let total = 0;
  for (let i = 0; i < upTo; i += 1) {
    const def = defs[i];
    if (def !== undefined && step(ctx.state, i + 1).status === "PASS") total += def.usd;
  }
  return total;
}

export async function runH1(argv: string[] = process.argv.slice(2)): Promise<number> {
  const setIndex = argv.indexOf("--set");
  const setArg = setIndex >= 0 ? argv[setIndex + 1] : undefined;
  if (setArg !== "rel1" && setArg !== "h1")
    fail("usage: pnpm t2:h1 --set rel1|h1 [--env-file PATH] [--state PATH] [--reports-dir DIR]");
  const set: SetName = setArg;
  const rest = argv.filter((_, i) => i !== setIndex && i !== setIndex + 1);
  const options = parseArgs(rest);
  if (!rest.some((a) => a.startsWith("--state")) && process.env.G1_STATE_PATH === undefined) {
    options.statePath = join(process.cwd(), `reports/${set.toUpperCase()}-state.json`);
  }
  if (options.envFile !== undefined) loadEnvFile(options.envFile);
  if (options.yesAll) fail("--yes-all is not available here");
  const network = getEnv("NEAR_ENV") ?? "mainnet";
  if (network !== "mainnet") fail("NEAR_ENV must be mainnet for this runner");
  const confirmFlag = getEnv("OWED_CONFIRM_MAINNET") === "yes";
  const maxRaw = getEnv("MAX_SPEND_USD");
  if (confirmFlag && maxRaw === undefined) fail("MISSING_ENV: MAX_SPEND_USD");
  const max = maxRaw === undefined ? 0 : Number(maxRaw);
  if (maxRaw !== undefined && (!Number.isFinite(max) || max <= 0))
    fail("MAX_SPEND_USD must be a positive number");
  const dryRun = !confirmFlag;
  const root = requireOrExit("NEAR_ROOT_ACCOUNT");
  requireOrExit("NEAR_RPC_URL");
  if (set === "h1" && !dryRun) {
    for (const name of [
      "ISSUER_PRIVATE_KEY",
      "WATCHER_PRIVATE_KEY",
      "ONECLICK_JWT",
      "OPENRAIL_API_KEY",
      "H1_REFUND_EVM",
      "G1_EVM_DEBTOR_ADDRESS",
    ]) {
      requireOrExit(name);
    }
  }
  const defs = SETS[set];
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const lines = readline[Symbol.asyncIterator]();
  const ctx: H1Ctx = {
    options,
    network: "mainnet",
    sandbox: false,
    dryRun,
    send: !dryRun,
    api: getEnv("API_BASE_URL") ?? "https://api.openrail.incepture.dev",
    web: getEnv("WEB_BASE_URL") ?? "https://openrail.incepture.dev",
    indexer: getEnv("INDEXER_URL") ?? "http://127.0.0.1:8788",
    root,
    near: nearClientFromEnv(),
    state: loadState(options.statePath, "mainnet"),
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
    set,
    business: requireOrExit("H1_BUSINESS_ACCOUNT"),
    tokens: {},
  };
  // Invoices issued by earlier steps (a resumed run): step 1 issued A, step 3 B, step 8 C.
  for (const [number, label] of [
    [1, "A"],
    [3, "B"],
    [8, "C"],
  ] as const) {
    const saved = step(ctx.state, number).token_id;
    if (saved !== undefined && set === "h1") ctx.tokens[label] = saved;
  }
  const writeFinal = (): H1Report => {
    mkdirSync(options.reportDir, { recursive: true });
    const report = writeReport(ctx, defs, new Date());
    const path = join(options.reportDir, `${report.run}-${utcStamp()}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    saveState(options.statePath, ctx.state);
    console.log(`report ${path} result=${report.result}`);
    return report;
  };
  try {
    await preflight(ctx);
    for (let i = 0; i < defs.length; i += 1) {
      const def = defs[i] as StepDef;
      const number = i + 1;
      const state = step(ctx.state, number);
      if (state.status === "PASS") continue;
      if (def.sandboxOnly) {
        console.log(
          `\n## Step ${number}: ${def.name}\n  not run on mainnet; covered in the sandbox by ${def.sandboxOnly}`,
        );
        continue;
      }
      ctx.currentStep = number;
      if (def.readOnly) {
        console.log(`\n## Step ${number}: ${def.name}`);
      } else {
        await approve(ctx, number, def.name, describe(def));
        if (ctx.dryRun) continue;
        const planned = committedUsd(ctx, defs, i) + def.usd;
        if (def.usd > 0 && planned > max)
          throw new Error(`MAX_SPEND_USD ${max} would be exceeded (${planned} with this step)`);
      }
      try {
        await def.run(ctx, state);
        state.status = "PASS";
        console.log("  PASS");
      } catch (error) {
        state.status = "FAIL";
        state.error = redactString(error instanceof Error ? error.message : String(error));
        console.log(`  FAIL: ${state.error}`);
        if (!def.readOnly) throw error;
      }
      if (!dryRun || def.readOnly) saveState(options.statePath, ctx.state);
      // Money never moves again after a failed paying step.
      if (state.status === "FAIL" && def.usd > 0) throw new Error(state.error);
    }
    if (set === "rel1" || !dryRun) {
      const report = writeFinal();
      return report.result === "PASS" ? 0 : 1;
    }
    console.log("\n# dry run complete: nothing was signed or sent");
    return 0;
  } catch (error) {
    if (error instanceof StopRun) {
      console.error(`STOPPED: ${error.message}`);
      return 1;
    }
    console.error(redactString(error instanceof Error ? error.message : String(error)));
    if (!dryRun || set === "rel1") writeFinal();
    return 1;
  } finally {
    readline.close();
  }
}

function describe(def: StepDef): string {
  return `${def.name}${def.usd > 0 ? `\nYou will be asked to send about $${def.usd}; the runner never sends it for you.` : ""}`;
}

const startedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (process.env.VITEST === undefined && startedDirectly) {
  runH1()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(redactString(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    });
}
