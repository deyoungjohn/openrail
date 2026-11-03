/**
 * Docs assembler (`make docs`). Copies docs/src/core/**.md and docs/src/modules/<id>/**.md for
 * ENABLED modules only into docs/dist/ (git-ignored), stripping YAML front matter, and fails on
 * broken relative links. Links resolve from the source file (so ../../../evidence/x works) and
 * must not point into a disabled module's docs. Does not touch the root README.md.
 * An empty or missing docs/src is a success.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDocRefs } from "./check-doc-refs.ts";

function mdFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) mdFiles(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

function stripFrontMatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  return end === -1 ? text : text.slice(end + 5);
}

export function buildDocs(root: string): { code: number; messages: string[] } {
  const src = join(root, "docs/src");
  const dist = join(root, "docs/dist");
  const messages: string[] = [];
  rmSync(dist, { recursive: true, force: true });
  if (!existsSync(src))
    return { code: 0, messages: ["docs: nothing to build (docs/src is missing)"] };

  const modules = (
    JSON.parse(readFileSync(join(root, "openrail.modules.json"), "utf8")) as {
      modules: { id: string; enabled: boolean }[];
    }
  ).modules;
  const enabled = modules.filter((m) => m.enabled).map((m) => m.id);
  const disabledDirs = modules
    .filter((m) => !m.enabled)
    .map((m) => join(src, "modules", m.id) + "/");

  const sources = [
    ...mdFiles(join(src, "core")),
    ...enabled.flatMap((id) => mdFiles(join(src, "modules", id))),
  ];

  for (const file of sources) {
    const rel = relative(root, file);
    const raw = readFileSync(file, "utf8");
    let inFence = false;
    raw.split("\n").forEach((line, i) => {
      if (line.trimStart().startsWith("```")) inFence = !inFence;
      if (inFence) return;
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = (m[1] ?? "").split("#")[0] ?? "";
        if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const abs = resolve(dirname(file), target);
        if (disabledDirs.some((d) => (abs + "/").startsWith(d))) {
          messages.push(`${rel}:${i + 1}: link into a switched-off module's docs`);
        } else if (!existsSync(abs)) {
          messages.push(`${rel}:${i + 1}: broken link ${target}`);
        }
      }
    });
  }
  if (messages.length > 0) return { code: 1, messages: [...messages, "docs FAILED"] };

  for (const file of sources) {
    const out = join(dist, relative(src, file));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, stripFrontMatter(readFileSync(file, "utf8")));
  }

  const refCheck = checkDocRefs(root);
  if (refCheck.code !== 0) {
    return { code: refCheck.code, messages: [...refCheck.messages, "docs FAILED"] };
  }

  return {
    code: 0,
    messages: [`docs: OK (${sources.length} file(s) into docs/dist)`, ...refCheck.messages],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const r = buildDocs(root);
  for (const m of r.messages) console.log(m);
  process.exit(r.code);
}
