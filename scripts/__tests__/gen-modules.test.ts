import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generate, run, SERVICES } from "../gen-modules.js";

// Fixture repos use made-up module ids only.
let root: string;

function write(rel: string, text: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

function fixture(mods: { id: string; enabled: boolean }[], features: string[]): void {
  write("openrail.modules.json", JSON.stringify({ modules: mods }));
  write(
    "contracts/openrail/Cargo.toml",
    `[package]\nname = "x"\n\n[features]\n${features.map((f) => `${f} = []`).join("\n")}\n\n[dependencies]\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genmod-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("generate", () => {
  it("emits an empty registry for every service when no module folder exists", () => {
    fixture([{ id: "alpha", enabled: true }], ["alpha"]);
    const { files, errors } = generate(root);
    expect(errors).toEqual([]);
    for (const s of SERVICES) {
      const f = files[`services/${s}/src/enabled.ts`];
      expect(f).toContain("// GENERATED, do not edit");
      expect(f).toContain("export const enabledModules");
      expect(f).not.toContain("alpha");
      expect(f).not.toContain("import ");
    }
    const rs = files["contracts/openrail/src/modules/mod.rs"];
    expect(rs).toContain("// GENERATED, do not edit");
    expect(rs).toContain("pub const ENABLED: &[&str] = &[];");
    expect(rs).toContain(
      "pub fn registered() -> Vec<&'static dyn crate::hooks::Hook> {\n    Vec::new()\n}",
    );
    expect(rs).not.toContain("alpha");
  });

  it("imports only enabled modules whose folder exists", () => {
    fixture(
      [
        { id: "alpha", enabled: true },
        { id: "beta", enabled: true },
      ],
      ["alpha", "beta"],
    );
    write("services/api/src/modules/alpha/index.ts", "export {};\n");
    write("services/web/src/modules/alpha/index.ts", "export {};\n");
    mkdirSync(join(root, "contracts/openrail/src/modules/alpha"), { recursive: true });
    const { files, errors } = generate(root);
    expect(errors).toEqual([]);
    const api = files["services/api/src/enabled.ts"];
    expect(api).toContain(`from "./modules/alpha/index.js"`);
    expect(api).toContain(`id: "alpha"`);
    expect(api).not.toContain("beta");
    expect(files["services/cli/src/enabled.ts"]).not.toContain("alpha");
    expect(files["services/web/src/enabled.ts"]).toContain("alpha");
    const rs = files["contracts/openrail/src/modules/mod.rs"];
    expect(rs).toContain(`#[cfg(feature = "alpha")]`);
    expect(rs).toContain("pub mod alpha;");
    expect(rs).toContain("&alpha::HOOK");
    expect(rs).not.toContain("beta");
  });

  it("emits multiple hook references when multiple module folders exist", () => {
    fixture(
      [
        { id: "alpha", enabled: true },
        { id: "beta", enabled: true },
      ],
      ["alpha", "beta"],
    );
    mkdirSync(join(root, "contracts/openrail/src/modules/alpha"), { recursive: true });
    mkdirSync(join(root, "contracts/openrail/src/modules/beta"), { recursive: true });
    const { files, errors } = generate(root);
    expect(errors).toEqual([]);
    const rs = files["contracts/openrail/src/modules/mod.rs"];
    expect(rs).toContain("&alpha::HOOK");
    expect(rs).toContain("&beta::HOOK");
    expect(rs).toMatch(
      /vec!\[\s*#\[cfg\(feature = "alpha"\)\]\s*&alpha::HOOK,\s*#\[cfg\(feature = "beta"\)\]\s*&beta::HOOK,\s*\]/,
    );
  });

  it("emits a support component only when a module that needs it is enabled", () => {
    write(
      "openrail.modules.json",
      JSON.stringify({
        modules: [
          { id: "alpha", enabled: true },
          { id: "beta", enabled: false },
        ],
        support: [
          { id: "carrier", enabled_if: ["alpha", "beta"] },
          { id: "idle", enabled_if: ["beta"] },
        ],
      }),
    );
    write("contracts/openrail/Cargo.toml", `[package]\nname = "x"\n\n[features]\nalpha = []\n`);
    mkdirSync(join(root, "contracts/openrail/src/modules/carrier"), { recursive: true });
    mkdirSync(join(root, "contracts/openrail/src/modules/idle"), { recursive: true });
    const { files, errors } = generate(root);
    expect(errors).toEqual([]);
    const rs = files["contracts/openrail/src/modules/mod.rs"];
    // Only the enabled enablers appear in the cfg; no hook, not in ENABLED.
    expect(rs).toContain(`#[cfg(any(feature = "alpha"))]\npub mod carrier;`);
    expect(rs).not.toContain("carrier::HOOK");
    expect(rs).not.toMatch(/"carrier",/);
    expect(rs).not.toContain("idle");
  });

  it("rejects a support component whose enablers are not module ids", () => {
    write(
      "openrail.modules.json",
      JSON.stringify({
        modules: [{ id: "alpha", enabled: true }],
        support: [
          { id: "carrier", enabled_if: ["nosuch"] },
          { id: "alpha", enabled_if: ["alpha"] },
        ],
      }),
    );
    write("contracts/openrail/Cargo.toml", `[package]\nname = "x"\n\n[features]\nalpha = []\n`);
    const { errors } = generate(root);
    expect(errors.join("\n")).toContain("support carrier: unknown module nosuch");
    expect(errors.join("\n")).toContain("support id clashes with a module id: alpha");
  });

  it("never emits a disabled module even when its folder exists", () => {
    fixture(
      [
        { id: "alpha", enabled: true },
        { id: "gamma", enabled: false },
      ],
      ["alpha"],
    );
    for (const s of SERVICES) write(`services/${s}/src/modules/gamma/index.ts`, "export {};\n");
    mkdirSync(join(root, "contracts/openrail/src/modules/gamma"), { recursive: true });
    const { files, errors } = generate(root);
    expect(errors).toEqual([]);
    for (const text of Object.values(files)) expect(text).not.toContain("gamma");
  });

  it("fails when the Cargo features differ from the enabled ids", () => {
    fixture([{ id: "alpha", enabled: true }], ["alpha", "extra"]);
    expect(generate(root).errors.join("\n")).toMatch(/extra/);
    fixture([{ id: "alpha", enabled: true }], []);
    expect(generate(root).errors.join("\n")).toMatch(/alpha/);
    fixture([{ id: "alpha", enabled: false }], ["alpha"]);
    expect(generate(root).errors.join("\n")).toMatch(/alpha/);
  });

  it("tolerates a `default` feature and rejects bad or duplicate ids", () => {
    fixture([{ id: "alpha", enabled: true }], ["default", "alpha"]);
    expect(generate(root).errors).toEqual([]);
    fixture([{ id: "Bad-Id", enabled: true }], []);
    expect(generate(root).errors.join("\n")).toMatch(/invalid module id/);
    fixture(
      [
        { id: "alpha", enabled: true },
        { id: "alpha", enabled: true },
      ],
      ["alpha"],
    );
    expect(generate(root).errors.join("\n")).toMatch(/duplicate/);
  });
});

describe("run", () => {
  it("writes the files, then --check passes; a hand edit makes --check fail", () => {
    fixture([{ id: "alpha", enabled: true }], ["alpha"]);
    expect(run(root, { check: true }).ok).toBe(false); // nothing written yet
    expect(run(root, { check: false }).ok).toBe(true);
    expect(existsSync(join(root, "services/api/src/enabled.ts"))).toBe(true);
    expect(run(root, { check: true }).ok).toBe(true);
    write(
      "services/api/src/enabled.ts",
      readFileSync(join(root, "services/api/src/enabled.ts"), "utf8") + "// edit\n",
    );
    const r = run(root, { check: true });
    expect(r.ok).toBe(false);
    expect(r.messages.join("\n")).toContain("services/api/src/enabled.ts");
  });

  it("does not write when the features check fails", () => {
    fixture([{ id: "alpha", enabled: true }], []);
    expect(run(root, { check: false }).ok).toBe(false);
    expect(existsSync(join(root, "services/api/src/enabled.ts"))).toBe(false);
  });
});
