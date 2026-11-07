import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Hard rule (DESIGN.md): error text never changes the layout. Field and form errors go through <ErrorNote>, which
// floats and takes no room. A paragraph that carries the danger colour in the page flow is exactly what breaks it.
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

describe("error text does not move the page", () => {
  const root = join(__dirname, "..");
  for (const file of files(root).filter(
    (f) => !f.endsWith("error-note.tsx") && !f.includes("/_dev/") && !f.includes("%5Fdev"),
  )) {
    it(file.slice(root.length + 1), () => {
      const text = readFileSync(file, "utf8");
      const inFlow = [...text.matchAll(/<(p|ul|div|span)\b[^>]*\brole="alert"[^>]*>/g)].filter(
        (m) => /text-danger/.test(m[0]),
      );
      expect(
        inFlow.map((m) => m[0]),
        "use <ErrorNote> instead",
      ).toEqual([]);
    });
  }
});
