#!/usr/bin/env node
// wasm import gate (blueprint §1.5 rule 1, §3.3): fail on any import whose module or
// field matches `gas_key|universal_state`. Also prints the size of every checked wasm.
//
//   node scripts/wasm-check.mjs <file.wasm> [...]
//   node scripts/wasm-check.mjs --self-test
//
// No dependencies: the wasm import section is parsed directly.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BANNED = /gas_key|universal_state/;

function uleb(bytes, start) {
  let result = 0;
  let shift = 0;
  let i = start;
  for (;;) {
    if (i >= bytes.length) throw new Error("truncated LEB128");
    const byte = bytes[i++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, i];
    shift += 7;
    if (shift > 35) throw new Error("LEB128 too long");
  }
}

function readName(bytes, start) {
  const [length, i] = uleb(bytes, start);
  const end = i + length;
  if (end > bytes.length) throw new Error("truncated name");
  return [Buffer.from(bytes.subarray(i, end)).toString("utf8"), end];
}

/** Imports as { module, field, kind }. Only the import section (id 2) is read. */
export function imports(bytes) {
  if (bytes.length < 8 || bytes.toString("latin1", 0, 4) !== "\0asm") {
    throw new Error("not a wasm module");
  }
  let i = 8;
  while (i < bytes.length) {
    const id = bytes[i++];
    const [size, body] = uleb(bytes, i);
    const end = body + size;
    if (end > bytes.length) throw new Error("truncated section");
    if (id === 2) {
      let j = body;
      const [count, afterCount] = uleb(bytes, j);
      j = afterCount;
      const out = [];
      for (let n = 0; n < count; n++) {
        const [module, afterModule] = readName(bytes, j);
        const [field, afterField] = readName(bytes, afterModule);
        j = afterField;
        const kind = bytes[j++];
        if (kind === 0) {
          [, j] = uleb(bytes, j); // type index
        } else if (kind === 1) {
          j += 1; // value type
          const [flags, afterFlags] = uleb(bytes, j);
          j = afterFlags;
          if (flags & 1) [, j] = uleb(bytes, j); // max
        } else if (kind === 2) {
          const [flags, afterFlags] = uleb(bytes, j);
          j = afterFlags;
          [, j] = uleb(bytes, j); // min
          if (flags & 1) [, j] = uleb(bytes, j); // max
        } else if (kind === 3) {
          j += 2; // elem type + reserved
        } else {
          throw new Error(`unknown import kind ${kind}`);
        }
        out.push({ module, field, kind });
      }
      return out;
    }
    i = end;
  }
  return [];
}

function violationsFor(file) {
  const bytes = readFileSync(file);
  const found = imports(bytes);
  const bad = found.filter((entry) => BANNED.test(entry.module) || BANNED.test(entry.field));
  return { bytes: bytes.length, found, bad };
}

function check(files) {
  let failed = false;
  for (const file of files) {
    let result;
    try {
      result = violationsFor(file);
    } catch (error) {
      console.error(`wasm-check FAIL: ${file}: ${error.message}`);
      failed = true;
      continue;
    }
    const importsText =
      result.found.length === 0
        ? "0 imports"
        : `${result.found.length} imports: ${result.found
            .map((entry) => `${entry.module}.${entry.field}`)
            .join(", ")}`;
    console.log(`${String(result.bytes).padStart(8)} bytes  ${file}  (${importsText})`);
    for (const entry of result.bad) {
      console.error(
        `wasm-check FAIL: ${file} imports banned host function ${entry.module}.${entry.field}`,
      );
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// A hand-made module with one banned import, and a clean one with none.
function minimalWasm({ field } = {}) {
  const type = Buffer.from([0x01, 0x60, 0x00, 0x00]); // () -> ()
  const typeSection = Buffer.concat([Buffer.from([0x01, type.length]), type]);
  const parts = [Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])];
  if (field !== undefined) {
    const moduleName = Buffer.from("env");
    const fieldName = Buffer.from(field);
    const entry = Buffer.concat([
      Buffer.from([moduleName.length]),
      moduleName,
      Buffer.from([fieldName.length]),
      fieldName,
      Buffer.from([0x00, 0x00]), // func import, type index 0
    ]);
    parts.push(Buffer.from([0x02, entry.length + 1, 0x01]), entry);
  }
  parts.push(typeSection);
  return Buffer.concat(parts);
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "wasm-check-"));
  try {
    const bad = join(dir, "banned.wasm");
    const clean = join(dir, "clean.wasm");
    writeFileSync(bad, minimalWasm({ field: "universal_state" }));
    writeFileSync(clean, minimalWasm());
    const badResult = violationsFor(bad);
    const cleanResult = violationsFor(clean);
    if (badResult.bad.length !== 1) {
      console.error("wasm-check self-test FAIL: banned import not detected");
      return 1;
    }
    if (cleanResult.bad.length !== 0 || cleanResult.found.length !== 0) {
      console.error("wasm-check self-test FAIL: clean fixture was flagged");
      return 1;
    }
    console.log("wasm-check self-test: OK (banned import detected, clean fixture passes)");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === "--self-test") {
  process.exit(selfTest());
}
if (args.length === 0) {
  console.error("usage: wasm-check.mjs <file.wasm> [...] | --self-test");
  process.exit(2);
}
process.exit(check(args));
