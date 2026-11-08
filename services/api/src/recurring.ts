/**
 * Recurring invoices (blueprint 4.5 H7): templates, the schedule, the HTTP handler and the
 * scheduler. Off-chain only: each run issues an ordinary invoice through `issue_for`; the
 * client pays it like any other invoice. A run is unique per (template, date), so a date is
 * never invoiced twice, even with two schedulers on one database.
 */
import { randomBytes } from "node:crypto";
import type { ApiResponse, InvoiceRecord } from "./app.js";

export type Repeat = "weekly" | "monthly" | "quarterly";
export type TemplateStatus = "active" | "paused" | "completed" | "cancelled";
export type RunStatus = "pending" | "issued" | "retrying" | "failed" | "skipped" | "unknown";

export interface TemplateInvoice {
  invoice_number_prefix: string;
  issuer_legal_name: string;
  debtor_legal_name: string;
  debtor_key: string;
  amount_usd: string;
  line_items: unknown[];
}

export interface RecurringTemplate {
  id: string;
  account_id: string;
  status: TemplateStatus;
  repeat: Repeat;
  start_date: string;
  end_date: string | null;
  count: number | null;
  due_days: number;
  send_email: boolean;
  email_to: string | null;
  invoice: TemplateInvoice;
  /** Index of the next scheduled date (0 = start_date). */
  next_index: number;
  issued_count: number;
  /** Set when a run needs the business to look (failed or unknown outcome). */
  attention: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecurringRun {
  template_id: string;
  run_date: string;
  status: RunStatus;
  attempts: number;
  invoice_id: string | null;
  error: string | null;
  updated_at: string;
}

export interface RecurringStore {
  get(id: string): RecurringTemplate | undefined;
  list(accountId?: string): RecurringTemplate[];
  save(template: RecurringTemplate): void;
  /** Inserts the run; false if (template_id, run_date) already exists. */
  insertRun(run: RecurringRun): boolean;
  /** Atomically moves a `retrying` run with `attempts` to `pending` (attempts + 1). */
  retryRun(templateId: string, runDate: string, attempts: number, updatedAt: string): boolean;
  updateRun(run: RecurringRun): void;
  getRun(templateId: string, runDate: string): RecurringRun | undefined;
  listRuns(templateId: string): RecurringRun[];
}

export const REPEATS: readonly Repeat[] = ["weekly", "monthly", "quarterly"];
export const ISSUE_HOUR_UTC = 6;
export const MAX_ATTEMPTS = 3;
export const GRACE_DAYS = 3;
/** A `pending` run older than this is treated as a crashed attempt, never re-issued. */
export const STALE_PENDING_MS = 10 * 60 * 1000;
const MAX_COUNT = 520;
const DAY_MS = 86_400_000;

// ---------- schedule ----------

function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined;
  return date;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addMonthsClamped(start: Date, months: number): Date {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay)));
}

/** The n-th scheduled date, always computed from the start date so month-end never drifts. */
export function runDate(
  template: Pick<RecurringTemplate, "start_date" | "repeat">,
  index: number,
): string {
  const start = parseDate(template.start_date);
  if (start === undefined) throw new Error("RECURRING_BAD_START_DATE");
  if (template.repeat === "weekly") return ymd(new Date(start.getTime() + index * 7 * DAY_MS));
  return ymd(addMonthsClamped(start, template.repeat === "monthly" ? index : index * 3));
}

/** Runs issue at 06:00 UTC on their date. */
export function issueAt(date: string): Date {
  return new Date(`${date}T${String(ISSUE_HOUR_UTC).padStart(2, "0")}:00:00Z`);
}

/** The date at `index`, or null when the template's end (count or end_date) is passed. */
export function scheduledDate(template: RecurringTemplate, index: number): string | null {
  if (template.count !== null && index >= template.count) return null;
  const date = runDate(template, index);
  if (template.end_date !== null && date > template.end_date) return null;
  return date;
}

export function nextRunDate(template: RecurringTemplate): string | null {
  if (template.status === "completed" || template.status === "cancelled") return null;
  return scheduledDate(template, template.next_index);
}

