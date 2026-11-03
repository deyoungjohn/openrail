/** Dashboard sessions, API keys and NEP-413 sign-in. */
import { createHash, randomBytes } from "node:crypto";
import { PublicKey, baseDecode } from "near-api-js";
import { constantTimeEqual, randomToken, sha256Hex } from "./crypto.js";
import {
  createMemoryStores,
  type ApiKeyStore,
  type ChallengeStore,
  type SessionStore,
  type Stores,
} from "./stores.js";

export type KeyKind = "secret" | "publishable";
export type AuthKind = KeyKind | "session";

export const SECRET_KEY_SCOPES = [
  "invoices:read",
  "invoices:write",
  "payments:read",
  "receipts:read",
  "webhooks:write",
] as const;

export interface ApiKeyRecord {
  id: string;
  accountId: string;
  name: string;
  prefix: string;
  hash: string;
  kind: KeyKind;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AuthContext {
  kind: AuthKind;
  accountId: string;
  scopes: string[];
  source: "bearer" | "cookie";
  session?: { tokenHash: string; expiresAt: number };
}

export interface Challenge {
  nonce: string;
  message: string;
  recipient: string;
  accountId: string;
  expiresAt: number;
}

export interface Nep413Payload {
  message: string;
  nonce: string;
  recipient: string;
}

export type Nep413Verifier = (
  publicKey: string,
  signature: string,
  payload: Nep413Payload,
) => boolean;
export type AccessKeyLookup = (accountId: string, publicKey: string) => Promise<boolean>;

export class AuthError extends Error {
  override readonly name = "AuthError";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

/** NEP-413: sha256(u32 LE tag 2147484061 || borsh(message, nonce[32], recipient, None)). */
export function nep413Hash(payload: Nep413Payload): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2147484061, 0);
  const nonce = Buffer.from(payload.nonce, "base64");
  if (nonce.length !== 32) throw new AuthError(400, "invalid_nonce", "nonce must be 32 bytes");
  const serialized = Buffer.concat([
    tag,
    borshString(payload.message),
    nonce,
    borshString(payload.recipient),
    Buffer.from([0]),
  ]);
  return createHash("sha256").update(serialized).digest();
}

function signatureBytes(signature: string): Uint8Array {
  if (signature.startsWith("ed25519:")) return baseDecode(signature.slice("ed25519:".length));
  if (signature.startsWith("0x")) return new Uint8Array(Buffer.from(signature.slice(2), "hex"));
  return new Uint8Array(Buffer.from(signature, "base64"));
}

/** Verify a NEP-413 signature with a NEAR public key. */
export const verifyNep413: Nep413Verifier = (publicKey, signature, payload) => {
  try {
    const key = PublicKey.fromString(publicKey);
    return key.verify(nep413Hash(payload), signatureBytes(signature));
  } catch {
    return false;
  }
};

