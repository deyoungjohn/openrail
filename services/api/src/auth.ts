/** Dashboard sessions, API keys and NEP-413 sign-in. */
import { createHash, randomBytes } from "node:crypto";
import { PublicKey, baseDecode } from "near-api-js";
import { constantTimeEqual, randomToken } from "./crypto.js";

export type KeyKind = "secret" | "publishable";
export type AuthKind = KeyKind | "session";

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
  private readonly keysByHash = new Map<string, ApiKeyRecord>();
  private readonly keysById = new Map<string, ApiKeyRecord>();
  private readonly sessions = new Map<
    string,
    { accountId: string; expiresAt: number; scopes: string[] }
  >();
  private readonly challenges = new Map<string, Challenge>();

  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly sessionMs = 12 * 60 * 60 * 1000,
  ) {}

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
    this.keysByHash.set(record.hash, record);
    this.keysById.set(record.id, record);
    return { record, secret };
  }

  rotateApiKey(id: string): { record: ApiKeyRecord; secret: string } {
    const existing = this.keysById.get(id);
    if (existing === undefined) throw new AuthError(404, "api_key_not_found");
    this.keysByHash.delete(existing.hash);
    const secret = randomToken(existing.kind === "secret" ? "or_sk_live_" : "or_pk_live_");
    const record: ApiKeyRecord = {
      ...existing,
      prefix: secret.slice(0, 20),
      hash: hashApiKey(secret),
      createdAt: new Date(this.clock()).toISOString(),
    };
    this.keysByHash.set(record.hash, record);
    this.keysById.set(record.id, record);
    return { record, secret };
  }

  revokeApiKey(id: string): ApiKeyRecord {
    const record = this.keysById.get(id);
    if (record === undefined) throw new AuthError(404, "api_key_not_found");
    record.revokedAt = new Date(this.clock()).toISOString();
    this.keysByHash.delete(record.hash);
    return record;
  }

  listApiKeys(): ApiKeyRecord[] {
    return [...this.keysById.values()];
  }

  authenticate(token: string | undefined): AuthContext {
    if (token === undefined || token === "") throw new AuthError(401, "unauthorized");
    if (token.startsWith("or_sess_")) {
      const session = this.sessions.get(token);
      if (session === undefined || session.expiresAt <= this.clock()) {
        throw new AuthError(401, "session_expired");
      }
      return { kind: "session", accountId: session.accountId, scopes: session.scopes };
    }
    const record = this.keysByHash.get(hashApiKey(token));
    if (record === undefined || record.revokedAt !== null)
      throw new AuthError(401, "invalid_api_key");
    if (record.kind === "secret" && !constantTimeEqual(hashApiKey(token), record.hash)) {
      throw new AuthError(401, "invalid_api_key");
    }
    record.lastUsedAt = new Date(this.clock()).toISOString();
    return {
      kind: record.kind,
      accountId: record.accountId,
      scopes: record.scopes,
    };
  }

  private pruneChallenges(): void {
    const now = this.clock();
    for (const [nonce, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(nonce);
    }
  }

  challenge(accountId: string, recipient: string): Challenge {
    this.pruneChallenges();
    const nonce = randomBytes(32).toString("base64");
    const challenge: Challenge = {
      nonce,
      message: `${recipient} wants you to sign in with your NEAR account:\n\n${accountId}\n\nNonce: ${nonce}`,
      recipient,
      accountId,
      expiresAt: this.clock() + 5 * 60 * 1000,
    };
    this.challenges.set(nonce, challenge);
    return challenge;
  }

  async verify(
    input: { accountId: string; publicKey: string; signature: string; nonce: string },
    verifier: Nep413Verifier,
    accessKey: AccessKeyLookup,
  ): Promise<{ sessionToken: string; accountId: string; expiresAt: string }> {
    this.pruneChallenges();
    const challenge = this.challenges.get(input.nonce);
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
    this.challenges.delete(input.nonce);
    const sessionToken = randomToken("or_sess_");
    const expiresAt = this.clock() + this.sessionMs;
    this.sessions.set(sessionToken, {
      accountId: input.accountId,
      expiresAt,
      scopes: ["dashboard"],
    });
    return {
      sessionToken,
      accountId: input.accountId,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
}
