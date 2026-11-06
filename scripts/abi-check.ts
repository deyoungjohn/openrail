/**
 * ABI check: after `make contract`, the built ABI's exported method names must equal
 * abi/openrail.core.json plus the methods of every ENABLED module
 * (contracts/openrail/src/modules/<id>/abi.json, `{"methods":[...]}`, if present).
 * A disabled module contributes nothing, so any of its methods is "extra".
 * Skips with a message until abi/openrail.core.json exists.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUILT_ABI = "target/near/openrail/openrail_abi.json";

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

export function checkAbi(root: string): { code: number; messages: string[] } {
  const corePath = join(root, "abi/openrail.core.json");
  if (!existsSync(corePath)) {
    return { code: 0, messages: ["abi-check: skipped, abi/openrail.core.json does not exist yet"] };
  }
  const builtPath = join(root, BUILT_ABI);
  if (!existsSync(builtPath)) {
    return {
      code: 1,
      messages: [`abi-check FAILED: ${BUILT_ABI} not found; run make contract first`],
    };
  }

  const expected = new Set(
    readJson<{ methods: { name: string }[] }>(corePath).methods.map((m) => m.name),
  );
  const registry = readJson<{
    modules: { id: string; enabled: boolean }[];
    support?: { id: string; enabled_if: string[] }[];
  }>(join(root, "openrail.modules.json"));

  const enabledModules = new Set(registry.modules.filter((x) => x.enabled).map((x) => x.id));
  for (const m of registry.modules.filter((x) => x.enabled)) {
    const p = join(root, `contracts/openrail/src/modules/${m.id}/abi.json`);
    if (existsSync(p))
      for (const name of readJson<{ methods: string[] }>(p).methods) expected.add(name);
  }
  for (const s of registry.support ?? []) {
    if (s.enabled_if.some((e) => enabledModules.has(e))) {
      const p = join(root, `contracts/openrail/src/modules/${s.id}/abi.json`);
      if (existsSync(p))
        for (const name of readJson<{ methods: string[] }>(p).methods) expected.add(name);
    }
  }

  const actual = new Set(
    readJson<{ body: { functions: { name: string }[] } }>(builtPath).body.functions.map(
      (f) => f.name,
    ),
  );
  const missing = [...expected].filter((n) => !actual.has(n)).sort();
  const extra = [...actual].filter((n) => !expected.has(n)).sort();
  const messages: string[] = [];
  if (missing.length) messages.push(`abi-check: missing methods: ${missing.join(", ")}`);
  if (extra.length) messages.push(`abi-check: extra methods: ${extra.join(", ")}`);
  if (messages.length) return { code: 1, messages: [...messages, "abi-check FAILED"] };
  return { code: 0, messages: [`abi-check: OK (${actual.size} methods)`] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const r = checkAbi(root);
  for (const m of r.messages) console.log(m);
  process.exit(r.code);
}
