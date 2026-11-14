/**
 * Openrail MCP Server (`services/mcp`)
 *
 * Exposes Model Context Protocol (MCP) tools over the public Openrail API.
 *
 * Invariants:
 * - Holds no private keys and never signs or broadcasts transactions.
 * - Value-moving operations (`prepare_invoice`, or module tools that prepare transactions)
 *   return an unsigned transaction payload (`unsigned_tx`) and a human approval URL (`approval_url`).
 * - Tools come only from enabled parts (core + enabled modules passed via `enabled.ts` / `moduleTools`).
 *   Core and `services/mcp` never name any optional module.
 * - Read-only tools are cached in-process for 30s (`cacheTtlMs`) and bounded by a per-minute
 *   rate limit (`maxCallsPerMinute`) so an agent loop cannot flood the API or strain RPC.
 */

import { createInterface } from "node:readline";
import { OpenrailClient, type FetchLike } from "@openrail/api-client";
import { getEnv, redact, requireEnv } from "@openrail/shared";
import { enabledModules as generatedEnabledModules, type EnabledModule } from "./enabled.js";

export interface McpToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpToolSchema;
  /** Optional flag indicating whether a module tool is read-only (eligible for 30s cache). */
  readOnly?: boolean;
  /** Handler for module-contributed tools. */
  handler?: (args: Record<string, unknown>, api: ApiClientPort) => Promise<unknown>;
}

export interface ApiClientPort {
  listClaims?(params?: Record<string, unknown>): Promise<unknown>;
  claimStatus?(tokenId: string): Promise<unknown>;
  receipt?(tokenId: string): Promise<unknown>;
  quotePayLink?(params: {
    tokenId: string;
    amountUsd?: string;
    routeId?: string;
    refundTo?: string;
  }): Promise<unknown>;
  prepareInvoice?(params: Record<string, unknown>): Promise<unknown>;
  [key: string]: unknown;
}

