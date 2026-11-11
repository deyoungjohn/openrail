/**
 * `/health` asks the chain two questions (the issuer's two access keys). Anything that polls it (the deploy health
 * check, an uptime monitor, a browser tab) would spend the RPC's daily quota on a service that is doing nothing
 * (11 Nov: RPC_QUOTA_EXCEEDED after a day without a single issue). The answer is kept for a while, a failure for a
 * shorter while, and polls that arrive together share one check.
 */
export interface CachedHealthOptions {
  okMs: number;
  failMs: number;
  now?: () => number;
}

export function cachedHealth<T>(
  check: () => Promise<T>,
  options: CachedHealthOptions,
): () => Promise<T> {
  const now = options.now ?? Date.now;
  let until = 0;
  let value: { ok: true; result: T } | { ok: false; error: unknown } | undefined;
  let pending: Promise<T> | undefined;

  return async () => {
    if (value !== undefined && now() < until) {
      if (value.ok) return value.result;
      throw value.error;
    }
    if (pending === undefined) {
      pending = check().then(
        (result) => {
          value = { ok: true, result };
          until = now() + options.okMs;
          pending = undefined;
          return result;
        },
        (error: unknown) => {
          value = { ok: false, error };
          until = now() + options.failMs;
          pending = undefined;
          throw error;
        },
      );
    }
    return pending;
  };
}
