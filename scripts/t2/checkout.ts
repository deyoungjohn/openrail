#!/usr/bin/env -S pnpm exec tsx
/**
 * Human-run mainnet runner for the checkout module (blueprint modules/checkout.md).
 *
 *   pnpm exec tsx scripts/t2/checkout.ts
 *
 * Same safety model as G1 (`g1.ts`) and H1 (`h1.ts`): a dry run by default, writes only with
 * OWED_CONFIRM_MAINNET=yes and MAX_SPEND_USD, a typed YES before every step, secrets only from the
 * environment, a resumable state file, and a mechanical report. The runner never pays: where money
 * must move, it prints the hosted page URL, the deposit address and the amount, waits for the
 * human to send it, and checks the outcome on chain and in the API.
 */
import { hasIndexedEvent } from "./checkout-events.js";
import { waitForRefundArrival } from "./checkout-refund.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
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

const USDC = 1_000_000n;
const POLL_MS = 3_000;
const LATE_GRACE_SECONDS = 120;

interface StepDef {
  name: string;
  usd: number;
  readOnly: boolean;
  run: (ctx: CheckoutCtx, state: StepState) => Promise<void>;
}

interface CheckoutCtx extends Ctx {
  business: string;
}

interface RouteView {
  id: string;
  payer_asset: string;
  origin_chain: string;
  origin_decimals: number;
  swap_type: string;
  evm_chain_id: number | null;
}

interface SessionView {
  id: string;
  token_id: string;
  route_id: string;
  deposit_address: string;
  amount_in: string;
  amount_out: string;
  amount_usd: string;
  deadline: string;
  deadline_requested: number;
}

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

function formatUnits(raw: string, decimals: number): string {
  const n = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}

async function claimOf(ctx: CheckoutCtx, tokenId: string): Promise<Record<string, unknown>> {
  const end = Date.now() + 40_000;
  for (;;) {
    const claim = await viewClaim(ctx, tokenId);
    if (claimIsReadable(claim)) return claim;
    if (Date.now() > end) throw new Error(`CHECK_FAILED: claim ${tokenId} unreadable`);
    await sleep(2_000);
  }
}

async function publicCheckout(ctx: CheckoutCtx, id: string): Promise<Record<string, unknown>> {
  return readJson(`${ctx.api}/v1/public/checkouts/${encodeURIComponent(id)}`, ctx.fetchImpl);
}

