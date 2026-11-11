import { describe, expect, it } from "vitest";
import { fillTabWidth } from "./tab-layout";

describe("tab switches fill the panel equally", () => {
  const inner = (width: number) => width - 32; // the liquid surface's inset, both sides

  it("two tabs take half each, three a third each, four a quarter", () => {
    expect(fillTabWidth(632, 2)).toBeCloseTo(inner(632) / 2, 6);
    expect(fillTabWidth(632, 3)).toBeCloseTo(inner(632) / 3, 6);
    expect(fillTabWidth(632, 4)).toBeCloseTo(inner(632) / 4, 6);
  });

  it("is not capped at the old 176 px design width", () => {
    expect(fillTabWidth(1032, 2)).toBeGreaterThan(176);
  });

  it("tabs together span exactly the width between the insets", () => {
    for (const count of [1, 2, 3, 5]) {
      expect(fillTabWidth(700, count) * count).toBeCloseTo(inner(700), 6);
    }
  });
});