export interface McpServerConfig {
  api: ApiClientPort;
  enabledModules?: string[];
  moduleTools?: Record<string, McpToolDefinition[]>;
  /** In-process read cache TTL in milliseconds (default: 30_000 ms). */
  cacheTtlMs?: number;
  /** Maximum tool invocations per 60-second window (default: 60). */
  maxCallsPerMinute?: number;
  /** Injectable clock for deterministic testing of cache and rate limit. */
  clock?: () => number;
  /** Rejects any secret / signing key material passed to the MCP server. */
  privateKey?: unknown;
  secretKey?: unknown;
  signer?: unknown;
  mnemonic?: unknown;
  seedPhrase?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpServerHealth {
  ok: boolean;
  api_calls_total: number;
  cache_hits_total: number;
  rate_limited_total: number;
  cache_entries: number;
  window_calls: number;
  max_calls_per_minute: number;
  cache_ttl_ms: number;
}

export interface McpToolCallResult {
  unsigned_tx?: {
    receiver_id: string;
    actions: Record<string, unknown>[];
  };
  approval_url?: string;
  human_signature_required?: boolean;
  signature?: unknown;
  tx_hash?: unknown;
  broadcasted?: unknown;
  pay_url?: string;
  payUrl?: string;
  amount_due?: string;
  amount_usd?: string;
  outstanding?: string;
  quote_id?: string;
  deposit_address?: string;
  claims?: Record<string, unknown>[];
  token_id?: string;
  status?: string;
  [key: string]: unknown;
}

export interface McpServerInstance {
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
  handleRpc(request: JsonRpcRequest): Promise<JsonRpcResponse | null>;
  health(): McpServerHealth;
  clearCache(): void;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_CALLS_PER_MINUTE = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

const READ_ONLY_CORE_TOOLS = new Set(["list_claims", "claim_status", "receipt"]);

/**
 * Extracts `mcpTools` from each enabled module entry (`enabled.ts` pattern).
 * Only tools that declare a real `handler` function are collected when extracted from a module export.
 */
export function mcpModulesFrom(
  entries: readonly EnabledModule[],
): Record<string, McpToolDefinition[]> {
  const out: Record<string, McpToolDefinition[]> = {};
  for (const entry of entries) {
    const candidate = (entry.module as { mcpTools?: unknown } | null)?.mcpTools;
    if (!Array.isArray(candidate)) continue;
    const valid = candidate.filter(
      (t): t is McpToolDefinition =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as McpToolDefinition).name === "string" &&
        typeof (t as McpToolDefinition).description === "string" &&
        typeof (t as McpToolDefinition).inputSchema === "object" &&
        (t as McpToolDefinition).inputSchema !== null &&
        typeof (t as McpToolDefinition).handler === "function",
    );
    if (valid.length > 0) {
      out[entry.id] = valid;
    }
  }
  return out;
}

function usdToBaseUnits(amountUsd: string): string {
  const trimmed = amountUsd.trim();
  if (/^\d+$/.test(trimmed) && trimmed.length > 6) {
    return trimmed;
  }
  const [wholeRaw = "0", fracRaw = ""] = trimmed.split(".");
  const whole = BigInt(wholeRaw.replace(/[^0-9]/g, "") || "0");
  const frac = BigInt(
    fracRaw
      .replace(/[^0-9]/g, "")
      .padEnd(6, "0")
      .slice(0, 6),
  );
  return (whole * 1_000_000n + frac).toString();
}

function baseUnitsToUsd(amountBase: string): string {
  const raw = amountBase.trim();
  if (raw.includes(".")) return raw;
  try {
    const n = BigInt(raw);
    const whole = n / 1_000_000n;
    const cents = ((n % 1_000_000n) / 10_000n).toString().padStart(2, "0");
    return `${whole.toString()}.${cents}`;
  } catch {
    return "0.00";
  }
}

export interface HttpApiClientOptions {
  baseUrl: string;
  apiKey?: string;
  webBaseUrl?: string;
  rootContract?: string;
  fetchImpl?: FetchLike;
}

/**
 * Adapter from `@openrail/api-client` (`OpenrailClient`) to `ApiClientPort`.
 * Connects the MCP server to the live or mock HTTP public API while guaranteeing
 * that `prepare_invoice` never signs or broadcasts a transaction on-chain.
 */
export function createHttpApiClient(options: HttpApiClientOptions): ApiClientPort {
  const client = new OpenrailClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    credentials: "omit",
  });
  const webBase = (options.webBaseUrl ?? options.baseUrl).replace(/\/+$/, "");
  const rootContract = options.rootContract ?? "openrail.near";

  return {
    async listClaims(params?: Record<string, unknown>) {
      const limit =
        typeof params?.limit === "number" && Number.isFinite(params.limit)
          ? params.limit
          : undefined;
      const status = typeof params?.status === "string" ? params.status : undefined;
      const response = await client.invoices.list({
        ...(limit !== undefined ? { limit } : {}),
        ...(status !== undefined ? { status: status as never } : {}),
      });
      const invoices = Array.isArray((response as { data?: unknown[] })?.data)
        ? ((response as unknown as { data: Record<string, unknown>[] }).data ?? [])
        : [];
      const debtorFilter =
        typeof params?.debtor === "string" ? params.debtor.toLowerCase() : undefined;
      const filtered =
        debtorFilter === undefined
          ? invoices
          : invoices.filter((inv) => {
              const legal = String(inv.debtor_legal_name ?? "").toLowerCase();
              return legal.includes(debtorFilter);
            });
      return {
        claims: filtered.map((inv) => ({
          id: String(inv.token_id ?? inv.id ?? ""),
          invoice_id: String(inv.id ?? ""),
          invoice_number: String(inv.invoice_number ?? ""),
          amount_due: String(inv.amount_due ?? "0"),
          amount_usd: String(inv.amount_usd ?? "0.00"),
          outstanding: String(inv.outstanding ?? inv.amount_due ?? "0"),
          status: String(inv.status ?? "Open"),
          debtor: String(inv.debtor_legal_name ?? ""),
          due_date: String(inv.due_date ?? ""),
          pay_link: String(inv.pay_link ?? ""),
        })),
      };
    },

    async claimStatus(tokenId: string) {
      const claim = (await client.pay.getClaim(tokenId)) as unknown as Record<string, unknown>;
      return {
        token_id: String(claim.token_id ?? tokenId),
        invoice_number: claim.invoice_number,
        status: String(claim.status ?? "Open"),
        amount_due: String(claim.amount_due ?? "0"),
        amount_usd: String(claim.amount_usd ?? "0.00"),
        outstanding: String(claim.outstanding ?? claim.amount_due ?? "0"),
        booked_total: String(
          BigInt(String(claim.amount_due ?? "0")) -
            BigInt(String(claim.outstanding ?? claim.amount_due ?? "0")),
        ),
        due_date: claim.due_date,
        pay_link: claim.pay_link,
      };
    },

    async receipt(tokenId: string) {
      try {
        const listResp = (await client.receipts.list(tokenId)) as unknown as {
          data?: Record<string, unknown>[];
        };
        const items = Array.isArray(listResp?.data) ? listResp.data : [];
        const txHashes = items
          .map((item) => String(item.booking_tx_hash ?? item.tx_hash ?? item.id ?? ""))
          .filter(Boolean);
        return {
          token_id: tokenId,
          receipt_url: `${webBase}/receipt/${encodeURIComponent(tokenId)}`,
          receipts: items,
          tx_hashes: txHashes,
        };
      } catch {
        const pub = (await client.receipts.getPublic(tokenId)) as unknown as Record<
          string,
          unknown
        >;
        const bookingTx = String(pub.booking_tx_hash ?? tokenId);
        return {
          token_id: String(pub.token_id ?? tokenId),
          receipt_url: `${webBase}/receipt/${encodeURIComponent(bookingTx)}`,
          receipt: pub,
          tx_hashes: [bookingTx],
        };
      }
    },

    async quotePayLink(params: {
      tokenId: string;
      amountUsd?: string;
      routeId?: string;
      refundTo?: string;
    }) {
      const claim = (await client.pay.getClaim(params.tokenId)) as unknown as Record<
        string,
        unknown
      >;
      const payUrl =
        typeof claim.pay_link === "string" && claim.pay_link !== ""
          ? claim.pay_link
          : `${webBase}/c/${encodeURIComponent(params.tokenId)}`;
      const claimAmountDue = String(claim.amount_due ?? "0");
      const claimAmountUsd =
        typeof claim.amount_usd === "string" && claim.amount_usd !== ""
          ? claim.amount_usd
          : baseUnitsToUsd(claimAmountDue);
      const claimOutstanding = String(claim.outstanding ?? claimAmountDue);

      // When routeId and refundTo are provided, request a real 1Click quote via POST /v1/pay/sessions
      if (
        typeof params.routeId === "string" &&
        params.routeId !== "" &&
        typeof params.refundTo === "string" &&
        params.refundTo !== ""
      ) {
        const session = (await client.pay.createSession({
          token_id: params.tokenId,
          route_id: params.routeId,
          refund_to: params.refundTo,
          ...(params.amountUsd !== undefined ? { amount_usd: params.amountUsd } : {}),
        })) as unknown as Record<string, unknown>;
        return {
          token_id: String(session.token_id ?? params.tokenId),
          pay_url: payUrl,
          payUrl,
          amount_due: claimAmountDue,
          amount_usd: claimAmountUsd,
          outstanding: claimOutstanding,
          quote_id: String(session.quote_id ?? ""),
          deposit_address: String(session.deposit_address ?? ""),
          deadline: String(session.deadline ?? ""),
        };
      }

      // Otherwise return the claim's hosted pay link and the claim's own recorded amount due
      return {
        token_id: String(claim.token_id ?? params.tokenId),
        pay_url: payUrl,
        payUrl,
        amount_due: claimAmountDue,
        amount_usd: claimAmountUsd,
        outstanding: claimOutstanding,
      };
    },

    async prepareInvoice(params: Record<string, unknown>) {
      const debtor = String(params.debtor ?? "");
      const rawAmount = String(params.amountDue ?? params.amountUsd ?? "0");
      const amountDue = rawAmount.includes(".") ? usdToBaseUnits(rawAmount) : rawAmount;
      const amountUsd = rawAmount.includes(".") ? rawAmount : baseUnitsToUsd(rawAmount);
      const dueDate =
        typeof params.dueDate === "number"
          ? params.dueDate
          : Math.floor(Date.now() / 1000) + 86_400;

      const unsignedTx = {
        receiver_id: rootContract,
        actions: [
          {
            type: "FunctionCall" as const,
            method_name: "issue_for",
            args: {
              debtor,
              amount_due: amountDue,
              due_date: dueDate,
            },
            deposit: "1",
            gas: "30000000000000",
          },
        ],
      };
      const query = new URLSearchParams({
        debtor,
        amount_usd: amountUsd,
        amount_due: amountDue,
        due_date: String(dueDate),
      });
      return {
        unsigned_tx: unsignedTx,
        approval_url: `${webBase}/app/issue?${query.toString()}`,
        human_signature_required: true as const,
      };
    },
  };
}