function addDays(date: string, days: number): string {
  return ymd(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS));
}

// ---------- validation ----------

class RecurringInputError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function bad(message: string): never {
  throw new RecurringInputError(400, "invalid_request", message);
}

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,}$/;
const PREFIX = /^[A-Za-z0-9_-]{1,32}$/;
const AMOUNT = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/;

function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    bad(`${field} required (1-${max} characters)`);
  }
  return value;
}

function amount(value: unknown): string {
  if (typeof value !== "string" || !AMOUNT.test(value) || Number(value) <= 0) {
    bad("invoice.amount_usd must be a positive amount with at most two decimals");
  }
  return Number(value).toFixed(2);
}

function optionalEnd(
  body: Record<string, unknown>,
  start: string,
): {
  end_date: string | null;
  count: number | null;
} {
  const end = body.end_date ?? null;
  const count = body.count ?? null;
  if (end !== null && count !== null) bad("give end_date or count, not both");
  if (end !== null) {
    if (typeof end !== "string" || parseDate(end) === undefined) bad("end_date must be YYYY-MM-DD");
    if (end < start) bad("end_date must be on or after start_date");
  }
  if (
    count !== null &&
    (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_COUNT)
  ) {
    bad(`count must be an integer from 1 to ${MAX_COUNT}`);
  }
  return { end_date: end as string | null, count: count as number | null };
}

function dueDays(value: unknown): number {
  if (value === undefined || value === null) return 14;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 365) {
    bad("due_days must be an integer from 0 to 365");
  }
  return value as number;
}

function email(sendEmail: unknown, to: unknown): { send_email: boolean; email_to: string | null } {
  const send = sendEmail === undefined ? false : sendEmail;
  if (typeof send !== "boolean") bad("send_email must be true or false");
  if (send) bad("email is not available yet: send_email must be false");
  if (to !== undefined && to !== null && (typeof to !== "string" || !EMAIL.test(to))) {
    bad("email_to must be an email address");
  }
  if (send && (to === undefined || to === null)) bad("email_to required when send_email is true");
  return { send_email: send, email_to: (to as string | undefined) ?? null };
}

function lineItems(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100)
    bad("invoice.line_items must be a list (max 100)");
  return value;
}

function parseCreate(
  raw: unknown,
  today: string,
): Omit<
  RecurringTemplate,
  | "id"
  | "account_id"
  | "status"
  | "next_index"
  | "issued_count"
  | "attention"
  | "created_at"
  | "updated_at"
> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    bad("JSON object body required");
  const body = raw as Record<string, unknown>;
  if (typeof body.repeat !== "string" || !REPEATS.includes(body.repeat as Repeat)) {
    bad("repeat must be weekly, monthly or quarterly");
  }
  if (typeof body.start_date !== "string" || parseDate(body.start_date) === undefined) {
    bad("start_date must be a real date, YYYY-MM-DD");
  }
  if (body.start_date < today) bad("start_date must be today or later (UTC)");
  const invoice = body.invoice;
  if (invoice === null || typeof invoice !== "object" || Array.isArray(invoice))
    bad("invoice required");
  const inv = invoice as Record<string, unknown>;
  if (typeof inv.invoice_number_prefix !== "string" || !PREFIX.test(inv.invoice_number_prefix)) {
    bad("invoice.invoice_number_prefix must be 1-32 letters, digits, - or _");
  }
  return {
    repeat: body.repeat as Repeat,
    start_date: body.start_date,
    ...optionalEnd(body, body.start_date),
    due_days: dueDays(body.due_days),
    ...email(body.send_email, body.email_to),
    invoice: {
      invoice_number_prefix: inv.invoice_number_prefix,
      issuer_legal_name: text(inv.issuer_legal_name, "invoice.issuer_legal_name"),
      debtor_legal_name: text(inv.debtor_legal_name, "invoice.debtor_legal_name"),
      debtor_key: text(inv.debtor_key, "invoice.debtor_key", 128),
      amount_usd: amount(inv.amount_usd),
      line_items: lineItems(inv.line_items),
    },
  };
}

