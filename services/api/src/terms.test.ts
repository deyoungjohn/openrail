import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalTerms, termsHash, validateTerms, type Terms } from "./terms.js";

interface Vector {
  name: string;
  input: Terms;
  expected_canonical: string;
  expected_sha256: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("../../../fixtures/vectors/terms-v1.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };

describe("canonical terms vectors", () => {
  it("reproduces every canonical string and sha256 byte for byte", () => {
    for (const vector of vectors.vectors) {
      expect(canonicalTerms(vector.input), vector.name).toBe(vector.expected_canonical);
      expect(termsHash(vector.input), vector.name).toBe(vector.expected_sha256);
    }
  });

  it("keeps non-ASCII UTF-8 and omits a missing assignment hash", () => {
    const unicode = vectors.vectors.find((vector) => vector.name === "unicode_names");
    expect(unicode).toBeDefined();
    if (unicode === undefined) throw new Error("unicode vector");
    const canonical = canonicalTerms(unicode.input);
    expect(canonical).toContain("Café — Société Générale");
    expect(canonical).toContain("株式会社オープンレール");
    expect(canonical).not.toContain("\\u");

    const minimal = vectors.vectors[0];
    if (minimal === undefined) throw new Error("minimal vector");
    expect(canonicalTerms(minimal.input)).not.toContain("assignment_agreement_sha256");
  });

  it("rejects malformed amounts and hashes", () => {
    const base = vectors.vectors[0]?.input;
    if (base === undefined) throw new Error("missing vector");
    for (const amount of ["1", "1.2", "1.234", "-1.00", "1.", ".50", " 1.00"]) {
      expect(() => validateTerms({ ...base, amount_usd: amount })).toThrow("TERMS_INVALID");
    }
    for (const hash of ["0X" + "a".repeat(64), "0x" + "A".repeat(64), "0x" + "g".repeat(64)]) {
      expect(() => validateTerms({ ...base, line_items_sha256: hash })).toThrow("TERMS_INVALID");
    }
    expect(() => validateTerms({ ...base, due_date: "2027-02-30T00:00:00Z" })).toThrow(
      "TERMS_INVALID",
    );
  });
});