/**
 * Fake API client for deterministic testing and the runnable README example.
 * Holds realistic fixture claims, receipts, pay links, and unsigned invoice payloads.
 */
export function createFakeApiClient(): ApiClientPort {
  const claimFixtures: Record<
    string,
    {
      id: string;
      amount_due: string;
      amount_usd: string;
      outstanding: string;
      booked_total: string;
      status: string;
      debtor: string;
      due_date: string;
      pay_link: string;
    }
  > = {
    "c-1": {
      id: "c-1",
      amount_due: "50000000",
      amount_usd: "50.00",
      outstanding: "50000000",
      booked_total: "0",
      status: "Open",
      debtor: "bob.near",
      due_date: "2026-11-01",
      pay_link: "https://openrail.incepture.dev/c/c-1",
    },
    "c-2": {
      id: "c-2",
      amount_due: "100000000",
      amount_usd: "100.00",
      outstanding: "0",
      booked_total: "100000000",
      status: "Paid",
      debtor: "alice.near",
      due_date: "2026-10-15",
      pay_link: "https://openrail.incepture.dev/c/c-2",
    },
  };

  return {
    listClaims: async (params?: Record<string, unknown>) => {
      let filtered = Object.values(claimFixtures);
      if (typeof params?.status === "string" && params.status !== "") {
        filtered = filtered.filter(
          (c) => c.status.toLowerCase() === String(params.status).toLowerCase(),
        );
      }
      if (typeof params?.limit === "number" && Number.isFinite(params.limit)) {
        filtered = filtered.slice(0, Math.max(0, params.limit));
      }
      return { claims: filtered };
    },
    claimStatus: async (tokenId: string) => {
      const claim = claimFixtures[tokenId] ?? {
        id: tokenId,
        amount_due: "50000000",
        amount_usd: "50.00",
        outstanding: "50000000",
        booked_total: "0",
        status: "Open",
        debtor: "bob.near",
        due_date: "2026-11-01",
        pay_link: `https://openrail.incepture.dev/c/${tokenId}`,
      };
      return {
        token_id: claim.id,
        status: claim.status,
        booked_total: claim.booked_total,
        amount_due: claim.amount_due,
        amount_usd: claim.amount_usd,
        outstanding: claim.outstanding,
        debtor: claim.debtor,
      };
    },
    receipt: async (tokenId: string) => ({
      token_id: tokenId,
      receipt_url: `https://openrail.incepture.dev/receipt/${tokenId}`,
      tx_hashes: ["near_tx_123456"],
    }),
    quotePayLink: async (params) => {
      const claim = claimFixtures[params.tokenId] ?? {
        id: params.tokenId,
        amount_due: "50000000",
        amount_usd: "50.00",
        outstanding: "50000000",
        pay_link: `https://openrail.incepture.dev/c/${params.tokenId}`,
      };
      return {
        token_id: claim.id,
        pay_url: claim.pay_link,
        payUrl: claim.pay_link,
        amount_due: claim.amount_due,
        amount_usd: claim.amount_usd,
        outstanding: claim.outstanding,
      };
    },
    prepareInvoice: async (params) => ({
      unsigned_tx: {
        receiver_id: "openrail.near",
        actions: [
          {
            type: "FunctionCall",
            method_name: "issue_for",
            args: {
              debtor: params.debtor ?? "bob.near",
              amount_due: params.amountDue ?? "50000000",
              ...(params.dueDate !== undefined ? { due_date: params.dueDate } : {}),
            },
            deposit: "1",
            gas: "30000000000000",
          },
        ],
      },
      approval_url: "https://openrail.incepture.dev/approve?tx=unsigned_payload_123",
      human_signature_required: true,
    }),
  };
}