const PATCHABLE = new Set([
  "status",
  "end_date",
  "count",
  "send_email",
  "email_to",
  "due_days",
  "invoice",
]);
const PATCHABLE_INVOICE = new Set(["amount_usd", "line_items"]);

function applyPatch(template: RecurringTemplate, raw: unknown, now: string): RecurringTemplate {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    bad("JSON object body required");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!PATCHABLE.has(key))
      throw new RecurringInputError(400, "immutable_field", `${key} cannot be changed`);
  }
  if (template.status === "completed" || template.status === "cancelled") {
    throw new RecurringInputError(409, "recurring_closed", `template is ${template.status}`);
  }
  const next: RecurringTemplate = {
    ...template,
    invoice: { ...template.invoice },
    updated_at: now,
  };
  if (body.status !== undefined) {
    if (!["active", "paused", "cancelled"].includes(body.status as string)) {
      bad("status must be active, paused or cancelled");
    }
    next.status = body.status as TemplateStatus;
  }
  if ("end_date" in body || "count" in body) {
    const merged = {
      end_date: "end_date" in body ? body.end_date : "count" in body ? null : template.end_date,
      count: "count" in body ? body.count : "end_date" in body ? null : template.count,
    };
    const end = optionalEnd(merged, template.start_date);
    if (end.count !== null && end.count < template.next_index) {
      bad(`count cannot be below the ${template.next_index} dates already scheduled`);
    }
    next.end_date = end.end_date;
    next.count = end.count;
  }
  if ("due_days" in body) next.due_days = dueDays(body.due_days);
  if ("send_email" in body || "email_to" in body) {
    Object.assign(
      next,
      email(
        "send_email" in body ? body.send_email : template.send_email,
        "email_to" in body ? body.email_to : template.email_to,
      ),
    );
  }
  if (body.invoice !== undefined) {
    if (body.invoice === null || typeof body.invoice !== "object" || Array.isArray(body.invoice)) {
      bad("invoice must be an object");
    }
    const inv = body.invoice as Record<string, unknown>;
    for (const key of Object.keys(inv)) {
      if (!PATCHABLE_INVOICE.has(key)) {
        throw new RecurringInputError(400, "immutable_field", `invoice.${key} cannot be changed`);
      }
    }
    if (inv.amount_usd !== undefined) next.invoice.amount_usd = amount(inv.amount_usd);
    if (inv.line_items !== undefined) next.invoice.line_items = lineItems(inv.line_items);
  }
  return next;
}

// ---------- HTTP ----------

export type RecurringView = RecurringTemplate & { next_run_date: string | null };

export function templateView(template: RecurringTemplate): RecurringTemplate & {
  next_run_date: string | null;
} {
  return { ...template, next_run_date: nextRunDate(template) };
}

export interface RecurringRequest {
  method: string;
  id: string | undefined;
  body: unknown;
  accountId: string;
  store: RecurringStore;
  clock: () => Date;
}

/** Handles `/v1/recurring_invoices[/:id]` after auth and scope checks. */
export function handleRecurring(request: RecurringRequest): ApiResponse {
  try {
    return route(request);
  } catch (error) {
    if (error instanceof RecurringInputError) {
      return {
        status: error.status,
        body: { error: { code: error.code, message: error.message } },
      };
    }
    throw error;
  }
}

function route({ method, id, body, accountId, store, clock }: RecurringRequest): ApiResponse {
  const now = clock().toISOString();
  if (id === undefined && method === "POST") {
    const parsed = parseCreate(body, now.slice(0, 10));
    const template: RecurringTemplate = {
      id: `rec_${randomBytes(9).toString("hex")}`,
      account_id: accountId,
      status: "active",
      ...parsed,
      next_index: 0,
      issued_count: 0,
      attention: null,
      created_at: now,
      updated_at: now,
    };
    store.save(template);
    return { status: 201, body: templateView(template) };
  }
  if (id === undefined && method === "GET") {
    return { status: 200, body: { data: store.list(accountId).map(templateView) } };
  }
  if (id === undefined) return notFound();
  const template = store.get(id);
  if (template === undefined || template.account_id !== accountId) {
    return {
      status: 404,
      body: { error: { code: "recurring_not_found", message: "recurring_not_found" } },
    };
  }
  if (method === "GET") {
    return { status: 200, body: { ...templateView(template), runs: store.listRuns(id) } };
  }
  if (method === "PATCH") {
    const next = applyPatch(template, body, now);
    store.save(next);
    return { status: 200, body: templateView(next) };
  }
  return notFound();
}

