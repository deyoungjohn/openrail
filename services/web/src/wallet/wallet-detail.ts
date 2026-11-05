/** One short, plain line from a wallet error, for the person and for us. No keys can appear in it. */
export function walletDetail(e: unknown): string | undefined {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const line = raw.replace(/\s+/g, " ").trim();
  if (!line || /^(WALLET_|SIGNMESSAGE_)/.test(line)) return undefined;
  return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}
