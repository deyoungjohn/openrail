/**
 * Leak check: nothing about a switched-off module may appear in the build or source tree.
 * The switched-off list does NOT live in this repo. Terms come from the file named by
 * LEAK_KEYWORDS_FILE (in CI, written from the GitHub secret LEAK_KEYWORDS).
 *
 * Line format (blank lines and lines starting with # are ignored):
 *   id:<id>   match only module-shaped tokens: m:<id>:  modules/<id>  mod-<id>
 *             feature = "<id>"  /v1/<id>   (ids can be common words)
 *   <phrase>  case-insensitive substring
 *
 * Searched: tracked text files (git ls-files, skipping scripts/__tests__/** and pnpm-lock.yaml),
 * wasm export names and the built ABI json, the web bundle (if built), CLI help
 * (if built), README.md and the generated docs (docs/dist). Output names file and line only,
 * never the matched term or term index. Without a keyword file: warn and exit 0 locally, fail closed with CI=true.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Term = { kind: "id"; id: string } | { kind: "phrase"; phrase: string };

const TEXT_EXT = /\.(js|mjs|cjs|html|css|json|txt|md|map)$/;

export function parseTerms(text: string): Term[] {
  const terms: Term[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("id:")) {
      const id = line.slice(3).trim();
      if (id) terms.push({ kind: "id", id });
    } else {
      terms.push({ kind: "phrase", phrase: line.toLowerCase() });
    }
  }
  return terms;
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matcher(t: Term): (line: string) => boolean {
  if (t.kind === "phrase") return (l) => l.toLowerCase().includes(t.phrase);
  const id = esc(t.id);
  const re = new RegExp(
    [
      `m:${id}:`,
      `modules/${id}(?![A-Za-z0-9_])`,
      `mod-${id}(?![A-Za-z0-9_])`,
      `feature\\s*=\\s*"${id}"`,
      `/v1/${id}(?![A-Za-z0-9_-])`,
    ].join("|"),
  );
  return (l) => re.test(l);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (TEXT_EXT.test(name)) out.push(p);
  }
  return out;
}

function trackedFiles(root: string): { ok: boolean; files: string[]; error?: string } {
  const r = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  if (r.status === 0 && typeof r.stdout === "string") {
    return {
      ok: true,
      files: r.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    };
  }
  const err = r.error ? r.error.message : r.stderr?.trim() || `exit code ${r.status}`;
  return { ok: false, files: [], error: err };
}

function isBinaryFile(p: string): boolean {
  try {
    const buf = readFileSync(p);
    const len = Math.min(buf.length, 8000);
    for (let i = 0; i < len; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// The ES2022 lib has no WebAssembly types; declare only what is used.
declare const WebAssembly: {
  Module: {
    new (bytes: Uint8Array): object;
    exports(m: object): { name: string }[];
  };
};

function wasmExports(file: string): string[] {
  const mod = new WebAssembly.Module(new Uint8Array(readFileSync(file)));
  return WebAssembly.Module.exports(mod).map((e) => e.name);
}

export function runLeakCheck(
  root: string,
  env: Record<string, string | undefined>,
): { code: number; messages: string[] } {
  const file = env.LEAK_KEYWORDS_FILE;
  const ci = env.CI === "true";
  const missing = (why: string) =>
    ci
      ? {
          code: 1,
          messages: [`leak-check FAILED (fail closed in CI): ${why}. Set LEAK_KEYWORDS_FILE.`],
        }
      : {
          code: 0,
          messages: [`leak-check: warning, skipped: ${why}. Set LEAK_KEYWORDS_FILE to run it.`],
        };
  if (!file) return missing("LEAK_KEYWORDS_FILE is not set");
  if (!existsSync(file)) return missing("LEAK_KEYWORDS_FILE does not point to a file");
  const terms = parseTerms(readFileSync(file, "utf8"));
  if (terms.length === 0) return missing("the keyword file has no terms");
  const matchers = terms.map(matcher);

  const warnings: string[] = [];
  const leaks: string[] = [];
  const scan = (label: string, lines: string[], withLine: boolean) => {
    lines.forEach((l, i) => {
      if (matchers.some((m) => m(l))) {
        leaks.push(`leak: ${label}${withLine ? `:${i + 1}` : ""}`);
      }
    });
  };

  const scanned = new Set<string>();

  const trackedResult = trackedFiles(root);
  if (!trackedResult.ok) {
    if (ci) {
      return {
        code: 1,
        messages: [
          `leak-check FAILED (fail closed in CI): git ls-files failed: ${trackedResult.error ?? "unknown error"}`,
        ],
      };
    } else {
      warnings.push(
        `leak-check: warning: git ls-files failed: ${trackedResult.error ?? "unknown error"}`,
      );
    }
  }
  const tracked = trackedResult.files;

  for (const rel of tracked) {
    if (rel === "pnpm-lock.yaml" || rel.startsWith("scripts/__tests__/")) {
      continue;
    }
    const p = join(root, rel);
    if (!existsSync(p) || statSync(p).isDirectory() || isBinaryFile(p)) {
      continue;
    }
    scanned.add(rel);
    scan(rel, readFileSync(p, "utf8").split("\n"), true);
  }

  const built = join(root, "target/near/openrail");
  if (existsSync(built)) {
    for (const name of readdirSync(built)) {
      const p = join(built, name);
      const rel = relative(root, p);
      if (name.endsWith(".wasm")) scan(`${rel} (export name)`, wasmExports(p), false);
      else if (name.endsWith(".json")) scan(rel, readFileSync(p, "utf8").split("\n"), true);
    }
  }
  for (const dir of ["services/web/.next", "services/web/dist", "services/web/out", "docs/dist"]) {
    for (const p of walk(join(root, dir))) {
      scan(relative(root, p), readFileSync(p, "utf8").split("\n"), true);
    }
  }
  const readme = join(root, "README.md");
  if (existsSync(readme) && !scanned.has("README.md")) {
    scan("README.md", readFileSync(readme, "utf8").split("\n"), true);
  }

  const cli = join(root, "services/cli/dist/index.js");
  if (existsSync(cli)) {
    const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 15000 });
    scan("services/cli (--help output)", `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n"), true);
  }

  if (leaks.length > 0) {
    return {
      code: 1,
      messages: [
        ...warnings,
        ...leaks,
        `leak-check FAILED: ${leaks.length} hit(s) (terms not shown)`,
      ],
    };
  }
  return { code: 0, messages: [...warnings, "leak-check: OK"] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const r = runLeakCheck(root, process.env);
  for (const m of r.messages) console.log(m);
  process.exit(r.code);
}
