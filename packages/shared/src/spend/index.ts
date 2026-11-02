/**
 * Spend guard (blueprint 3.5, AGENTS rule 2).
 *
 * Dry run by default. A value move needs OWED_CONFIRM_MAINNET=yes, a total
 * within MAX_SPEND_USD, and the typed confirmation `YES`. The agent never sets
 * the mainnet flag; the human-run T2 script does.
 */
import { createInterface } from "node:readline";
import { confirmMainnet, isDryRun, requireEnv } from "../env/index.js";

const DEFAULT_CAP_USD = 5;

export type SpendStatus = "DRY_RUN" | "SENT";

export interface SpendRunRequest<T> {
  usd: number;
  confirmation: string;
  execute?: () => Promise<T>;
}

export interface SpendRunResult<T> {
  status: SpendStatus;
  totalUsd: number;
  value?: T;
}

function parseCap(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("SPEND_CAP_INVALID: MAX_SPEND_USD must be a non-negative number");
  }
  return value;
}

/**
 * The cap. Dry runs may use the spike default; a live run fails closed when
 * MAX_SPEND_USD is missing (`MISSING_ENV: MAX_SPEND_USD`).
 */
export function maxSpendUsd(): number {
  const raw = process.env.MAX_SPEND_USD;
  if (raw === undefined || raw.trim() === "") {
    return isDryRun() ? DEFAULT_CAP_USD : parseCap(requireEnv("MAX_SPEND_USD"));
  }
  return parseCap(raw);
}

export class SpendGuard {
  private total = 0;

  /** Running total of planned value in USD. */
  totalUsd(): number {
    return this.total;
  }

  /** True unless DRY_RUN is explicitly no/false/0. */
  isDryRun(): boolean {
    return isDryRun();
  }

  /** Add to the running total, refusing (without mutating it) above the cap. */
  plan(usd: number): number {
    if (!Number.isFinite(usd) || usd < 0) {
      throw new Error("SPEND_INVALID_AMOUNT: plan needs a non-negative finite number");
    }
    const next = this.total + usd;
    const cap = maxSpendUsd();
    if (next > cap) {
      throw new Error(
        `SPEND_CAP_EXCEEDED: planned ${next.toFixed(2)} USD over MAX_SPEND_USD ${cap.toFixed(2)}`,
      );
    }
    this.total = next;
    return next;
  }

  /** Both gates, in the order the human sees them: mainnet flag, then typed YES. */
  authorize(confirmation: string): void {
    if (!confirmMainnet()) {
      throw new Error("MAINNET_NOT_CONFIRMED: OWED_CONFIRM_MAINNET is not yes (human-run T2 only)");
    }
    if (confirmation !== "YES") {
      throw new Error("MAINNET_CONFIRMATION_REQUIRED: type YES to confirm a value move");
    }
  }

  /**
   * Plan and, when live, execute. In a dry run the executor is never called.
   * The typed confirmation is required only for a live move.
   */
  async run<T>(request: SpendRunRequest<T>): Promise<SpendRunResult<T>> {
    if (this.isDryRun()) {
      const totalUsd = this.plan(request.usd);
      return { status: "DRY_RUN", totalUsd };
    }

    this.authorize(request.confirmation);
    const totalUsd = this.plan(request.usd);
    if (typeof request.execute !== "function") {
      throw new Error("SEND_NOT_WIRED: no executor; only the human T2 run supplies one");
    }
    const value = await request.execute();
    return { status: "SENT", totalUsd, value };
  }
}

export interface PromptStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
}

/** Ask for the typed confirmation on a real terminal; never in CI or a pipe. */
export async function promptYes(
  question: string,
  streams: PromptStreams = { input: process.stdin, output: process.stdout },
): Promise<string> {
  if (streams.input.isTTY !== true || streams.output.isTTY !== true) {
    throw new Error("PROMPT_NOT_A_TTY: refusing to ask for YES without a terminal");
  }
  const readline = createInterface({ input: streams.input, output: streams.output });
  try {
    return await new Promise<string>((resolve, reject) => {
      readline.question(`${question} `, (answer) => resolve(answer.trim()));
      readline.once("error", reject);
    });
  } finally {
    readline.close();
  }
}
