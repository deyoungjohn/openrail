/** Startup self-check: each key must be a restricted function-call key (review finding 3). */
import type { KeyInfo, KeyInspector } from "./types.js";

export const ISSUER_METHODS = ["issue_for", "log_quote"] as const;
export const RELAY_METHODS = ["acknowledge_evm"] as const;

export interface KeyCheck {
  ok: boolean;
  errors: string[];
  /** Checks that could not be made because the RPCs were unreachable or limiting: not a verdict on the key. */
  unverified: string[];
  issuer: KeyInfo | null;
  relay: KeyInfo | null;
}

/** An RPC that cannot answer right now, as opposed to a definite answer about the key. */
const RPC_TROUBLE = /^RPC_(HTTP_(429|5\d\d)|NETWORK|UNAVAILABLE)|timed? ?out|ECONN|fetch failed/i;

function sameSet(actual: string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const set = new Set(actual);
  return expected.every((method) => set.has(method));
}

function checkOne(role: "issuer" | "relay", info: KeyInfo, expected: readonly string[]): string[] {
  if (info.kind === "FullAccess") {
    return [`${role} key is a full-access key; it must be a restricted function-call key`];
  }
  if (info.methods.length === 0) {
    return [`${role} key allows every method; restrict it to ${expected.join(", ")}`];
  }
  if (!sameSet(info.methods, expected)) {
    return [
      `${role} key allows [${info.methods.join(", ")}]; expected exactly [${expected.join(", ")}]`,
    ];
  }
  return [];
}

export async function checkKeyPermissions(
  inspector: KeyInspector,
  accountId: string,
  issuerPublicKey: string,
  relayPublicKey: string,
): Promise<KeyCheck> {
  let issuer: KeyInfo | null = null;
  let relay: KeyInfo | null = null;
  const errors: string[] = [];
  const unverified: string[] = [];
  const failed = (role: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    (RPC_TROUBLE.test(message) ? unverified : errors).push(`${role} key check failed: ${message}`);
  };
  try {
    issuer = await inspector.keyInfo(accountId, issuerPublicKey);
    errors.push(...checkOne("issuer", issuer, ISSUER_METHODS));
  } catch (error) {
    failed("issuer", error);
  }
  try {
    relay = await inspector.keyInfo(accountId, relayPublicKey);
    errors.push(...checkOne("relay", relay, RELAY_METHODS));
  } catch (error) {
    failed("relay", error);
  }
  return { ok: errors.length === 0, errors, unverified, issuer, relay };
}
