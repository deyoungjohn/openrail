import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTerms, runLeakCheck } from "../leak-check.js";

// Every term here is made up. The real switched-off list never lives in this repo.
let root: string;
let kw: string;

function write(rel: string, data: string | Uint8Array): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, data);
}

/** Smallest valid wasm module that exports one function with the given name. */
function wasmExporting(name: string): Uint8Array {
  const n = new TextEncoder().encode(name);
  const exportBody = [1, n.length, ...n, 0x00, 0x00];
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00, // magic, version
    0x01,
    0x04,
    0x01,
    0x60,
    0x00,
    0x00, // type: () -> ()
    0x03,
    0x02,
    0x01,
    0x00, // func 0 : type 0
    0x07,
    exportBody.length,
    ...exportBody, // export
    0x0a,
    0x04,
    0x01,
    0x02,
    0x00,
    0x0b, // code
  ]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leak-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  kw = join(root, "kw.txt");
  writeFileSync(kw, "# made-up\nid:zorp\nblorptastic widget\n");
  write("README.md", "# Title\nNothing to see.\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("parseTerms", () => {
  it("reads id terms and phrases, skipping blanks and comments", () => {
    const t = parseTerms("# c\n\nid:zorp\nBlorptastic Widget\n");
    expect(t).toHaveLength(2);
  });
});

describe("runLeakCheck", () => {
  it("passes when nothing matches", () => {
    const r = runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw });
    expect(r.code).toBe(0);
  });

  it("catches module-shaped tokens for an id term", () => {
    for (const bad of [
      "see modules/zorp for more",
      "m:zorp:state",
      "branch mod-zorp",
      'feature = "zorp"',
      "GET /v1/zorp/list",
    ]) {
      write("README.md", `${bad}\n`);
      const r = runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw });
      expect(r.code, bad).toBe(1);
    }
  });

  it("does not match the bare id as an ordinary word", () => {
    write("README.md", "The zorp of the matter is a common word.\n");
    expect(runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw }).code).toBe(0);
  });

  it("matches a plain phrase case-insensitively", () => {
    write("docs/dist/a.md", "A BlorpTastic WIDGET appears\n");
    expect(runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw }).code).toBe(1);
  });

  it("catches an id in the built wasm exports and in the ABI json", () => {
    write("target/near/openrail/openrail.wasm", wasmExporting("m:zorp:thing"));
    expect(runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw }).code).toBe(1);
    rmSync(join(root, "target"), { recursive: true });
    write("target/near/openrail/openrail_abi.json", '{"name":"blorptastic widget"}');
    expect(runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw }).code).toBe(1);
  });

  it("scans the web bundle when it exists", () => {
    write("services/web/.next/static/app.js", 'var x="/v1/zorp/y";');
    expect(runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw }).code).toBe(1);
  });

  it("scans the built CLI help output", () => {
    write("services/cli/dist/index.js", 'console.log("usage: tool modules/zorp");');
    expect(runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw }).code).toBe(1);
  });

  it("scans tracked source files like contracts/x.rs and skips scripts/__tests__", () => {
    write("contracts/x.rs", 'const X: &str = "modules/zorp";\n');
    spawnSync("git", ["add", "contracts/x.rs"], { cwd: root });
    expect(runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw }).code).toBe(1);

    write("scripts/__tests__/dummy.test.ts", 'const X: &str = "modules/zorp";\n');
    spawnSync("git", ["add", "scripts/__tests__/dummy.test.ts"], { cwd: root });
    write("contracts/x.rs", 'const X: &str = "clean";\n');
    spawnSync("git", ["add", "contracts/x.rs"], { cwd: root });
    expect(runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw }).code).toBe(0);
  });

  it("never prints the term, only file and line", () => {
    write("README.md", "a\nsee modules/zorp\n");
    const r = runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw });
    const out = r.messages.join("\n");
    expect(out).toContain("README.md:2");
    expect(out).not.toContain("zorp");
    expect(out).not.toContain("term #");
  });

  it("without a keyword file: warns and passes locally, fails closed in CI", () => {
    const local = runLeakCheck(root, {});
    expect(local.code).toBe(0);
    expect(local.messages.join("\n")).toMatch(/warn/i);
    const ci = runLeakCheck(root, { CI: "true" });
    expect(ci.code).toBe(1);
    expect(ci.messages.join("\n")).toContain("LEAK_KEYWORDS_FILE");
  });

  it("fails closed in CI when the file is missing or has no terms", () => {
    expect(runLeakCheck(root, { CI: "true", LEAK_KEYWORDS_FILE: join(root, "nope") }).code).toBe(1);
    writeFileSync(kw, "# only a comment\n\n");
    expect(runLeakCheck(root, { CI: "true", LEAK_KEYWORDS_FILE: kw }).code).toBe(1);
  });

  it("fails closed in CI when git ls-files fails, and warns locally", () => {
    rmSync(join(root, ".git"), { recursive: true, force: true });
    const ci = runLeakCheck(root, { CI: "true", LEAK_KEYWORDS_FILE: kw });
    expect(ci.code).toBe(1);
    expect(ci.messages.join("\n")).toContain("git ls-files failed");

    const local = runLeakCheck(root, { LEAK_KEYWORDS_FILE: kw });
    expect(local.code).toBe(0);
    expect(local.messages.join("\n")).toContain("git ls-files failed");
  });
});