function rejectPrivateKeys(config: McpServerConfig): void {
  const forbiddenKeys = [
    "privateKey",
    "private_key",
    "secretKey",
    "secret_key",
    "signer",
    "mnemonic",
    "seedPhrase",
    "seed_phrase",
  ];
  const record = config as unknown as Record<string, unknown>;
  for (const key of forbiddenKeys) {
    if (key in record && record[key] !== undefined && record[key] !== null) {
      throw new Error("MCP server must never hold private keys or sign transactions");
    }
  }
}

function stableCacheKey(toolName: string, args: Record<string, unknown>): string {
  const sortedEntries = Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${toolName}:${JSON.stringify(sortedEntries)}`;
}

function assertUnsignedResult(toolName: string, result: unknown): void {
  if (result === null || typeof result !== "object") {
    throw new Error(`${toolName} must return an unsigned transaction envelope`);
  }
  const res = result as Record<string, unknown>;
  if ("signature" in res && res.signature !== undefined) {
    throw new Error(`${toolName} must never sign transactions`);
  }
  if ("tx_hash" in res && res.tx_hash !== undefined) {
    throw new Error(`${toolName} must never broadcast transactions`);
  }
  if ("broadcasted" in res && res.broadcasted !== undefined) {
    throw new Error(`${toolName} must never broadcast transactions`);
  }
  if (!res.unsigned_tx || typeof res.unsigned_tx !== "object") {
    throw new Error(`${toolName} must include unsigned_tx`);
  }
  if (typeof res.approval_url !== "string" || !res.approval_url.startsWith("https://")) {
    throw new Error(`${toolName} must include an https:// approval_url for the human`);
  }
  if (res.human_signature_required !== true) {
    throw new Error(`${toolName} must set human_signature_required: true`);
  }
}

