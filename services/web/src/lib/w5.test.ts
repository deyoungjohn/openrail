import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assetSymbol,
  costShare,
  csvToTable,
  explorerTxUrl,
  parseUsdcInput,
  sha256OfBase64,
  statementFilename,
} from "./w5";

describe("explorerTxUrl: where a person can check a transaction themselves", () => {
  it("links each chain's own explorer", () => {
    expect(explorerTxUrl("base", "0xabc")).toBe("https://basescan.org/tx/0xabc");
    expect(explorerTxUrl("ethereum", "0xabc")).toBe("https://etherscan.io/tx/0xabc");
    expect(explorerTxUrl("arbitrum", "0xabc")).toBe("https://arbiscan.io/tx/0xabc");
    expect(explorerTxUrl("optimism", "0xabc")).toBe("https://optimistic.etherscan.io/tx/0xabc");
    expect(explorerTxUrl("polygon", "0xabc")).toBe("https://polygonscan.com/tx/0xabc");
    expect(explorerTxUrl("bnb", "0xabc")).toBe("https://bscscan.com/tx/0xabc");
    expect(explorerTxUrl("solana", "5Zz")).toBe("https://solscan.io/tx/5Zz");
    expect(explorerTxUrl("near", "8cDy")).toBe("https://nearblocks.io/txns/8cDy");
  });
  it("gives no link for a chain it does not know, never a wrong one", () => {
    expect(explorerTxUrl("unknown", "0xabc")).toBeNull();
  });
  it("encodes the hash", () => {
    expect(explorerTxUrl("base", "0x a/b")).toBe("https://basescan.org/tx/0x%20a%2Fb");
  });
});

describe("assetSymbol", () => {
  const settlement = JSON.parse(
    readFileSync(new URL("../../../../fixtures/routes.json", import.meta.url), "utf8"),
  ).settlementAssets as string[];

  it("every settlement asset in fixtures/routes.json is USDC", () => {
    expect(settlement.length).toBe(4);
    for (const id of settlement) expect(assetSymbol(id)).toBe("USDC");
  });
  it("an asset it does not know is shown as is, not guessed", () => {
    expect(assetSymbol("nep141:eth.omft.near")).toBe("nep141:eth.omft.near");
  });
});

describe("parseUsdcInput: what a person types, exact", () => {
  it("reads dollars with up to 6 decimals as base units", () => {
    expect(parseUsdcInput("2")).toBe(2_000_000n);
    expect(parseUsdcInput("2.5")).toBe(2_500_000n);
    expect(parseUsdcInput("0.000001")).toBe(1n);
    expect(parseUsdcInput("1,234.50")).toBe(1_234_500_000n);
  });
  it("refuses zero, negatives, too many decimals and words", () => {
    for (const v of ["", "0", "0.00", "-1", "1.0000001", "abc", "1e3", ".", "1.2.3"])
      expect(parseUsdcInput(v)).toBeNull();
  });
});

describe("costShare: what the route costs as a share of the cash-out (K11b: $0.30 of $2 is 15%)", () => {
  it("is exact in tenths of a percent", () => {
    expect(costShare("0.30", 2_000_000n)).toBe("15.0%");
    expect(costShare("0.30", 100_000_000n)).toBe("0.3%");
    expect(costShare("0.00", 2_000_000n)).toBe("0.0%");
  });
  it("never divides by zero", () => {
    expect(costShare("0.30", 0n)).toBeNull();
  });
  it("rounds the share up, so a cost is never understated", () => {
    expect(costShare("0.01", 3_000_000n)).toBe("0.4%");
  });
});

describe("csvToTable", () => {
  it("splits header and rows", () => {
    expect(csvToTable("a,b\n1,2\n3,4\n")).toEqual({
      header: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    });
  });
  it("handles quotes, commas inside quotes and escaped quotes", () => {
    expect(csvToTable('n,note\nx,"a, b"\ny,"say ""hi"""\n').rows).toEqual([
      ["x", "a, b"],
      ["y", 'say "hi"'],
    ]);
  });
  it("copes with CRLF and an empty file", () => {
    expect(csvToTable("a,b\r\n1,2\r\n").rows).toEqual([["1", "2"]]);
    expect(csvToTable("")).toEqual({ header: [], rows: [] });
  });
});

describe("sha256OfBase64 (the statement fingerprint)", () => {
  it("hashes the decoded bytes, as 0x-prefixed hex", async () => {
    // "abc" in base64
    expect(await sha256OfBase64("YWJj")).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("statementFilename", () => {
  it("keeps the API's name and falls back to the period", () => {
    expect(
      statementFilename({ filename: "s.csv", format: "csv" }, "2026-11-01", "2026-11-30"),
    ).toBe("s.csv");
    expect(statementFilename({ filename: "", format: "pdf" }, "2026-11-01", "2026-11-30")).toBe(
      "statement-2026-11-01-2026-11-30.pdf",
    );
  });
});
