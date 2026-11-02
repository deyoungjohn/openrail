import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WATCHER_GAS, WATCHER_METHOD_LIST, WATCHER_METHODS } from "./methods.js";

interface CoreAbi {
  methods: { name: string; kind: string }[];
}

const ABI = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../abi/openrail.core.json"),
    "utf8",
  ),
) as CoreAbi;

describe("watcher contract methods", () => {
  it("uses only methods declared as call in abi/openrail.core.json", () => {
    const methods = new Map(ABI.methods.map((method) => [method.name, method.kind]));
    for (const name of WATCHER_METHOD_LIST) {
      expect(methods.get(name), `${name} must be a core call method`).toBe("call");
    }
  });

  it("sends reconcile with 250 Tgas", () => {
    expect(WATCHER_GAS.reconcile).toBe(250_000_000_000_000n);
    expect(WATCHER_GAS[WATCHER_METHODS.reconcile]).toBe(250_000_000_000_000n);
  });
});