function notFound(): ApiResponse {
  return { status: 404, body: { error: { code: "not_found", message: "not_found" } } };
}

// ---------- scheduler ----------

export interface RecurringInvoiceBody {
  invoice_number: string;
  issuer_legal_name: string;
  debtor_legal_name: string;
  debtor_key: string;
  amount_usd: string;
  due_date: string;
  line_items: unknown[];
}

export interface RecurringSchedulerDeps {
  store: RecurringStore;
  issue: (
    accountId: string,
    body: RecurringInvoiceBody,
    recurringId: string,
  ) => Promise<InvoiceRecord>;
  /** Emails the pay link. Omitted when no mailer is configured (the run records `email: skipped`). */
  send?: (invoice: InvoiceRecord, to: string) => Promise<unknown>;
  clock?: () => Date;
  graceDays?: number;
  logger?: (message: string, data?: Record<string, unknown>) => void;
}

/** Builds the invoice for the run at `index`. Invoice numbers are `<prefix>-<NNN>`. */
export function invoiceForRun(
  template: RecurringTemplate,
  index: number,
  date: string,
): RecurringInvoiceBody {
  return {
    invoice_number: `${template.invoice.invoice_number_prefix}-${String(index + 1).padStart(3, "0")}`,
    issuer_legal_name: template.invoice.issuer_legal_name,
    debtor_legal_name: template.invoice.debtor_legal_name,
    debtor_key: template.invoice.debtor_key,
    amount_usd: template.invoice.amount_usd,
    due_date: addDays(date, template.due_days),
    line_items: template.invoice.line_items,
  };
}

export class RecurringScheduler {
  private readonly clock: () => Date;
  private readonly graceMs: number;
  private readonly log: (message: string, data?: Record<string, unknown>) => void;

  constructor(private readonly deps: RecurringSchedulerDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.graceMs = (deps.graceDays ?? GRACE_DAYS) * DAY_MS;
    this.log = deps.logger ?? (() => undefined);
  }

