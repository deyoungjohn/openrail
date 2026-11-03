// A NEAR account id is either named (`acme.openrail.near`) or implicit: exactly 64 lowercase hex
// characters. Multichain wallets (OKX, Bitget, Trust, ...) use implicit ones, so every place that
// shows or accepts an account must handle both.

const NAMED = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const IMPLICIT = /^[0-9a-f]{64}$/;

export const isNearAccountId = (v: string): boolean => NAMED.test(v) || IMPLICIT.test(v);

export const isImplicitAccountId = (v: string): boolean => IMPLICIT.test(v);

/**
 * How to print an account. Named accounts are always whole. An implicit account is middle-truncated
 * (both ends stay visible, so a mistake in either shows) unless the caller asks for the full value;
 * callers that truncate also give the full value as a tooltip and a copy button.
 */
export function accountDisplay(
  value: string,
  opts: { full?: boolean } = {},
): { text: string; truncated: boolean } {
  if (opts.full || !IMPLICIT.test(value)) return { text: value, truncated: false };
  return { text: `${value.slice(0, 10)}…${value.slice(-8)}`, truncated: true };
}
