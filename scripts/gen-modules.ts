/**
 * Reads openrail.modules.json and writes the generated module registries:
 *   services/<svc>/src/enabled.ts          (api, watcher, indexer, relayer, cli, web)
 *   contracts/openrail/src/modules/mod.rs
 * A disabled module is never emitted. A module is imported only if its folder exists.
 * Also checks that the [features] table of contracts/openrail/Cargo.toml equals the enabled ids.
 *
 *   pnpm tsx scripts/gen-modules.ts           write the files
 *   pnpm tsx scripts/gen-modules.ts --check   fail if the committed files differ
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICES = ["api", "watcher", "indexer", "relayer", "cli", "web"] as const;
const HEADER = "GENERATED, do not edit. Source: openrail.modules.json (scripts/gen-modules.ts).";
const ID_RE = /^[a-z][a-z0-9_]*$/;

interface ModuleEntry {
  id: string;
  enabled: boolean;
}

export interface Generated {
  files: Record<string, string>;
  errors: string[];
}

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

function readModules(root: string): ModuleEntry[] {
  const raw = JSON.parse(readFileSync(join(root, "openrail.modules.json"), "utf8")) as {
    modules: ModuleEntry[];
  };
  return raw.modules;
}

/** Feature names declared in the [features] table of a Cargo.toml (no TOML dependency needed). */
function cargoFeatures(root: string): string[] {
  const text = readFileSync(join(root, "contracts/openrail/Cargo.toml"), "utf8");
  const names: string[] = [];
  let inFeatures = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) {
      inFeatures = t === "[features]";
      continue;
    }
    const m = inFeatures ? /^([A-Za-z0-9_-]+)\s*=/.exec(t) : null;
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

function serviceFile(svc: string, ids: string[]): string {
  const ext = svc === "web" ? "" : "/index.js"; // web is bundled; services run under NodeNext
  const imports = ids.map((id) => `import * as m_${id} from "./modules/${id}${ext}";`);
  const items = ids.map((id) => `  { id: "${id}", module: m_${id} },`);
  return [
    `// ${HEADER}`,
    ...imports,
    "",
    "export interface EnabledModule {",
    "  readonly id: string;",
    "  readonly module: unknown;",
    "}",
    "",
    ...(items.length === 0
      ? ["export const enabledModules: readonly EnabledModule[] = [];"]
      : ["export const enabledModules: readonly EnabledModule[] = [", ...items, "];"]),
    "",
  ].join("\n");
}

function modRs(ids: string[]): string {
  const mods = ids.flatMap((id) => [`#[cfg(feature = "${id}")]`, `pub mod ${id};`]);
  const items = ids.flatMap((id) => [`    #[cfg(feature = "${id}")]`, `    "${id}",`]);
  return [
    `// ${HEADER}`,
    ...mods,
    "",
    "/// Ids of the modules compiled into this build.",
    ...(items.length === 0
      ? ["pub const ENABLED: &[&str] = &[];"]
      : ["pub const ENABLED: &[&str] = &[", ...items, "];"]),
    "",
  ].join("\n");
}

export function generate(root: string): Generated {
  const errors: string[] = [];
  const modules = readModules(root);
  const seen = new Set<string>();
  for (const m of modules) {
    if (!ID_RE.test(m.id)) errors.push(`invalid module id: ${JSON.stringify(m.id)}`);
    if (seen.has(m.id)) errors.push(`duplicate module id: ${m.id}`);
    seen.add(m.id);
  }
  const enabled = modules.filter((m) => m.enabled && ID_RE.test(m.id)).map((m) => m.id);

  const have = new Set(cargoFeatures(root).filter((f) => f !== "default"));
  for (const id of enabled) {
    if (!have.has(id))
      errors.push(`contracts/openrail/Cargo.toml [features] is missing enabled module: ${id}`);
  }
  for (const f of have) {
    if (!enabled.includes(f)) {
      errors.push(
        `contracts/openrail/Cargo.toml [features] has a feature that is not an enabled module: ${f}`,
      );
    }
  }

  const files: Record<string, string> = {};
  for (const svc of SERVICES) {
    const ids = enabled.filter((id) =>
      existsSync(join(root, `services/${svc}/src/modules/${id}/index.ts`)),
    );
    files[`services/${svc}/src/enabled.ts`] = serviceFile(svc, ids);
  }
  const rustIds = enabled.filter((id) => isDir(join(root, `contracts/openrail/src/modules/${id}`)));
  files["contracts/openrail/src/modules/mod.rs"] = modRs(rustIds);
  return { files, errors };
}

export function run(root: string, opts: { check: boolean }): { ok: boolean; messages: string[] } {
  const { files, errors } = generate(root);
  const messages = [...errors];
  if (errors.length > 0) return { ok: false, messages };
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    if (opts.check) {
      const current = existsSync(p) ? readFileSync(p, "utf8") : null;
      if (current !== text)
        messages.push(`out of date: ${rel} (run: pnpm tsx scripts/gen-modules.ts)`);
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  }
  return { ok: messages.length === 0, messages };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const check = process.argv.includes("--check");
  const r = run(root, { check });
  for (const m of r.messages) console.error(`gen-modules: ${m}`);
  if (!r.ok) process.exit(1);
  console.log(`gen-modules: ${check ? "up to date" : "written"}`);
}
