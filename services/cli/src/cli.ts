/** Hand-written argument parsing and command dispatch for `openrail`. */
import { ApiError, createClient, type FetchLike, type OpenrailClient } from "@openrail/api-client";
import { loadConfig, type CliConfig } from "./env.js";
import { CliError } from "./errors.js";
import { renderHuman } from "./output.js";

export const VERSION = "0.1.0";

export interface CliResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  fetchImpl?: FetchLike;
}

type Flags = Record<string, string | true>;

interface Parsed {
  positional: string[];
  flags: Flags;
}

const BOOLEAN_FLAGS = new Set(["json", "execute", "dry-run", "help", "version"]);

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[body] = true;
    } else {
      flags[body] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function requiredArg(positional: string[], index: number, what: string): string {
  const value = positional[index];
  if (value === undefined) throw new CliError("INVALID_ARGS", `missing ${what}`);
  return value;
}

function jsonData(flags: Flags): Record<string, unknown> | undefined {
  const raw = stringFlag(flags, "data");
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("data must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new CliError("INVALID_ARGS", `--data must be a JSON object: ${String(error)}`);
  }
}

function writeRequest(
  flags: Flags,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Record<string, unknown> {
  const idempotencyKey = stringFlag(flags, "idempotency-key");
  return {
    method,
    path,
    ...(body === undefined ? {} : { body }),
    ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
  };
}

function invoiceBody(flags: Flags): Record<string, unknown> {
  const data = jsonData(flags);
  if (data !== undefined) return data;
  const amount = stringFlag(flags, "amount-usd");
  return {
    invoice_number: stringFlag(flags, "invoice-number") ?? "INV-CLI",
    issuer_legal_name: stringFlag(flags, "issuer-legal-name") ?? "Openrail",
    debtor_legal_name: stringFlag(flags, "debtor-legal-name") ?? "Debtor",
    debtor_key: stringFlag(flags, "debtor-key") ?? "",
    amount_usd: amount ?? "0.00",
    due_date: stringFlag(flags, "due-date") ?? new Date().toISOString().slice(0, 10),
    line_items: [
      {
        description: stringFlag(flags, "description") ?? "Item",
        quantity: 1,
        unit_amount_usd: amount ?? "0.00",
      },
    ],
  };
}

function nearTransferCommand(config: CliConfig, quote: Record<string, unknown>): string {
  const account = config.nearAccountId ?? "<YOUR_NEAR_ACCOUNT>";
  const args = JSON.stringify({
    receiver_id: String(quote.deposit_address ?? ""),
    token_id: String(quote.source_asset ?? ""),
    amount: String(quote.amount ?? ""),
    msg: null,
  });
  return `near call intents.near mt_transfer '${args}' --accountId ${account}`;
}

async function dispatch(
  parsed: Parsed,
  config: CliConfig,
  client: OpenrailClient,
): Promise<unknown> {
  const { positional, flags } = parsed;
  const resource = positional[0];
  const action = positional[1];
  const dryRunDefault = !flags.execute;
  const idempotencyKey = stringFlag(flags, "idempotency-key");

  if (resource === "routes") return client.routes.list();

  if (resource === "auth" && action === "session") return client.auth.session();

  if (resource === "invoices") {
    if (action === "create") {
      const body = invoiceBody(flags);
      if (dryRunDefault)
        return { dry_run: true, request: writeRequest(flags, "POST", "/v1/invoices", body) };
      return client.invoices.create(body as never, { idempotencyKey });
    }
    if (action === "get") return client.invoices.get(requiredArg(positional, 2, "invoice id"));
    if (action === "list") {
      return client.invoices.list({
        ...(stringFlag(flags, "status") === undefined
          ? {}
          : { status: stringFlag(flags, "status") as never }),
        ...(stringFlag(flags, "limit") === undefined
          ? {}
          : { limit: Number(stringFlag(flags, "limit")) }),
        ...(stringFlag(flags, "cursor") === undefined
          ? {}
          : { cursor: stringFlag(flags, "cursor") }),
      });
    }
    if (action === "send") {
      const id = requiredArg(positional, 2, "invoice id");
      const body = {
        to: stringFlag(flags, "to") ?? "",
        ...(stringFlag(flags, "message") === undefined
          ? {}
          : { message: stringFlag(flags, "message") }),
      };
      if (dryRunDefault) {
        return {
          dry_run: true,
          request: writeRequest(flags, "POST", `/v1/invoices/${id}/send`, body),
        };
      }
      return client.invoices.send(id, body as never, { idempotencyKey });
    }
  }

  if (resource === "payments" && action === "get") {
    return client.payments.get(requiredArg(positional, 2, "payment id"));
  }

  if (resource === "receipts" && action === "list") {
    return client.receipts.list(requiredArg(positional, 2, "invoice id"));
  }

  if (resource === "webhooks") {
    if (action === "create") {
      const events = stringFlag(flags, "events");
      const body = jsonData(flags) ?? {
        url: stringFlag(flags, "url") ?? "",
        events:
          events === undefined
            ? []
            : events
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean),
      };
      if (dryRunDefault) {
        return {
          dry_run: true,
          request: writeRequest(flags, "POST", "/v1/webhook_endpoints", body),
        };
      }
      return client.webhookEndpoints.create(body as never, { idempotencyKey });
    }
    if (action === "list") return client.webhookEndpoints.list();
    if (action === "test") {
      const id = requiredArg(positional, 2, "webhook id");
      if (dryRunDefault) {
        return {
          dry_run: true,
          request: writeRequest(flags, "POST", `/v1/webhook_endpoints/${id}/test`),
        };
      }
      return client.webhookEndpoints.test(id, { idempotencyKey });
    }
    if (action === "deliveries") {
      return client.webhookEndpoints.deliveries(requiredArg(positional, 2, "webhook id"));
    }
  }

  if (resource === "keys") {
    if (action === "create") {
      const body = {
        name: stringFlag(flags, "name") ?? "CLI key",
        ...(stringFlag(flags, "scopes") === undefined
          ? {}
          : { scopes: (stringFlag(flags, "scopes") ?? "").split(",") }),
      };
      if (dryRunDefault) {
        return { dry_run: true, request: writeRequest(flags, "POST", "/v1/api_keys", body) };
      }
      return client.apiKeys.create(body as never, { idempotencyKey });
    }
    if (action === "list") return client.apiKeys.list();
    if (action === "rotate") {
      const id = requiredArg(positional, 2, "key id");
      if (dryRunDefault) {
        return { dry_run: true, request: writeRequest(flags, "POST", `/v1/api_keys/${id}/rotate`) };
      }
      return client.apiKeys.rotate(id, { idempotencyKey });
    }
    if (action === "revoke") {
      const id = requiredArg(positional, 2, "key id");
      if (dryRunDefault) {
        return { dry_run: true, request: writeRequest(flags, "DELETE", `/v1/api_keys/${id}`) };
      }
      return client.apiKeys.delete(id);
    }
  }

  if (resource === "statements") {
    return client.statements.get({
      ...(stringFlag(flags, "from") === undefined ? {} : { from: stringFlag(flags, "from") }),
      ...(stringFlag(flags, "to") === undefined ? {} : { to: stringFlag(flags, "to") }),
      ...(stringFlag(flags, "format") === undefined
        ? {}
        : { format: stringFlag(flags, "format") as "csv" | "pdf" }),
    });
  }

  if (resource === "cashout" && action === "quote") {
    const body = {
      amount: stringFlag(flags, "amount") ?? "0",
      destination_chain: stringFlag(flags, "destination-chain") ?? "base",
      address: stringFlag(flags, "address") ?? "",
    };
    const quote = (await client.cashout.quote(body as never, {
      idempotencyKey,
    })) as unknown as Record<string, unknown>;
    return { ...quote, near_cli: nearTransferCommand(config, quote) };
  }

  throw new CliError("INVALID_ARGS", `unknown command: ${positional.join(" ") || "(none)"}`);
}

const HELP = `openrail ${VERSION}

Usage: openrail [--json] [--api-url URL] [--execute] <resource> <action> [flags]

Resources:
  invoices create|get|list|send       Invoices (create/send dry-run by default)
  payments get                        Payment status
  receipts list <invoice-id>          Receipts
  routes                              Allow-listed pay routes
  webhooks create|list|test|deliveries
  keys create|list|rotate|revoke      API keys
  statements [--from --to --format]   Statement envelope
  cashout quote --amount --destination-chain --address
  auth session                        Current dashboard session

Global flags:
  --json                 Machine-readable JSON (also on errors)
  --api-url URL          Override OPENRAIL_API_URL
  --idempotency-key KEY  Idempotency-Key for writes
  --execute              Send a write (default is dry-run)
  --dry-run              Explicit dry-run
  --help, --version

Env: OPENRAIL_API_URL, OPENRAIL_API_KEY (never printed), NEAR_ACCOUNT_ID (optional).
Exit codes: 0 success, 1 API/HTTP error, 2 usage or missing env.
`;

export async function runCli(argv: string[], options: CliOptions = {}): Promise<CliResult> {
  let json = false;
  try {
    const parsed = parse(argv);
    json = parsed.flags.json === true;
    if (parsed.flags.help === true) return { exitCode: 0, stdout: HELP, stderr: "" };
    if (parsed.flags.version === true) return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
    const config = loadConfig(stringFlag(parsed.flags, "api-url"));
    const client = createClient({
      baseUrl: config.apiUrl,
      apiKey: config.apiKey,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      credentials: "include",
    });
    const result = await dispatch(parsed, config, client);
    return {
      exitCode: 0,
      stdout: json ? `${JSON.stringify(result, null, 2)}\n` : renderHuman(result),
      stderr: "",
    };
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : error instanceof ApiError
          ? new CliError("API_ERROR", error.message, 1, {
              status: error.status,
              code: error.code,
              ...(error.rule === undefined ? {} : { rule: error.rule }),
            })
          : new CliError(
              "INTERNAL_ERROR",
              error instanceof Error ? error.message : String(error),
              1,
            );
    const body = {
      error: {
        code: cliError.code,
        message: cliError.message,
        ...(cliError.details === undefined ? {} : { details: cliError.details }),
      },
    };
    return {
      exitCode: cliError.exitCode,
      stdout: "",
      stderr: json ? `${JSON.stringify(body)}\n` : `${cliError.message}\n`,
    };
  }
}
