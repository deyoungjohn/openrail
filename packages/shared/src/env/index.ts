/**
 * Environment access and redaction.
 *
 * Secrets are read from `process.env` only. A missing required variable exits
 * with `MISSING_ENV: <NAME>` on stderr (blueprint 1.6, AGENTS rule 1).
 * Everything written by the logger passes through `redact()`.
 */

export const REDACT_OPEN = "«redacted";
export const REDACT_CLOSE = "»";
export const REDACTED = `${REDACT_OPEN}${REDACT_CLOSE}`;

const MIN_SECRET_VALUE_LENGTH = 6;

const SECRET_NAME_RE =
  /(^|_)(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|JWT|SEED|MNEMONIC)(_|$)|(_RPC_URL$)/i;

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const ED25519_RE = /\bed25519:[1-9A-HJ-NP-Za-km-z]{40,}\b/g;
const SECRET_KEY_CONTEXT_RE = /(key|secret|seed|private|mnemonic|token)/i;
const HEX_64_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;
const INLINE_SECRET_HEX_RE =
  /\b(key|secret|private_key|private|token|seed|mnemonic)\s*[:=]\s*(["']?)((?:0x)?[0-9a-fA-F]{64})\2/gi;

interface SecretEntry {
  name: string;
  value: string;
}

const secrets: SecretEntry[] = [];

function alreadyRegistered(value: string): boolean {
  return secrets.some((secret) => secret.value === value);
}

/** Register a value (and its long embedded pieces) for exact-match redaction. */
export function registerSecret(name: string, value: unknown): void {
  if (typeof value !== "string" || value.length < MIN_SECRET_VALUE_LENGTH) return;
  if (!alreadyRegistered(value)) secrets.push({ name, value });
  for (const piece of value.split(/[^A-Za-z0-9_-]+/)) {
    if (piece.length >= 20 && piece !== value && !alreadyRegistered(piece)) {
      secrets.push({ name: `${name}:embedded`, value: piece });
    }
  }
  secrets.sort((a, b) => b.value.length - a.value.length);
}

/** A name is secret-bearing when it looks like a key, JWT or RPC URL. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** Register every secret-looking value currently in `process.env`. */
export function registerEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value !== "" && isSecretName(name)) registerSecret(name, value);
  }
}

/** Names currently registered. Values never leave this module. */
export function registeredSecretNames(): string[] {
  return secrets.map((secret) => secret.name);
}

/** Test-only reset so one suite does not leak registrations into the next. */
export function resetSecretsForTests(): void {
  secrets.length = 0;
}

function redactPatterns(input: string): string {
  return input
    .replace(INLINE_SECRET_HEX_RE, (match, _prefix, _quote, hex: string) =>
      match.replace(hex, REDACTED),
    )
    .replace(JWT_RE, REDACTED)
    .replace(ED25519_RE, REDACTED);
}

/** Mask registered secret values and every key-shaped token in a string. */
export function redactString(input: string): string {
  if (input.length === 0) return input;
  let output = input;
  for (const secret of secrets) {
    if (output.includes(secret.value)) {
      output = output.split(secret.value).join(`${REDACT_OPEN}:${secret.name}${REDACT_CLOSE}`);
    }
  }
  return redactPatterns(output);
}

/** Redact a value for human output. Strings and errors are masked; objects are deep-copied. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return redactError(value);
  return redactDeep(value);
}

/** Redact an error's message and stack in place. */
export function redactError<T extends Error>(error: T): T {
  try {
    const message = redactString(error.message);
    if (message !== error.message) error.message = message;
  } catch {
    // Frozen message: leave it untouched rather than throwing from the logger.
  }
  try {
    if (typeof error.stack === "string") {
      const stack = redactString(error.stack);
      if (stack !== error.stack) error.stack = stack;
    }
  } catch {
    // No writable stack accessor.
  }
  return error;
}

/** Deep, JSON-safe redaction. Cycles become «cycle». */
export function redactDeep<T>(input: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof input === "string") return redactString(input) as unknown as T;
  if (input === null || typeof input !== "object") return input;
  if (input instanceof Date) return input;
  if (seen.has(input as object)) return "«cycle»" as unknown as T;
  seen.add(input as object);
  if (input instanceof Error) {
    return {
      name: redactString(input.name),
      message: redactString(input.message),
      stack: typeof input.stack === "string" ? redactString(input.stack) : undefined,
    } as unknown as T;
  }
  if (Array.isArray(input)) return input.map((entry) => redactDeep(entry, seen)) as unknown as T;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const redactedKey = redactString(key);
    output[redactedKey] =
      SECRET_KEY_CONTEXT_RE.test(key) && typeof value === "string" && HEX_64_RE.test(value)
        ? REDACTED
        : redactDeep(value, seen);
  }
  return output as unknown as T;
}

function formatArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(redactDeep(value));
  } catch {
    return String(value);
  }
}

export type LogSink = (line: string) => void;

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** A logger whose sink only ever receives redacted text. */
export function createLogger(scope: string, sink: LogSink = (line) => console.log(line)): Logger {
  const write = (message: string, args: unknown[]): void => {
    const text = [message, ...args.map(formatArgument)].join(" ");
    sink(redactString(`[${scope}] ${text}`));
  };
  return {
    debug: (message, ...args) => write(message, args),
    info: (message, ...args) => write(message, args),
    warn: (message, ...args) => write(message, args),
    error: (message, ...args) => write(message, args),
  };
}

function missing(name: string): never {
  process.stderr.write(`MISSING_ENV: ${name}\n`);
  process.exit(1);
  throw new Error(`MISSING_ENV: ${name}`);
}

/** Read a variable, or undefined when absent or empty. */
export function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Read a required variable; registers it when its name says it is a secret. */
export function requireEnv(name: string): string {
  const value = getEnv(name);
  if (value === undefined) missing(name);
  if (isSecretName(name)) registerSecret(name, value);
  return value;
}

/** Read a required integer. */
export function requireInt(name: string): number {
  const raw = requireEnv(name);
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`ENV_INVALID: ${name}`);
  return value;
}

/** Read a required finite number. */
export function requireNumber(name: string): number {
  const raw = requireEnv(name);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`ENV_INVALID: ${name}`);
  return value;
}

/** Read a required boolean: yes/no/true/false/1/0. */
export function requireBool(name: string): boolean {
  const raw = requireEnv(name).trim().toLowerCase();
  if (["yes", "true", "1"].includes(raw)) return true;
  if (["no", "false", "0"].includes(raw)) return false;
  throw new Error(`ENV_INVALID: ${name}`);
}

/** True unless DRY_RUN is explicitly no/false/0. Defaults to a dry run. */
export function isDryRun(): boolean {
  const flag = (process.env.DRY_RUN ?? "yes").trim().toLowerCase();
  return !["no", "false", "0"].includes(flag);
}

/** True only when OWED_CONFIRM_MAINNET=yes. Agents never set it. */
export function confirmMainnet(): boolean {
  return (process.env.OWED_CONFIRM_MAINNET ?? "no").trim().toLowerCase() === "yes";
}

registerEnvSecrets();
