import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "openrail-split-merge-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function run(options: {
  combined: string;
  existing?: Record<string, string>;
  answers?: string;
  policy?: string;
}) {
  const dir = mkdtempSync(join(base, "case-"));
  const src = join(dir, "combined.env");
  writeFileSync(src, options.combined, { mode: 0o600 });
  const out = join(dir, "etc");
  spawnSync("mkdir", ["-p", out]);
  for (const [svc, text] of Object.entries(options.existing ?? {})) {
    writeFileSync(join(out, `${svc}.env`), text, { mode: 0o600 });
  }
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir };
  if (options.answers !== undefined) {
    const file = join(dir, "answers");
    writeFileSync(file, options.answers);
    env.OPENRAIL_ENV_ANSWERS = file;
  }
  if (options.policy !== undefined) env.OPENRAIL_ENV_CONFLICT = options.policy;
  const result = spawnSync("bash", [join(REPO, "deploy/split-env.sh"), src, out], {
    env,
    encoding: "utf8",
  });
  const read = (svc: string) => readFileSync(join(out, `${svc}.env`), "utf8");
  return { result, read, out };
}

describe("split-env merges into a service file that is already on the server", () => {
  const existing = {
    api: [
      "# api process environment.",
      "NEAR_ROOT_ACCOUNT=openrail.near",
      "NEAR_RPC_URL=https://old.rpc.example/secretkey",
      "CONFIDENTIAL_INTENTS=1",
      "ONLY_ON_THE_SERVER=keep-me",
      "",
    ].join("\n"),
  };
  const combined = [
    "NEAR_ROOT_ACCOUNT=openrail.near",
    "NEAR_RPC_URL=https://new.rpc.example/otherkey",
    "NEAR_RPC_URL_FALLBACK=https://fallback.example",
  ].join("\n");

  it("split_env_keeps_server_only_names_and_appends_new_ones_and_asks_about_differences", () => {
    const { result, read } = run({ combined, existing, answers: "k\n" });
    expect(result.status, result.stderr).toBe(0);
    const api = read("api");
    expect(api).toContain("ONLY_ON_THE_SERVER=keep-me");
    expect(api).toContain("CONFIDENTIAL_INTENTS=1");
    expect(api).toContain("# api process environment.");
    // the new fallback is appended, the different primary asked about and kept
    expect(api).toContain("NEAR_RPC_URL_FALLBACK=https://fallback.example");
    expect(api).toContain("NEAR_RPC_URL=https://old.rpc.example/secretkey");
    expect(api).not.toContain("new.rpc.example");
    // the question shows hosts, never the whole value
    expect(result.stderr).toContain("NEAR_RPC_URL differs");
    expect(result.stderr).toContain("https://old.rpc.example/...");
    expect(result.stderr).not.toContain("secretkey");
    expect(result.stderr).not.toContain("otherkey");
  });

  it("answer o overwrites that one name and nothing else", () => {
    const { result, read } = run({ combined, existing, answers: "o\n" });
    expect(result.status, result.stderr).toBe(0);
    const api = read("api");
    expect(api).toContain("NEAR_RPC_URL=https://new.rpc.example/otherkey");
    expect(api).toContain("ONLY_ON_THE_SERVER=keep-me");
    expect(api).toContain("CONFIDENTIAL_INTENTS=1");
    expect(api).not.toContain("old.rpc.example");
  });

  it("O and K answer for all the rest", () => {
    const two = {
      api: "NEAR_RPC_URL=https://old.example/a\nNEAR_ROOT_ACCOUNT=old.near\n",
    };
    const both = ["NEAR_RPC_URL=https://new.example/a", "NEAR_ROOT_ACCOUNT=new.near"].join("\n");
    const o = run({ combined: both, existing: two, answers: "O\n" });
    expect(o.read("api")).toContain("NEAR_ROOT_ACCOUNT=new.near");
    expect(o.read("api")).toContain("NEAR_RPC_URL=https://new.example/a");
    const k = run({ combined: both, existing: two, answers: "K\n" });
    expect(k.read("api")).toContain("NEAR_ROOT_ACCOUNT=old.near");
    expect(k.read("api")).toContain("NEAR_RPC_URL=https://old.example/a");
  });

  it("without a terminal and without answers the server's values are kept (nothing is replaced silently)", () => {
    const { result, read } = run({ combined, existing });
    expect(result.status, result.stderr).toBe(0);
    expect(read("api")).toContain("NEAR_RPC_URL=https://old.rpc.example/secretkey");
    expect(read("api")).toContain("NEAR_RPC_URL_FALLBACK=https://fallback.example");
  });

  it("OPENRAIL_ENV_CONFLICT=overwrite takes the new values when no one can be asked", () => {
    const { read } = run({ combined, existing, policy: "overwrite" });
    expect(read("api")).toContain("NEAR_RPC_URL=https://new.rpc.example/otherkey");
    expect(read("api")).toContain("ONLY_ON_THE_SERVER=keep-me");
  });

  it("a service file that does not exist yet is written whole, as before", () => {
    const { result, read } = run({ combined });
    expect(result.status, result.stderr).toBe(0);
    expect(read("api")).toContain("NEAR_RPC_URL=https://new.rpc.example/otherkey");
    expect(read("api")).toContain("NEAR_RPC_URL_FALLBACK=https://fallback.example");
  });
});
