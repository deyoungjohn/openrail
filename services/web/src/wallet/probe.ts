/**
 * Whether a wallet module supports `signMessage`, read from the selector's own check.
 *
 * `decorateWallet` in @near-wallet-selector/core throws "The signMessage method is not supported
 * by <name>" before it looks at the parameters when the module has no `signMessage`; a module that
 * has one reaches parameter validation and throws "Invalid ...". Calling it with an empty message
 * therefore tells the two apart without opening a wallet. Anything else is "unknown", not a guess.
 */
export function classifyProbe(error: unknown): boolean | null {
  const text = error instanceof Error ? error.message : "";
  if (/signMessage method is not supported/i.test(text)) return false;
  if (/^Invalid (message|nonce|recipient)/.test(text)) return true;
  return null;
}
