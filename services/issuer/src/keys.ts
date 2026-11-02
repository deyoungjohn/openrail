/** Startup self-check: each key must be a restricted function-call key (review finding 3). */
import type { KeyInfo, KeyInspector } from "./types.js";

export const ISSUER_METHODS = ["issue_for", "log_quote"] as const;
export const RELAY_METHODS = ["acknowledge_evm"] as const;

export interface KeyCheck {
  ok: boolean;
  errors: string[];
  issuer: KeyInfo | null;
  relay: KeyInfo | null;
}

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
  try {
    issuer = await inspector.keyInfo(accountId, issuerPublicKey);
    errors.push(...checkOne("issuer", issuer, ISSUER_METHODS));
  } catch (error) {
    errors.push(
      `issuer key check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    relay = await inspector.keyInfo(accountId, relayPublicKey);
    errors.push(...checkOne("relay", relay, RELAY_METHODS));
  } catch (error) {
    errors.push(
      `relay key check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ok: errors.length === 0, errors, issuer, relay };
}
