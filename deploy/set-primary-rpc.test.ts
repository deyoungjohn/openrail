import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "set-primary-rpc.sh");
const base = mkdtempSync(join(tmpdir(), "openrail-primary-rpc-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const NEW = "https://node.quiknode.pro/secretkey";

function setup() {
  const dir = mkdtempSync(join(base, "etc-"));
  for (const name of ["watcher", "payout", "indexer", "api", "issuer"]) {
    const path = join(dir, `${name}.env`);
    writeFileSync(
      path,
      `FOO=1\nNEAR_RPC_URL=https://old.example/a\nNEAR_RPC_URL_FALLBACK_1=${NEW}\nNEAR_RPC_URL_FALLBACK_8=https://near.drpc.org\n`,
    );
    chmodSync(path, 0o600);
  }
  const mine = join(dir, "mine.env");
  writeFileSync(mine, `X=1\nNEAR_RPC_URL=${NEW}\n`);
  return { dir, mine };
}
const run = (mine: string, dir: string, ...args: string[]) =>
  spawnSync("bash", [SCRIPT, "--file", mine, "--dir", dir, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });

describe("set-primary-rpc makes one URL the primary everywhere", () => {
  it("a dry run writes nothing and never prints the URL", () => {
    const { dir, mine } = setup();
    const before = readFileSync(join(dir, "watcher.env"), "utf8");
    const r = run(mine, dir, "--dry-run");
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "watcher.env"), "utf8")).toBe(before);
    expect(r.stdout + r.stderr).not.toContain("secretkey");
  });

  it("sets the primary, keeps the old one as a fallback, removes the duplicate, backs up, keeps the mode", () => {
    const { dir, mine } = setup();
    const r = run(mine, dir);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("secretkey");
    const text = readFileSync(join(dir, "watcher.env"), "utf8");
    expect(text).toContain(`NEAR_RPC_URL=${NEW}\n`);
    expect(text).toContain("NEAR_RPC_URL_FALLBACK_1=https://old.example/a");
    expect(text).toContain("NEAR_RPC_URL_FALLBACK_8=https://near.drpc.org");
    expect(text.match(new RegExp(NEW, "g"))).toHaveLength(1);
    expect(statSync(join(dir, "watcher.env")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((n) => n.startsWith("watcher.env.bak.")).length).toBe(1);
  });

  it("stops when no URL matches", () => {
    const { dir, mine } = setup();
    expect(run(mine, dir, "--match", "nothing-like-this").status).toBe(2);
  });
});