export class AuthStore {
  private readonly keys: ApiKeyStore;
  private readonly sessions: SessionStore;
  private readonly challenges: ChallengeStore;

  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly sessionMs = 7 * 24 * 60 * 60 * 1000,
    stores: Pick<Stores, "keys" | "sessions" | "challenges"> = createMemoryStores(),
    private readonly maxSessionMs = 30 * 24 * 60 * 60 * 1000,
  ) {
    this.keys = stores.keys;
    this.sessions = stores.sessions;
    this.challenges = stores.challenges;
  }

  createApiKey(
    accountId: string,
    name: string,
    kind: KeyKind = "secret",
    scopes: string[] = [],
  ): { record: ApiKeyRecord; secret: string } {
    const secret = randomToken(kind === "secret" ? "or_sk_live_" : "or_pk_live_");
    const record: ApiKeyRecord = {
      id: `key_${randomBytes(9).toString("hex")}`,
      accountId,
      name,
      prefix: secret.slice(0, 20),
      hash: hashApiKey(secret),
      kind,
      scopes,
      createdAt: new Date(this.clock()).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.keys.create(record);
    return { record, secret };
  }

  rotateApiKey(id: string, accountId?: string): { record: ApiKeyRecord; secret: string } {
    const existing = this.keys.list(accountId).find((key) => key.id === id);
    if (existing === undefined) throw new AuthError(404, "api_key_not_found");
    const secret = randomToken(existing.kind === "secret" ? "or_sk_live_" : "or_pk_live_");
    const record: ApiKeyRecord = {
      ...existing,
      prefix: secret.slice(0, 20),
      hash: hashApiKey(secret),
      createdAt: new Date(this.clock()).toISOString(),
    };
    this.keys.update(record);
    return { record, secret };
  }

  revokeApiKey(id: string, accountId?: string): ApiKeyRecord {
    const record = this.keys.list(accountId).find((key) => key.id === id);
    if (record === undefined) throw new AuthError(404, "api_key_not_found");
    record.revokedAt = new Date(this.clock()).toISOString();
    this.keys.update(record);
    return record;
  }

  listApiKeys(accountId?: string): ApiKeyRecord[] {
    return this.keys.list(accountId);
  }

  authenticate(token: string | undefined, source: "bearer" | "cookie" = "bearer"): AuthContext {
    if (token === undefined || token === "") throw new AuthError(401, "unauthorized");
    if (token.startsWith("or_sess_")) {
      const tokenHash = sha256Hex(token);
      const session = this.sessions.get(tokenHash);
      if (session === undefined || session.expiresAt <= this.clock()) {
        this.sessions.delete(tokenHash);
        throw new AuthError(401, "session_expired");
      }
      const extended = Math.min(this.clock() + this.sessionMs, session.absoluteExpiresAt);
      if (extended > session.expiresAt) this.sessions.touch(tokenHash, extended);
      return {
        kind: "session",
        accountId: session.accountId,
        scopes: ["dashboard"],
        source,
        session: { tokenHash, expiresAt: extended },
      };
    }
    const record = this.keys.findByHash(hashApiKey(token));
    if (record === undefined || record.revokedAt !== null)
      throw new AuthError(401, "invalid_api_key");
    if (record.kind === "secret" && !constantTimeEqual(hashApiKey(token), record.hash)) {
      throw new AuthError(401, "invalid_api_key");
    }
    record.lastUsedAt = new Date(this.clock()).toISOString();
    this.keys.update(record);
    return { kind: record.kind, accountId: record.accountId, scopes: record.scopes, source };
  }

  sessionInfo(token: string): { accountId: string; expiresAt: number } | undefined {
    const session = this.sessions.get(sha256Hex(token));
    if (session === undefined || session.expiresAt <= this.clock()) return undefined;
    return { accountId: session.accountId, expiresAt: session.expiresAt };
  }

  logout(token: string): void {
    this.sessions.delete(sha256Hex(token));
  }

  challenge(accountId: string, recipient: string): Challenge {
    this.challenges.prune(this.clock());
    const nonce = randomBytes(32).toString("base64");
    const challenge: Challenge = {
      nonce,
      message: `${recipient} wants you to sign in with your NEAR account:\n\n${accountId}\n\nNonce: ${nonce}`,
      recipient,
      accountId,
      expiresAt: this.clock() + 5 * 60 * 1000,
    };
    this.challenges.put(challenge);
    return challenge;
  }

  async verify(
    input: { accountId: string; publicKey: string; signature: string; nonce: string },
    verifier: Nep413Verifier,
    accessKey: AccessKeyLookup,
  ): Promise<{
    sessionToken: string;
    accountId: string;
    expiresAt: string;
    tokenHash: string;
    absoluteExpiresAt: number;
  }> {
    this.challenges.prune(this.clock());
    const challenge = this.challenges.take(input.nonce);
    if (challenge === undefined || challenge.expiresAt <= this.clock()) {
      throw new AuthError(401, "challenge_expired");
    }
    if (challenge.accountId !== input.accountId) throw new AuthError(401, "wrong_account");
    if (!verifier(input.publicKey, input.signature, challenge)) {
      throw new AuthError(401, "invalid_signature");
    }
    if (!(await accessKey(input.accountId, input.publicKey))) {
      throw new AuthError(401, "wrong_signer");
    }
    const sessionToken = randomToken("or_sess_");
    const tokenHash = sha256Hex(sessionToken);
    const expiresAt = this.clock() + this.sessionMs;
    const absoluteExpiresAt = this.clock() + this.maxSessionMs;
    this.sessions.create({
      tokenHash,
      accountId: input.accountId,
      expiresAt,
      absoluteExpiresAt,
    });
    return {
      sessionToken,
      accountId: input.accountId,
      expiresAt: new Date(expiresAt).toISOString(),
      tokenHash,
      absoluteExpiresAt,
    };
  }
}
