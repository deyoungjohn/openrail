import type { Earning, EarningsSource, Stream } from "./earnings";

/** Merge module-declared money sources; one broken source never takes the dashboard down. */
export async function loadModuleEarnings(
  sources: readonly EarningsSource[],
): Promise<{ earnings: Earning[]; failedStreams: Stream[] }> {
  const results = await Promise.allSettled(sources.map((source) => source.load()));
  const earnings: Earning[] = [];
  const failedStreams: Stream[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") earnings.push(...result.value);
    else failedStreams.push(sources[index]?.stream ?? "invoice");
  });
  return { earnings, failedStreams };
}
