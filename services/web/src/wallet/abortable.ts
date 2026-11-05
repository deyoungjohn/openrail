/**
 * A wallet pop-up that is closed, or an app that never answers, leaves the wallet's promise pending
 * for ever. Racing it with an abort signal lets the page stop waiting and show the button again.
 */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error("WALLET_CANCELLED"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