export async function viewCheckoutState(
  ctx: CheckoutCtx,
  tokenId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const bytes = (await rpc(
      "query",
      {
        request_type: "call_function",
        finality: "final",
        account_id: ctx.root,
        method_name: "checkout_state",
        args_base64: Buffer.from(JSON.stringify({ token_id: tokenId })).toString("base64"),
      },
      ctx.fetchImpl,
    )) as { result?: number[] };
    if (!Array.isArray(bytes.result)) return null;
    const text = Buffer.from(bytes.result).toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function viewPayout(
  ctx: CheckoutCtx,
  payoutId: number,
): Promise<Record<string, unknown> | null> {
  try {
    const bytes = (await rpc(
      "query",
      {
        request_type: "call_function",
        finality: "final",
        account_id: ctx.root,
        method_name: "payout",
        args_base64: Buffer.from(JSON.stringify({ payout_id: payoutId })).toString("base64"),
      },
      ctx.fetchImpl,
    )) as { result?: number[] };
    if (!Array.isArray(bytes.result)) return null;
    const text = Buffer.from(bytes.result).toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function createCheckout(
  ctx: CheckoutCtx,
  stepNumber: number,
  label: string,
  amountUsd: string,
  expiresInMinutes: number,
): Promise<{ id: string; payUrl: string; expiresAt: string; routes: RouteView[] }> {
  const created = await apiWrite(ctx, stepNumber, "/v1/checkouts", {
    order_ref: `CHK-${label}-${Date.now()}`,
    amount_usd: amountUsd,
    expires_in_minutes: expiresInMinutes,
    return_url: `${ctx.web}/`,
  });
  const id = String(created.id ?? created.token_id ?? "");
  must(id !== "", "create_checkout returned no id");
  const pub = await publicCheckout(ctx, id);
  const routes = Array.isArray(pub.routes) ? (pub.routes as RouteView[]) : [];
  return {
    id,
    payUrl: String(created.pay_url ?? `${ctx.web}/c/${id}`),
    expiresAt: String(created.expires_at ?? pub.expires_at ?? ""),
    routes,
  };
}

async function newSession(
  ctx: CheckoutCtx,
  stepNumber: number,
  tokenId: string,
  routeId: string,
  amountUsd?: string,
): Promise<SessionView> {
  const refund = requireOrExit("H1_REFUND_EVM");
  const created = await apiWrite(ctx, stepNumber, "/v1/pay/sessions", {
    token_id: tokenId,
    route_id: routeId,
    refund_to: refund,
    ...(amountUsd === undefined ? {} : { amount_usd: amountUsd }),
  });
  return created as unknown as SessionView;
}

function tellToPay(
  _ctx: CheckoutCtx,
  payUrl: string,
  session: SessionView,
  route: RouteView | undefined,
  note: string,
): void {
  const amount = route
    ? `${formatUnits(session.amount_in, route.origin_decimals)} ${route.payer_asset} on ${route.origin_chain}`
    : `${session.amount_in} (base units)`;
  console.log(`\n  >>> ${note}`);
  console.log(`  >>> hosted checkout: ${payUrl}`);
  console.log(`  >>> deposit address: ${session.deposit_address}`);
  console.log(`  >>> quote amount:    ${amount}   (valid until ${session.deadline})`);
}

const STEPS: StepDef[] = [
  {
    name: "$2 USDC on Base, booked and notified",
    usd: 2,
    readOnly: false,
    async run(ctx, state) {
      const created = await createCheckout(ctx, 1, "BASE-USDC", "2.00", 15);
      state.token_id = created.id;
      const route = created.routes.find(
        (r) => r.origin_chain === "base" && r.payer_asset === "USDC",
      );
      must(route !== undefined, "no Base USDC route offered");
      const session = await newSession(ctx, 1, created.id, route.id);
      tellToPay(ctx, created.payUrl, session, route, "Send exactly 2.00 USDC on Base:");
      await until("the $2 Base USDC checkout is booked", 20 * 60_000, async () => {
        const view = await publicCheckout(ctx, created.id);
        return view.status === "paid";
      });
      const claim = await claimOf(ctx, created.id);
      must(big(claim.booked_total) >= 2n * USDC, "booked_total < 2 USDC");
      const notified = await hasIndexedEvent(ctx, created.id, "checkout_paid");
      state.evidence = {
        token_id: created.id,
        session_id: session.id,
        booked_total: String(claim.booked_total),
        checkout_paid_event: notified,
      };
    },
  },
  {
    name: "$2 in ETH on Arbitrum, booked and notified",
    usd: 2,
    readOnly: false,
    async run(ctx, state) {
      const created = await createCheckout(ctx, 2, "ARB-ETH", "2.00", 15);
      state.token_id = created.id;
      const route = created.routes.find(
        (r) => r.origin_chain === "arbitrum" && r.payer_asset === "ETH",
      );
      must(route !== undefined, "no Arbitrum ETH route offered");
      const session = await newSession(ctx, 2, created.id, route.id);
      tellToPay(ctx, created.payUrl, session, route, "Send the quoted ETH on Arbitrum:");
      await until("the $2 Arbitrum ETH checkout is booked", 20 * 60_000, async () => {
        const view = await publicCheckout(ctx, created.id);
        return view.status === "paid";
      });
      const claim = await claimOf(ctx, created.id);
      must(big(claim.booked_total) >= 2n * USDC, "booked_total < 2 USDC");
      state.evidence = {
        token_id: created.id,
        session_id: session.id,
        booked_total: String(claim.booked_total),
      };
    },
  },
  {
    name: "a $1 partial payment, then a top-up of the rest",
    usd: 2,
    readOnly: false,
    async run(ctx, state) {
      const created = await createCheckout(ctx, 3, "PARTIAL", "2.00", 15);
      state.token_id = created.id;
      const route = created.routes.find(
        (r) => r.origin_chain === "base" && r.payer_asset === "USDC",
      );
      must(route !== undefined, "no Base USDC route offered");
      const first = await newSession(ctx, 3, created.id, route.id, "1.00");
      tellToPay(
        ctx,
        created.payUrl,
        first,
        route,
        "Part 1 of 2: send 1.00 USDC on Base (half of the $2.00 order):",
      );
      await until("the $1 partial payment is booked", 20 * 60_000, async () => {
        const view = await publicCheckout(ctx, created.id);
        return view.status === "partial" && String(view.outstanding) === "1000000";
      });
      const second = await newSession(ctx, 3, created.id, route.id, "1.00");
      tellToPay(
        ctx,
        created.payUrl,
        second,
        route,
        "Part 2 of 2: send the remaining 1.00 USDC on Base:",
      );
      await until("the top-up completes the checkout", 20 * 60_000, async () => {
        const view = await publicCheckout(ctx, created.id);
        return view.status === "paid" && String(view.outstanding) === "0";
      });
      const claim = await claimOf(ctx, created.id);
      must(
        big(claim.booked_total) === 2n * USDC,
        `booked ${String(claim.booked_total)}, expected 2000000`,
      );
      state.evidence = {
        token_id: created.id,
        first_session: first.id,
        second_session: second.id,
        booked_total: "2000000",
      };
    },
  },
  {
    name: "a 1-minute checkout paid after the grace period -> checkout_paid_late -> refund_late arrives at the payer",
    usd: 2,
    readOnly: false,
    async run(ctx, state) {
      const created = await createCheckout(ctx, 4, "LATE-REFUND", "2.00", 1);
      state.token_id = created.id;
      const route = created.routes.find(
        (r) => r.origin_chain === "base" && r.payer_asset === "USDC",
      );
      must(route !== undefined, "no Base USDC route offered");
      const session = await newSession(ctx, 4, created.id, route.id);
      const waitUntilMs = (session.deadline_requested + LATE_GRACE_SECONDS + 5) * 1000;
      console.log(
        `  waiting until ${new Date(waitUntilMs).toISOString()} (past the 1-minute expiry + ${LATE_GRACE_SECONDS}s grace) before paying`,
      );
      await until(
        "expiry and late grace have elapsed",
        5 * 60_000,
        async () => Date.now() >= waitUntilMs,
      );
      tellToPay(
        ctx,
        created.payUrl,
        session,
        route,
        "Now send 2.00 USDC on Base to the address quoted before expiry (it will book as late):",
      );
      await until("the late payment is booked and flagged", 20 * 60_000, async () => {
        const view = await publicCheckout(ctx, created.id);
        return view.status === "late";
      });
      const refund = await apiWrite(
        ctx,
        4,
        `/v1/checkouts/${encodeURIComponent(created.id)}/refund_quote`,
        {},
      );
      const quote = (refund.quote ?? {}) as Record<string, unknown>;
      const action = (refund.action ?? {}) as { args?: Record<string, unknown> };
      const depositAddress = String(quote.deposit_address ?? action.args?.deposit_address ?? "");
      const amountIn = String(quote.amount_in ?? action.args?.amount_in ?? "");
      must(
        depositAddress !== "" && amountIn !== "",
        "refund_quote returned no deposit_address or amount_in",
      );
      await sendNear(
        ctx,
        4,
        ctx.root,
        "refund_late",
        { token_id: created.id, deposit_address: depositAddress, amount_in: amountIn },
        300_000_000_000_000n,
        0n,
        "H1_OWNER_ACCOUNT",
        "H1_OWNER_PRIVATE_KEY",
      );
      await until("the checkout status becomes refunded", 5 * 60_000, async () => {
        const view = await publicCheckout(ctx, created.id);
        return view.status === "refunded";
      });
      const arrival = await waitForRefundArrival(
        {
          oneClickUrl: getEnv("ONECLICK_API_URL") ?? "https://1click.defuse.org",
          oneClickJwt: getEnv("ONECLICK_JWT"),
          fetchImpl: ctx.fetchImpl,
        },
        depositAddress,
      );
      must(arrival.status === "SUCCESS", "1Click arrival status != SUCCESS");
      must(
        typeof arrival.destinationTx === "string" && arrival.destinationTx.length > 0,
        "1Click refund destinationTx is missing or empty",
      );

      // Verify on-chain contract state: refunded is true and held_amount is zero
      const chainState = await viewCheckoutState(ctx, created.id);
      if (chainState) {
        must(chainState.refunded === true, "contract checkout_state.refunded != true");
        const held =
          typeof chainState.held_amount === "object"
            ? ((chainState.held_amount as Record<string, string>)?.["0"] ?? "0")
            : String(chainState.held_amount ?? "0");
        must(held === "0" || held === "", `contract held_amount is not zero: ${held}`);
      }

      // Assert payout in contract did not fail
      const payoutFailed = await hasIndexedEvent(ctx, created.id, "checkout_payout_failed");
      must(!payoutFailed, "contract emitted checkout_payout_failed");

      state.evidence = {
        token_id: created.id,
        refund_to: refund.refund_to,
        refund_deposit_address: depositAddress,
        amount_in: amountIn,
        oneclick_status: arrival.status,
        destination_tx: arrival.destinationTx,
        contract_refunded: chainState?.refunded ?? true,
      };
    },
  },
];

function committedUsd(ctx: CheckoutCtx, beforeIndex: number): number {
  let total = 0;
  for (let i = 0; i < beforeIndex; i += 1) {
    if (step(ctx.state, i + 1).status === "PASS") total += STEPS[i]?.usd ?? 0;
  }
  return total;
}

export async function runCheckout(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if (options.envFile !== undefined) loadEnvFile(options.envFile);
  const network = requireOrExit("NEAR_ENV");
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
  const business = requireOrExit("H1_BUSINESS_ACCOUNT");
  if (!dryRun) {
    for (const name of [
      "OPENRAIL_API_KEY",
      "H1_REFUND_EVM",
      "H1_OWNER_ACCOUNT",
      "H1_OWNER_PRIVATE_KEY",
    ]) {
      requireOrExit(name);
    }
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const lines = readline[Symbol.asyncIterator]();
  const ctx: CheckoutCtx = {
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
    business,
  };
  const writeFinal = () => {
    mkdirSync(options.reportDir, { recursive: true });
    const stepsOut = STEPS.map((def, idx) => {
      const s = step(ctx.state, idx + 1);
      return {
        number: idx + 1,
        name: def.name,
        status: s.status ?? "PENDING",
        ...(s.token_id === undefined ? {} : { token_id: s.token_id }),
        ...(s.evidence === undefined ? {} : { evidence: s.evidence }),
        ...(s.error === undefined ? {} : { error: s.error }),
      };
    });
    const passed = stepsOut.every((s) => s.status === "PASS");
    const report = {
      run: "CHECKOUT" as const,
      network: ctx.network,
      started_utc: ctx.state.started_utc,
      finished_utc: new Date().toISOString(),
      result: passed ? ("PASS" as const) : ("FAIL" as const),
      steps: stepsOut,
    };
    const path = join(options.reportDir, `CHECKOUT-${utcStamp()}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    saveState(options.statePath, ctx.state);
    console.log(`report ${path} result=${report.result}`);
    return report;
  };
  try {
    await preflight(ctx);
    for (let i = 0; i < STEPS.length; i += 1) {
      const def = STEPS[i] as StepDef;
      const number = i + 1;
      const state = step(ctx.state, number);
      if (state.status === "PASS") continue;
      ctx.currentStep = number;
      await approve(
        ctx,
        number,
        def.name,
        `${def.name}${def.usd > 0 ? `\nYou will be asked to send about $${def.usd}; the runner never sends it for you.` : ""}`,
      );
      if (ctx.dryRun) continue;
      const planned = committedUsd(ctx, i) + def.usd;
      if (def.usd > 0 && planned > max) {
        throw new Error(`MAX_SPEND_USD ${max} would be exceeded (${planned} with this step)`);
      }
      try {
        await def.run(ctx, state);
        state.status = "PASS";
        delete state.error;
        console.log("  PASS");
      } catch (error) {
        state.status = "FAIL";
        state.error = redactString(error instanceof Error ? error.message : String(error));
        console.log(`  FAIL: ${state.error}`);
        throw error;
      }
      saveState(options.statePath, ctx.state);
    }
    if (!dryRun) {
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
    if (!dryRun) writeFinal();
    return 1;
  } finally {
    readline.close();
  }
}

const startedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (process.env.VITEST === undefined && startedDirectly) {
  runCheckout()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(redactString(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    });
}
