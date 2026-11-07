import { describe, expect, it } from "vitest";
import { toSeconds } from "./time.js";

describe("toSeconds", () => {
  it("reads nanoseconds, milliseconds and seconds by their size, never as 1970", () => {
    expect(toSeconds("1794045036940238755")).toBe(1794045036);
    expect(toSeconds(1794045036940)).toBe(1794045036);
    expect(toSeconds(1794045036)).toBe(1794045036);
    expect(toSeconds("2026-11-07T10:00:00Z")).toBe(1794045600);
  });
  it("is zero for nothing", () => {
    expect(toSeconds(undefined)).toBe(0);
    expect(toSeconds("")).toBe(0);
  });
});
