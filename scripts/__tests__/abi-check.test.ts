import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAbi } from "../abi-check.js";

let root: string;

function write(rel: string, data: unknown): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
}

const core = (names: string[]) => ({
  interface: "v1",
  methods: names.map((name) => ({ name, kind: "call" })),
  events: [],
});
const built = (names: string[]) => ({
  body: { functions: names.map((name) => ({ name, kind: "call" })) },
});

function modules(list: { id: string; enabled: boolean }[]): void {
  write("openrail.modules.json", { modules: list });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "abi-"));
  modules([{ id: "alpha", enabled: true }]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const BUILT = "target/near/openrail/openrail_abi.json";

describe("checkAbi", () => {
  it("skips with a clear message until abi/openrail.core.json exists", () => {
    const r = checkAbi(root);
    expect(r.code).toBe(0);
    expect(r.messages.join("\n")).toMatch(/skip/i);
  });

  it("passes when the exported methods equal the core list", () => {
    write("abi/openrail.core.json", core(["a", "b"]));
    write(BUILT, built(["b", "a"]));
    expect(checkAbi(root).code).toBe(0);
  });

  it("fails on a missing method", () => {
    write("abi/openrail.core.json", core(["a", "b"]));
    write(BUILT, built(["a"]));
    const r = checkAbi(root);
    expect(r.code).toBe(1);
    expect(r.messages.join("\n")).toMatch(/missing.*b/);
  });

  it("fails on an extra method", () => {
    write("abi/openrail.core.json", core(["a"]));
    write(BUILT, built(["a", "sneaky"]));
    const r = checkAbi(root);
    expect(r.code).toBe(1);
    expect(r.messages.join("\n")).toMatch(/extra.*sneaky/);
  });

  it("adds an enabled module's methods from its abi.json", () => {
    write("abi/openrail.core.json", core(["a"]));
    write("contracts/openrail/src/modules/alpha/abi.json", { methods: ["alpha_do"] });
    write(BUILT, built(["a", "alpha_do"]));
    expect(checkAbi(root).code).toBe(0);
    write(BUILT, built(["a"]));
    expect(checkAbi(root).code).toBe(1);
  });

  it("a disabled module exports nothing", () => {
    modules([{ id: "alpha", enabled: false }]);
    write("abi/openrail.core.json", core(["a"]));
    write("contracts/openrail/src/modules/alpha/abi.json", { methods: ["alpha_do"] });
    write(BUILT, built(["a", "alpha_do"]));
    expect(checkAbi(root).code).toBe(1);
    write(BUILT, built(["a"]));
    expect(checkAbi(root).code).toBe(0);
  });

  it("fails when the core list exists but nothing was built", () => {
    write("abi/openrail.core.json", core(["a"]));
    const r = checkAbi(root);
    expect(r.code).toBe(1);
    expect(r.messages.join("\n")).toContain("make contract");
  });
});
