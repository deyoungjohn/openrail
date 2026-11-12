import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Geometry and animation numbers, not values a person reads.
const EXEMPT = ["components/ui/loader.tsx", "components/ui/countdown.tsx"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("two decimals everywhere (hard rule, 12 Nov)", () => {
  it("no UI source rounds a shown value to anything but two decimals", () => {
    const src = join(__dirname, "..");
    const bad: string[] = [];
    for (const file of files(src)) {
      if (EXEMPT.some((e) => file.endsWith(e))) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\.toFixed\((\d+)\)/g)) {
        if (m[1] !== "2") bad.push(`${file.replace(src, "src")}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
