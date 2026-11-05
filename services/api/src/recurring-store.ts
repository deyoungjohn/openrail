/** Recurring-invoice storage: in-memory (tests, mock) and SQLite (shares the API database). */
import type { DatabaseSync } from "node:sqlite";
import type { RecurringRun, RecurringStore, RecurringTemplate } from "./recurring.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function runKey(templateId: string, runDate: string): string {
  return `${templateId}\u0000${runDate}`;
}

export function createMemoryRecurringStore(): RecurringStore {
  const templates = new Map<string, RecurringTemplate>();
  const runs = new Map<string, RecurringRun>();
  return {
    get: (id) => {
      const found = templates.get(id);
      return found === undefined ? undefined : clone(found);
    },
    list: (accountId) =>
      [...templates.values()]
        .filter((template) => accountId === undefined || template.account_id === accountId)
        .map(clone),
    save: (template) => {
      templates.set(template.id, clone(template));
    },
    insertRun: (run) => {
      const key = runKey(run.template_id, run.run_date);
      if (runs.has(key)) return false;
      runs.set(key, clone(run));
      return true;
    },
    retryRun: (templateId, runDate, attempts, updatedAt) => {
      const run = runs.get(runKey(templateId, runDate));
      if (run === undefined || run.status !== "retrying" || run.attempts !== attempts) return false;
      runs.set(runKey(templateId, runDate), {
        ...run,
        status: "pending",
        attempts: attempts + 1,
        updated_at: updatedAt,
      });
      return true;
    },
    updateRun: (run) => {
      runs.set(runKey(run.template_id, run.run_date), clone(run));
    },
    getRun: (templateId, runDate) => {
      const found = runs.get(runKey(templateId, runDate));
      return found === undefined ? undefined : clone(found);
    },
    listRuns: (templateId) =>
      [...runs.values()]
        .filter((run) => run.template_id === templateId)
        .sort((a, b) => a.run_date.localeCompare(b.run_date))
        .map(clone),
  };
}

export const RECURRING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS recurring_templates (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS recurring_templates_account ON recurring_templates (account_id);
  CREATE TABLE IF NOT EXISTS recurring_runs (template_id TEXT NOT NULL, run_date TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (template_id, run_date));
`;

export function createSqliteRecurringStore(db: DatabaseSync): RecurringStore {
  db.exec(RECURRING_SCHEMA);
  const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
  return {
    get(id) {
      const row = db.prepare("SELECT body FROM recurring_templates WHERE id = ?").get(id);
      return row === undefined ? undefined : parse<RecurringTemplate>(row.body);
    },
    list(accountId) {
      const rows =
        accountId === undefined
          ? db.prepare("SELECT body FROM recurring_templates ORDER BY id").all()
          : db
              .prepare("SELECT body FROM recurring_templates WHERE account_id = ? ORDER BY id")
              .all(accountId);
      return rows.map((row) => parse<RecurringTemplate>(row.body));
    },
    save(template) {
      db.prepare(
        "INSERT INTO recurring_templates (id, account_id, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      ).run(template.id, template.account_id, JSON.stringify(template));
    },
    insertRun(run) {
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO recurring_runs (template_id, run_date, status, attempts, body) VALUES (?, ?, ?, ?, ?)",
        )
        .run(run.template_id, run.run_date, run.status, run.attempts, JSON.stringify(run));
      return Number(result.changes) === 1;
    },
    retryRun(templateId, runDate, attempts, updatedAt) {
      const row = db
        .prepare("SELECT body FROM recurring_runs WHERE template_id = ? AND run_date = ?")
        .get(templateId, runDate);
      if (row === undefined) return false;
      const next: RecurringRun = {
        ...parse<RecurringRun>(row.body),
        status: "pending",
        attempts: attempts + 1,
        updated_at: updatedAt,
      };
      const result = db
        .prepare(
          "UPDATE recurring_runs SET status = 'pending', attempts = ?, body = ? WHERE template_id = ? AND run_date = ? AND status = 'retrying' AND attempts = ?",
        )
        .run(attempts + 1, JSON.stringify(next), templateId, runDate, attempts);
      return Number(result.changes) === 1;
    },
    updateRun(run) {
      db.prepare(
        "UPDATE recurring_runs SET status = ?, attempts = ?, body = ? WHERE template_id = ? AND run_date = ?",
      ).run(run.status, run.attempts, JSON.stringify(run), run.template_id, run.run_date);
    },
    getRun(templateId, runDate) {
      const row = db
        .prepare("SELECT body FROM recurring_runs WHERE template_id = ? AND run_date = ?")
        .get(templateId, runDate);
      return row === undefined ? undefined : parse<RecurringRun>(row.body);
    },
    listRuns(templateId) {
      return db
        .prepare("SELECT body FROM recurring_runs WHERE template_id = ? ORDER BY run_date")
        .all(templateId)
        .map((row) => parse<RecurringRun>(row.body));
    },
  };
}
