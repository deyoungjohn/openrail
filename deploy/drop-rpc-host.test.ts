import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "drop-rpc-host.sh");
const base = mkdtempSync(join(tmpdir(), "openrail-drop-rpc-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function folder(files: Record<string, string>) {
  const dir = mkdtempSync(join(base, "etc-"));
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, text);
    chmodSync(path, 0o600);
  }
  return dir;
}
const run = (dir: string, ...args: string[]) =>
  spawnSync("bash", [SCRIPT, "rpc.mainnet.near.org", ...args, dir], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });

describe("drop-rpc-host removes one RPC host from every service env file", () => {
  const payout = [
    "NEAR_ENV=mainnet",
    "NEAR_RPC_URL=https://quick.example/secretkey",
    "NEAR_RPC_URL_FALLBACK=https://free.rpc.fastnear.com",
    "NEAR_RPC_URL_FALLBACK_1=https://free.rpc.fastnear.com",
    "NEAR_RPC_URL_FALLBACK_2=https://rpc.mainnet.near.org",
    "NEAR_RPC_URL_FALLBACK_2=https://free.rpc.fastnear.com",
    "PAYOUT_API_URL=http://127.0.0.1:3001",
    "",
  ].join("\n");

  it("drops only the lines on that host and keeps everything else, owner and mode", () => {
    const dir = folder({
      "payout.env": payout,
      "api.env": "NEAR_RPC_URL_FALLBACK=https://rpc.mainnet.near.org/\nX=1\n",
    });
    const result = run(dir);
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(join(dir, "payout.env"), "utf8");
    expect(text).not.toContain("rpc.mainnet.near.org");
    expect(text).toContain("NEAR_RPC_URL=https://quick.example/secretkey");
    expect(text).toContain("NEAR_RPC_URL_FALLBACK_2=https://free.rpc.fastnear.com");
    expect(text).toContain("PAYOUT_API_URL=http://127.0.0.1:3001");
    expect(readFileSync(join(dir, "api.env"), "utf8")).toBe("X=1\n");
    expect(statSync(join(dir, "payout.env")).mode & 0o777).toBe(0o600);
    // names and host only: never a whole URL
    expect(result.stdout).toContain(
      "payout.env: removed NEAR_RPC_URL_FALLBACK_2 (rpc.mainnet.near.org)",
    );
    expect(result.stdout).not.toContain("secretkey");
  });

  it("--dry-run changes nothing", () => {
    const dir = folder({ "payout.env": payout });
    const result = run(dir, "--dry-run");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("would remove");
    expect(readFileSync(join(dir, "payout.env"), "utf8")).toBe(payout);
  });

  it("refuses a file whose primary NEAR_RPC_URL is on that host (no service is left without an RPC)", () => {
    const dir = folder({
      "a.env":
        "NEAR_RPC_URL=https://rpc.mainnet.near.org\nNEAR_RPC_URL_FALLBACK=https://free.rpc.fastnear.com\n",
    });
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("REFUSED a.env");
    expect(readFileSync(join(dir, "a.env"), "utf8")).toContain("rpc.mainnet.near.org");
  });

  it("says so when there is nothing to remove", () => {
    const dir = folder({ "a.env": "NEAR_RPC_URL=https://quick.example/k\n" });
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing on rpc.mainnet.near.org");
  });
});
