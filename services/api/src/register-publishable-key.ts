/**
 * One-off operator command: register a publishable key that was generated outside the API.
 *
 * The hosted pay page needs a publishable key baked into the web build (NEXT_PUBLIC_API_PUBLISHABLE_KEY).
 * The key is created on the laptop before the build; this command stores only its SHA-256 on the server,
 * so the key itself never has to be generated on, or copied back from, the server.
 *
 *   echo "$KEY" | DATABASE_URL=/var/lib/openrail/api.sqlite NEAR_ROOT_ACCOUNT=openrail.near \
 *     pnpm --filter @openrail/api register-pk
 *
 * The key is read from stdin so it never appears in the process list. Rerunning with the same key is a no-op.
 */
import { randomBytes } from "node:crypto";
import { hashApiKey, type ApiKeyRecord } from "./auth.js";
import { createSqliteStores, type ApiKeyStore } from "./stores.js";

export const PUBLISHABLE_PREFIX = "or_pk_live_";

export function registerPublishableKey(
  keys: ApiKeyStore,
  accountId: string,
  secret: string,
  now: () => Date = () => new Date(),
): "registered" | "already_registered" {
  if (!secret.startsWith(PUBLISHABLE_PREFIX) || secret.length < PUBLISHABLE_PREFIX.length + 24) {
    throw new Error(`INVALID_KEY: expected ${PUBLISHABLE_PREFIX}<at least 24 characters>`);
  }
  const hash = hashApiKey(secret);
  if (keys.findByHash(hash) !== undefined) return "already_registered";
  const record: ApiKeyRecord = {
    id: `key_${randomBytes(9).toString("hex")}`,
    accountId,
    name: "hosted pay page",
    prefix: secret.slice(0, 20),
    hash,
    kind: "publishable",
    scopes: ["pay_sessions:create"],
    createdAt: now().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };
  keys.create(record);
  return "registered";
}

async function main(): Promise<void> {
  const accountId = process.env.NEAR_ROOT_ACCOUNT?.trim();
  if (!accountId) {
    console.error("MISSING_ENV: NEAR_ROOT_ACCOUNT");
    process.exit(1);
  }
  const databasePath = (process.env.DATABASE_URL ?? "").replace(/^file:/, "");
  if (!databasePath) {
    console.error("MISSING_ENV: DATABASE_URL");
    process.exit(1);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  const secret = Buffer.concat(chunks).toString("utf8").trim();
  const stores = createSqliteStores(databasePath);
  const result = registerPublishableKey(stores.keys, accountId, secret);
  console.log(
    result === "registered" ? "registered publishable key" : "this key was already registered",
  );
}

if (process.argv[1]?.endsWith("register-publishable-key.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
