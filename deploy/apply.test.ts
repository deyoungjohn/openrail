import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A call to a function that is not defined only fails on the server, after the release is already live
// ("prune_packs: command not found" after a healthy apply). This catches it before.
describe("deploy scripts call only functions they define", () => {
  for (const file of ["apply.sh", "fetch.sh"]) {
    it(file, () => {
      const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const defined = new Set([...text.matchAll(/^([a-z_][a-z0-9_]*)\(\)/gm)].map((m) => m[1]));
      const called = new Set(
        [
          ...text.matchAll(
            /^\s+(prune_\w+|switch_to|install_unit_files|restart_all|wait_healthy|show_failures|current_target|home_of_caller)\b/gm,
          ),
        ].map((m) => m[1]),
      );
      for (const name of called)
        expect(defined, `${file} calls ${name} but never defines it`).toContain(name);
    });
  }
});
