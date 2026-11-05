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

/**
 * What each module's source says about signMessage (pinned by capabilities.test.ts against the installed
 * versions). Used when the live check does not answer in time, so one slow or broken wallet module can
 * never leave the picker on "Checking".
 */
const STATIC_SIGNS_MESSAGE: Readonly<Record<string, boolean>> = {
  "meteor-wallet": true,
  "hot-wallet": true,
  "here-wallet": true,
  nightly: true,
  "intear-wallet": true,
  "near-mobile-wallet": true,
  "coin98-wallet": true,
  "wallet-connect": true,
  "bitget-wallet": false,
};

export function staticSignsMessage(id: string): boolean | null {
  return STATIC_SIGNS_MESSAGE[id] ?? null;
}

/** Rejects with `PROBE_TIMEOUT` when `work` does not settle in `ms`. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("PROBE_TIMEOUT")), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
