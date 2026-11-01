import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDocs } from "../docs.js";

let root: string;

function write(rel: string, text: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "docs-"));
  write(
    "openrail.modules.json",
    JSON.stringify({
      modules: [
        { id: "alpha", enabled: true },
        { id: "gamma", enabled: false },
      ],
    }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("buildDocs", () => {
  it("is a no-op success with an empty or missing docs/src", () => {
    expect(buildDocs(root).code).toBe(0);
    mkdirSync(join(root, "docs/src"), { recursive: true });
    expect(buildDocs(root).code).toBe(0);
  });

  it("assembles core and enabled module docs into docs/dist", () => {
    write("docs/src/core/intro.md", "# Intro\nSee [more](./more.md).\n");
    write("docs/src/core/more.md", "# More\n");
    write("docs/src/modules/alpha/a.md", "---\nkeywords: [x]\n---\n# Alpha\n");
    expect(buildDocs(root).code).toBe(0);
    expect(existsSync(join(root, "docs/dist/core/intro.md"))).toBe(true);
    const a = readFileSync(join(root, "docs/dist/modules/alpha/a.md"), "utf8");
    expect(a).toContain("# Alpha");
    expect(a).not.toContain("keywords");
  });

  it("leaves disabled modules out of the output", () => {
    write("docs/src/core/intro.md", "# Intro\n");
    write("docs/src/modules/gamma/g.md", "# Gamma\n");
    expect(buildDocs(root).code).toBe(0);
    expect(existsSync(join(root, "docs/dist/modules/gamma"))).toBe(false);
  });

  it("fails on a broken relative link", () => {
    write("docs/src/core/intro.md", "# Intro\n[gone](./missing.md)\n");
    const r = buildDocs(root);
    expect(r.code).toBe(1);
    expect(r.messages.join("\n")).toContain("docs/src/core/intro.md:2");
  });

  it("accepts links to repo files, anchors and URLs; ignores code fences", () => {
    write("evidence/report.json", "{}");
    write(
      "docs/src/core/intro.md",
      "[r](../../../evidence/report.json) [a](#top) [u](https://example.com/x) [m](mailto:a@b.c)\n```\n[no](./nope.md)\n```\n",
    );
    expect(buildDocs(root).code).toBe(0);
  });

  it("fails when a doc links into a disabled module's docs", () => {
    write("docs/src/modules/gamma/g.md", "# G\n");
    write("docs/src/core/intro.md", "[g](../modules/gamma/g.md)\n");
    expect(buildDocs(root).code).toBe(1);
  });
});
