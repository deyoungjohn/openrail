// Pure logic for the receipt, statement and cash-out screens (blueprint 2.9, 2.10).

const EXPLORERS: Record<string, string> = {
  ethereum: "https://etherscan.io/tx/",
  base: "https://basescan.org/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  optimism: "https://optimistic.etherscan.io/tx/",
  polygon: "https://polygonscan.com/tx/",
  bnb: "https://bscscan.com/tx/",
  solana: "https://solscan.io/tx/",
  near: "https://nearblocks.io/txns/",
};

/** A link to a transaction on its chain's explorer, or null for a chain we have no explorer for. */
export function explorerTxUrl(chain: string, hash: string): string | null {
  const base = EXPLORERS[chain];
  return base ? `${base}${encodeURIComponent(hash)}` : null;
}

// The four settlement assets (fixtures/routes.json `settlementAssets`, checked by w5.test.ts).
const USDC_ASSETS = new Set([
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
]);

/** `USDC` for a settlement asset id; any other id is returned as it is. */
export const assetSymbol = (assetId: string): string =>
  USDC_ASSETS.has(assetId) ? "USDC" : assetId;

/** Dollars a person typed (up to 6 decimals, commas allowed) as USDC base units, or null. */
export function parseUsdcInput(value: string): bigint | null {
  const v = value.trim().replaceAll(",", "");
  if (!/^\d+(\.\d{1,6})?$/.test(v)) return null;
  const [w = "0", f = ""] = v.split(".");
  const units = BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"));
  return units === 0n ? null : units;
}

/**
 * The route cost as a share of the cash-out amount, in tenths of a percent, rounded up so a cost is
 * never understated. `costUsd` is an API amount like `0.30`; `amountUnits` is USDC base units.
 */
export function costShare(costUsd: string, amountUnits: bigint): string | null {
  if (amountUnits <= 0n || !/^\d+\.\d{2}$/.test(costUsd)) return null;
  const costUnits = BigInt(costUsd.replace(".", "")) * 10_000n; // cents to USDC base units
  const tenths = (costUnits * 1000n + amountUnits - 1n) / amountUnits; // tenths of a percent
  return `${tenths / 10n}.${tenths % 10n}%`;
}

/** Splits CSV text into a header and rows. Handles quotes, commas in quotes and CRLF. */
export function csvToTable(text: string): { header: string[]; rows: string[][] } {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x !== "") || row.length > 1) records.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    records.push(row);
  }
  const [header = [], ...rows] = records;
  return { header, rows };
}

/** sha256 of the bytes behind a base64 string, as `0x` plus hex. */
export async function sha256OfBase64(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return `0x${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const statementFilename = (
  s: { filename: string; format: "csv" | "pdf" },
  from: string,
  to: string,
): string => s.filename || `statement-${from}-${to}.${s.format}`;

const DATETIME = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** `Nov 2, 2026, 10:01 UTC`: the same moment for every viewer. */
export const formatDateTimeUtc = (iso: string): string => `${DATETIME.format(new Date(iso))} UTC`;
