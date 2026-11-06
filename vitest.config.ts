import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    testTimeout: 30_000,
    // `target/` holds build output and the tree of the contract the upgrade test builds as its baseline;
    // the copies of the scripts' tests in there must never run (one of them waits forever).
    exclude: [...configDefaults.exclude, "target/**"],
  },
});