export function createMcpServer(config: McpServerConfig): McpServerInstance {
  rejectPrivateKeys(config);

  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxCallsPerMinute = config.maxCallsPerMinute ?? DEFAULT_MAX_CALLS_PER_MINUTE;
  const clock = config.clock ?? (() => Date.now());

  const cache = new Map<string, { value: unknown; expiresAt: number }>();
  const callTimestamps: number[] = [];

  let apiCallsTotal = 0;
  let cacheHitsTotal = 0;
  let rateLimitedTotal = 0;

  const coreTools: McpToolDefinition[] = [
    {
      name: "list_claims",
      description: "List claims managed by Openrail",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum number of claims to return" },
          status: { type: "string", description: "Filter by claim status (Open, Paid)" },
        },
      },
    },
    {
      name: "claim_status",
      description: "Get current settlement and payment status of a claim",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          tokenId: { type: "string", description: "Unique claim token ID (e.g. c-1)" },
        },
        required: ["tokenId"],
      },
    },
    {
      name: "receipt",
      description: "Retrieve payment receipt and settlement proof for a claim",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          tokenId: { type: "string", description: "Unique claim token ID (e.g. c-1)" },
        },
        required: ["tokenId"],
      },
    },
    {
      name: "quote_pay_link",
      description:
        "Return the payment link and recorded amount due for a claim (or create a quote session when routeId and refundTo are given)",
      readOnly: false,
      inputSchema: {
        type: "object",
        properties: {
          tokenId: { type: "string", description: "Unique claim token ID" },
          amountUsd: { type: "string", description: "Amount in USD" },
          routeId: {
            type: "string",
            description: "Optional payment route ID for a live quote session",
          },
          refundTo: {
            type: "string",
            description: "Optional payer refund address for a live quote session",
          },
        },
        required: ["tokenId", "amountUsd"],
      },
    },
    {
      name: "prepare_invoice",
      description:
        "Prepare an invoice creation transaction. Returns an unsigned transaction and an approval link for the human to review and sign.",
      readOnly: false,
      inputSchema: {
        type: "object",
        properties: {
          debtor: { type: "string", description: "Debtor account or address" },
          amountDue: { type: "string", description: "Amount due in base units" },
          dueDate: { type: "number", description: "Unix timestamp for payment due date" },
        },
        required: ["debtor", "amountDue"],
      },
    },
  ];

  function resolveEnabledTools(): Map<string, McpToolDefinition> {
    const map = new Map<string, McpToolDefinition>();
    for (const tool of coreTools) {
      map.set(tool.name, tool);
    }
    if (config.enabledModules && config.moduleTools) {
      for (const modId of config.enabledModules) {
        const modTools = config.moduleTools[modId];
        if (Array.isArray(modTools)) {
          for (const tool of modTools) {
            map.set(tool.name, tool);
          }
        }
      }
    }
    return map;
  }

  function enforceRateLimit(now: number): void {
    while (callTimestamps.length > 0 && (callTimestamps[0] ?? 0) <= now - RATE_LIMIT_WINDOW_MS) {
      callTimestamps.shift();
    }
    if (callTimestamps.length >= maxCallsPerMinute) {
      rateLimitedTotal += 1;
      throw new Error(
        `MCP rate limit exceeded: maximum ${maxCallsPerMinute} tool calls per minute`,
      );
    }
    callTimestamps.push(now);
  }

  async function executeTool(
    tool: McpToolDefinition,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const name = tool.name;
    if (name === "list_claims") {
      if (typeof config.api.listClaims !== "function") {
        throw new Error("API client does not support list_claims");
      }
      return config.api.listClaims(args);
    }
    if (name === "claim_status") {
      if (typeof config.api.claimStatus !== "function") {
        throw new Error("API client does not support claim_status");
      }
      return config.api.claimStatus(String(args.tokenId ?? ""));
    }
    if (name === "receipt") {
      if (typeof config.api.receipt !== "function") {
        throw new Error("API client does not support receipt");
      }
      return config.api.receipt(String(args.tokenId ?? ""));
    }
    if (name === "quote_pay_link") {
      if (typeof config.api.quotePayLink !== "function") {
        throw new Error("API client does not support quote_pay_link");
      }
      return config.api.quotePayLink({
        tokenId: String(args.tokenId ?? ""),
        amountUsd: typeof args.amountUsd === "string" ? args.amountUsd : undefined,
        routeId: typeof args.routeId === "string" ? args.routeId : undefined,
        refundTo: typeof args.refundTo === "string" ? args.refundTo : undefined,
      });
    }
    if (name === "prepare_invoice") {
      if (typeof config.api.prepareInvoice !== "function") {
        throw new Error("API client does not support prepare_invoice");
      }
      const prepared = await config.api.prepareInvoice(args);
      assertUnsignedResult("prepare_invoice", prepared);
      return prepared;
    }
    if (typeof tool.handler === "function") {
      return tool.handler(args, config.api);
    }
    const candidateFn = config.api[name];
    if (typeof candidateFn === "function") {
      return (candidateFn as (a: Record<string, unknown>) => Promise<unknown>)(args);
    }
    throw new Error(`No handler registered for tool: ${name}`);
  }

  const server: McpServerInstance = {
    async listTools(): Promise<McpToolDefinition[]> {
      return [...resolveEnabledTools().values()].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
    },

    async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
      const enabledMap = resolveEnabledTools();
      const tool = enabledMap.get(name);
      if (!tool) {
        throw new Error(`Unknown or disabled tool: ${name}`);
      }

      if (tool.inputSchema.required) {
        for (const reqKey of tool.inputSchema.required) {
          if (args[reqKey] === undefined || args[reqKey] === null || args[reqKey] === "") {
            throw new Error(`Missing required argument "${reqKey}" for tool "${name}"`);
          }
        }
      }

      const now = clock();
      enforceRateLimit(now);

      const isReadOnly = READ_ONLY_CORE_TOOLS.has(name) || tool.readOnly === true;
      if (isReadOnly && cacheTtlMs > 0) {
        const key = stableCacheKey(name, args);
        const cached = cache.get(key);
        if (cached !== undefined && cached.expiresAt > now) {
          cacheHitsTotal += 1;
          return structuredClone(cached.value) as McpToolCallResult;
        }
        apiCallsTotal += 1;
        const fresh = (await executeTool(tool, args)) as McpToolCallResult;
        cache.set(key, { value: structuredClone(fresh), expiresAt: now + cacheTtlMs });
        return fresh;
      }

      apiCallsTotal += 1;
      return (await executeTool(tool, args)) as McpToolCallResult;
    },

    async handleRpc(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      const id = request.id ?? null;
      const isNotification = request.id === undefined;

      try {
        if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32600, message: "Invalid Request" },
          };
        }

        if (request.method === "notifications/initialized") {
          return null;
        }

        if (request.method === "ping") {
          return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
        }

        if (request.method === "initialize") {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "openrail-mcp", version: "0.1.0" },
            },
          };
        }

        if (request.method === "tools/list") {
          const tools = await server.listTools();
          return {
            jsonrpc: "2.0",
            id,
            result: { tools },
          };
        }

        if (request.method === "tools/call") {
          const params = request.params ?? {};
          const toolName = typeof params.name === "string" ? params.name : "";
          const toolArgs =
            params.arguments !== null &&
            typeof params.arguments === "object" &&
            !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : {};
          const output = await server.callTool(toolName, toolArgs);
          const safeOutput = redact(output);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(safeOutput) }],
              structuredContent: safeOutput,
              isError: false,
            },
          };
        }

        if (request.method === "health" || request.method === "openrail/health") {
          return {
            jsonrpc: "2.0",
            id,
            result: server.health(),
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: typeof message === "string" ? message : "Tool execution failed",
          },
        };
      }
    },

    health(): McpServerHealth {
      const now = clock();
      for (const [k, entry] of cache.entries()) {
        if (entry.expiresAt <= now) cache.delete(k);
      }
      while (callTimestamps.length > 0 && (callTimestamps[0] ?? 0) <= now - RATE_LIMIT_WINDOW_MS) {
        callTimestamps.shift();
      }
      return {
        ok: true,
        api_calls_total: apiCallsTotal,
        cache_hits_total: cacheHitsTotal,
        rate_limited_total: rateLimitedTotal,
        cache_entries: cache.size,
        window_calls: callTimestamps.length,
        max_calls_per_minute: maxCallsPerMinute,
        cache_ttl_ms: cacheTtlMs,
      };
    },

    clearCache(): void {
      cache.clear();
    },
  };

  return server;
}

