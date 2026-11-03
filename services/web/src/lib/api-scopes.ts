import { copy } from "../copy";

/** Scopes of a secret key, in the order shown. Publishable keys have only `pay_sessions:create` and no picker. */
export const API_KEY_SCOPES = [
  "invoices:read",
  "invoices:write",
  "payments:read",
  "receipts:read",
  "webhooks:write",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const DEFAULT_SCOPES: ApiKeyScope[] = [...API_KEY_SCOPES];

/** A plain-words problem with a chosen scope list, or null. */
export function scopesProblem(scopes: readonly string[]): string | null {
  if (scopes.length === 0) return copy.developers.pickScopes;
  if (scopes.some((s) => !(API_KEY_SCOPES as readonly string[]).includes(s)))
    return copy.developers.pickScopes;
  return null;
}