  /** One pass over every active template. Safe to call concurrently and repeatedly. */
  async runOnce(): Promise<void> {
    for (const template of this.deps.store.list()) {
      if (template.status !== "active") continue;
      try {
        await this.runTemplate(template.id);
      } catch (error) {
        this.log("recurring template pass failed", {
          template: template.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async runTemplate(id: string): Promise<void> {
    for (let guard = 0; guard < 64; guard += 1) {
      const template = this.deps.store.get(id);
      if (template === undefined || template.status !== "active") return;
      const index = template.next_index;
      const date = scheduledDate(template, index);
      if (date === null) {
        this.save(template, { status: "completed" });
        return;
      }
      const now = this.clock();
      const due = issueAt(date).getTime();
      if (due > now.getTime()) return;
      const stamp = now.toISOString();

      if (now.getTime() - due > this.graceMs) {
        const skipped: RecurringRun = {
          template_id: id,
          run_date: date,
          status: "skipped",
          attempts: 0,
          invoice_id: null,
          error: `more than ${this.graceMs / DAY_MS} days late`,
          updated_at: stamp,
        };
        if (!this.deps.store.insertRun(skipped)) {
          if (!this.settleExisting(template, date, stamp)) return;
          continue;
        }
        if (!this.advance(template, {})) return;
        continue;
      }

      const claimed = this.deps.store.insertRun({
        template_id: id,
        run_date: date,
        status: "pending",
        attempts: 1,
        invoice_id: null,
        error: null,
        updated_at: stamp,
      });
      let attempts = 1;
      if (!claimed) {
        const existing = this.deps.store.getRun(id, date);
        if (existing?.status !== "retrying") {
          if (!this.settleExisting(template, date, stamp)) return;
          continue;
        }
        if (!this.deps.store.retryRun(id, date, existing.attempts, stamp)) return;
        attempts = existing.attempts + 1;
      }
      await this.issue(template, index, date, attempts);
      // Loop: the next date may also be due (catch-up within the grace window).
    }
  }

  /** A run row already exists for `date`. Returns true when the template moved past it. */
  private settleExisting(template: RecurringTemplate, date: string, stamp: string): boolean {
    const run = this.deps.store.getRun(template.id, date);
    if (run === undefined) return false;
    if (run.status === "pending") {
      if (Date.parse(stamp) - Date.parse(run.updated_at) < STALE_PENDING_MS) return false;
      // A process claimed this date and stopped before recording the result. Issuing again
      // could bill the client twice, so mark it and let the business check.
      this.deps.store.updateRun({ ...run, status: "unknown", updated_at: stamp });
      return this.advance(template, {
        attention: `Run ${date}: outcome unknown after a restart. Check the invoice list before re-issuing by hand.`,
      });
    }
    if (run.status === "retrying") return false;
    return this.advance(template, run.status === "issued" ? { issuedDelta: 1 } : {});
  }

  private async issue(
    template: RecurringTemplate,
    index: number,
    date: string,
    attempts: number,
  ): Promise<void> {
    const body = invoiceForRun(template, index, date);
    let invoice: InvoiceRecord;
    try {
      invoice = await this.deps.issue(template.account_id, body, template.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const usernameMissing =
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "username_required";
      const final = usernameMissing || attempts >= MAX_ATTEMPTS;
      this.deps.store.updateRun({
        template_id: template.id,
        run_date: date,
        status: final ? "failed" : "retrying",
        attempts,
        invoice_id: null,
        error: message.slice(0, 300),
        updated_at: this.clock().toISOString(),
      });
      this.log("recurring issue failed", { template: template.id, date, attempts, final });
      if (final) {
        this.advance(template, {
          attention: `Run ${date}: not issued after ${attempts} attempts (${message.slice(0, 120)}).`,
        });
      }
      return;
    }
    let emailNote: string | null = null;
    if (template.send_email && template.email_to !== null) {
      if (this.deps.send === undefined) {
        emailNote = "email skipped: no mailer configured";
      } else {
        try {
          await this.deps.send(invoice, template.email_to);
        } catch (error) {
          emailNote =
            `email failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
        }
      }
    }
    this.deps.store.updateRun({
      template_id: template.id,
      run_date: date,
      status: "issued",
      attempts,
      invoice_id: invoice.id,
      error: emailNote,
      updated_at: this.clock().toISOString(),
    });
    this.log("recurring invoice issued", { template: template.id, date, invoice: invoice.id });
    this.advance(template, { issuedDelta: 1 });
  }

  /**
   * Moves the template to its next date. Re-reads the stored copy and gives up if another
   * scheduler already moved it, so a stale copy never overwrites newer progress.
   */
  private advance(
    template: RecurringTemplate,
    change: { issuedDelta?: number; attention?: string },
  ): boolean {
    const fresh = this.deps.store.get(template.id);
    if (fresh === undefined || fresh.next_index !== template.next_index) return false;
    const next: RecurringTemplate = {
      ...fresh,
      next_index: fresh.next_index + 1,
      issued_count: fresh.issued_count + (change.issuedDelta ?? 0),
      attention: change.attention ?? fresh.attention,
      updated_at: this.clock().toISOString(),
    };
    if (fresh.status === "active" && scheduledDate(next, next.next_index) === null) {
      next.status = "completed";
    }
    this.deps.store.save(next);
    return true;
  }

  private save(template: RecurringTemplate, change: Partial<RecurringTemplate>): void {
    this.deps.store.save({ ...template, ...change, updated_at: this.clock().toISOString() });
  }
}
