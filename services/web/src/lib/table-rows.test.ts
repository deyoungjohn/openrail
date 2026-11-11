import { describe, expect, it } from "vitest";
import { clampPageSize, MAX_TABLE_ROWS } from "./table-rows";

describe("clampPageSize: a table never shows more than ten rows at once", () => {
  it("keeps a smaller size", () => expect(clampPageSize(6)).toBe(6));
  it("defaults to the maximum", () => expect(clampPageSize(undefined)).toBe(MAX_TABLE_ROWS));
  it("caps anything above ten", () => {
    expect(clampPageSize(11)).toBe(10);
    expect(clampPageSize(500)).toBe(10);
    expect(clampPageSize(Infinity)).toBe(10);
  });
  it("never goes below one row", () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-3)).toBe(1);
    expect(clampPageSize(Number.NaN)).toBe(10);
  });
});
