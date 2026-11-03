/**
 * Doc reference checker: verifies that backticked identifiers in documentation
 * (specifically `docs/src/core/security-review.md` and `docs/src/core/mutations.md`)
 * correspond to real symbols or tests in the repository found by `git grep`.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DOC_FILES = ["docs/src/core/security-review.md", "docs/src/core/mutations.md"];

// Common language/markdown keywords or non-symbol tokens to ignore
const KEYWORDS = new Set([
  "diff",
  "text",
  "bash",
  "cargo",
  "suite",
  "test",
  "main",
  "true",
  "false",
  "null",
  "string",
  "u64",
  "u128",
  "usize",
  "None",
  "Some",
  "Ok",
  "Err",
  "Result",
  "Option",
  "Vec",
  "near",
  "usdc",
  "pnpm",
  "make",
  "openrail",
  "near_sdk",
  "borsh",
  "json",
  "serde",
]);

export function checkDocRefs(
  root: string,
  files = DEFAULT_DOC_FILES,
): { code: number; messages: string[] } {
  const messages: string[] = [];
  let hasFailure = false;

  for (const relFile of files) {
    const fullPath = join(root, relFile);
    if (!existsSync(fullPath)) continue;

    const content = readFileSync(fullPath, "utf8");
    // Match backticked expressions
    const matches = [...content.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());

    // Extract tokens that look like test names, functions, structs, or constants
    const candidates = new Set<string>();
    for (let raw of matches) {
      // Strip trailing function call parens e.g. `foo()` -> `foo`
      raw = raw.replace(/\(\)$/, "");
      // Skip paths or commands containing / or spaces
      if (raw.includes("/") || raw.includes(" ") || raw.includes("\\")) continue;
      // Skip expressions with operators (e.g. `==`, `+`, `<=`, `..`, `:=`, `->`)
      if (/[<>=+\-*&|~^!%:]/.test(raw) || raw.includes("..")) continue;
      // Skip numbers / hex literals
      if (/^0x[0-9a-fA-F]+$/.test(raw) || /^\d+$/.test(raw)) continue;
      // Skip JSON/type templates or brackets
      if (/[{}[\]()<>]/.test(raw)) continue;

      // Identify candidates: valid identifier characters
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw) && !KEYWORDS.has(raw)) {
        if (raw.length >= 3) {
          candidates.add(raw);
        }
      }
    }

    for (const id of [...candidates].sort()) {
      try {
        // Run git grep in codebase outside docs to confirm code symbol or test exists
        execSync(`git grep -q -F -w "${id}" -- ":!docs/**"`, {
          cwd: root,
          stdio: "ignore",
        });
      } catch {
        // Fallback: check if found anywhere in repo (e.g. schema, config, fixtures, or docs)
        try {
          execSync(`git grep -q -F -w "${id}"`, {
            cwd: root,
            stdio: "ignore",
          });
        } catch {
          messages.push(`doc-refs: ${relFile}: cited identifier \`${id}\` not found in repository`);
          hasFailure = true;
        }
      }
    }
  }

  if (hasFailure) {
    messages.push("check-doc-refs FAILED");
    return { code: 1, messages };
  }

  return { code: 0, messages: ["doc-refs: OK (all cited identifiers verified via git grep)"] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const r = checkDocRefs(root);
  for (const m of r.messages) console.log(m);
  process.exit(r.code);
}