/**
 * Starts the MCP JSON-RPC 2.0 server over stdin/stdout.
 * Reads `OPENRAIL_API_URL` (required unless `--fake` is passed) and `OPENRAIL_API_KEY` (optional)
 * via `@openrail/shared` env helpers, and loads module tools from `./enabled.js` (none for this build).
 */
export async function runStdioServer(
  argv: string[] = process.argv.slice(2),
  streams: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<McpServerInstance> {
  const useFake = argv.includes("--fake");
  const apiUrl = useFake ? "https://openrail.incepture.dev" : requireEnv("OPENRAIL_API_URL");
  const apiKey = getEnv("OPENRAIL_API_KEY");
  const webBaseUrl = getEnv("OPENRAIL_WEB_URL") ?? apiUrl;
  const rootContract = getEnv("NEAR_ROOT_ACCOUNT") ?? "openrail.near";

  const api = useFake
    ? createFakeApiClient()
    : createHttpApiClient({
        baseUrl: apiUrl,
        apiKey,
        webBaseUrl,
        rootContract,
      });

  const moduleTools = mcpModulesFrom(generatedEnabledModules);
  const enabledModules = Object.keys(moduleTools);
  const server = createMcpServer({
    api,
    enabledModules,
    moduleTools,
  });

  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const rl = createInterface({ input, crlfDelay: Infinity });

  void (async () => {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        const errResp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        };
        output.write(`${JSON.stringify(errResp)}\n`);
        continue;
      }
      const response = await server.handleRpc(parsed);
      if (response !== null) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    }
  })();

  return server;
}
