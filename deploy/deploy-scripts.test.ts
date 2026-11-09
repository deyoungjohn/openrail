import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = join(REPO, "deploy/apply.sh");
const FETCH = join(REPO, "deploy/fetch.sh");
const BASE = mkdtempSync(join(tmpdir(), "openrail-deploy-scripts-"));
const HOME = join(BASE, "home");
const SHIM = join(BASE, "bin");
const LOG = join(BASE, "shim.log");
let packSource = "";

function writeShim(name: string, body: string): void {
  const path = join(SHIM, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function applyEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${SHIM}:${process.env.PATH ?? ""}`,
    HOME,
    OPENRAIL_HOME: HOME,
    OPENRAIL_ROOT: join(BASE, "opt"),
    OPENRAIL_ETC: join(BASE, "etc"),
    OPENRAIL_UNIT_DIR: join(BASE, "units"),
    OPENRAIL_CADDYFILE: join(BASE, "Caddyfile"),
    OPENRAIL_SELF_COPY: join(BASE, "self/openrail-apply"),
    OPENRAIL_TEST: "0",
    OPENRAIL_HEALTH_WAIT: "1",
    SHIM_LOG: LOG,
    SHIM_HOME: HOME,
    SHIM_CURL_MODE: "health",
    ...extra,
  };
}

function run(script: string, args: string[], extra: Record<string, string> = {}) {
  writeFileSync(LOG, "");
  return spawnSync("bash", [script, ...args], {
    cwd: REPO,
    env: applyEnv(extra),
    encoding: "utf8",
    timeout: 300_000,
  });
}

function shimCalls(): string {
  return existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
}

function releases(): string[] {
  const dir = join(BASE, "opt/releases");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function currentRelease(): string | null {
  const link = join(BASE, "opt/current");
  return existsSync(link)
    ? execFileSync("readlink", ["-f", link], { encoding: "utf8" }).trim()
    : null;
}

function homePacks(): string[] {
  return readdirSync(HOME)
    .filter((name) => /^openrail-server-.*\.tar\.gz$/.test(name))
    .sort();
}

function tmpFetchDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("openrail-fetch.")));
}

beforeAll(() => {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(SHIM, { recursive: true });
  mkdirSync(join(BASE, "self"), { recursive: true });
  mkdirSync(join(BASE, "opt"), { recursive: true });
  mkdirSync(join(BASE, "etc"), { recursive: true });
  mkdirSync(join(BASE, "units"), { recursive: true });
  writeShim(
    "id",
    'if [[ -n "${SHIM_ID_REAL:-}" ]]; then exec /usr/bin/id "$@"; fi; if [[ "${1:-}" == "-u" ]]; then echo 0; else /usr/bin/id "$@"; fi',
  );
  writeShim(
    "systemctl",
    'if [[ "${1:-}" == "restart" ]]; then unit="${2:-}"; if [[ ! -f "$OPENRAIL_UNIT_DIR/$unit" ]]; then printf "systemctl missing %s\\n" "$unit" >> "$SHIM_LOG"; exit 1; fi; fi; printf "systemctl %s\\n" "$*" >> "$SHIM_LOG"; exit 0',
  );
  writeShim("journalctl", 'printf "journalctl %s\\n" "$*" >> "$SHIM_LOG"; exit 0');
  writeShim("chown", 'printf "chown %s\\n" "$*" >> "$SHIM_LOG"; exit 0');
  writeShim(
    "getent",
    'if [[ "${1:-}" == "passwd" ]]; then printf "%s:x:1000:1000::%s:/bin/bash\\n" "${2:-user}" "$SHIM_HOME"; else /usr/bin/getent "$@"; fi',
  );
  writeShim(
    "curl",
    `mode="\${SHIM_CURL_MODE:-health}"
if [[ "$mode" == "health" ]]; then
  if [[ -n "\${SHIM_HEALTH_FAIL_FIRST:-}" ]]; then
    n="$(cat "$SHIM_HEALTH_COUNTER" 2>/dev/null || echo 0)"
    n=$((n + 1))
    printf '%s\\n' "$n" > "$SHIM_HEALTH_COUNTER"
    (( n <= SHIM_HEALTH_FAIL_FIRST )) && exit 1
  fi
  exit 0
fi
args=("$@")
out=""
for ((i=0; i<\${#args[@]}; i++)); do
  if [[ "\${args[$i]}" == "-o" ]]; then out="\${args[$((i+1))]}"; fi
done
if [[ "$*" == *"/releases?per_page=30"* ]]; then cat "$SHIM_API_JSON"; exit 0; fi
if [[ -n "$out" ]]; then
  if [[ "$*" == *.sha256* ]]; then cp "$SHIM_SHA" "$out"; else cp "$SHIM_PACK" "$out"; fi
fi
exit 0`,
  );

  writeShim(
    "install",
    'args=(); while [[ $# -gt 0 ]]; do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; exec /usr/bin/install "${args[@]}"',
  );

  execFileSync(join(REPO, "deploy/build.sh"), { cwd: REPO, stdio: "inherit" });
  const dist = join(REPO, "dist");
  packSource = join(
    dist,
    readdirSync(dist)
      .filter((name) => /^openrail-server-.*\.tar\.gz$/.test(name))
      .sort((a, b) => statSync(join(dist, b)).mtimeMs - statSync(join(dist, a)).mtimeMs)[0] ?? "",
  );
  expect(existsSync(packSource)).toBe(true);
}, 30 * 60_000);

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true });
}, 120_000);

describe("openrail-apply end to end", () => {
  const first = join(HOME, "openrail-server-first.tar.gz");
  const second = join(HOME, "openrail-server-second.tar.gz");
  const unhealthy = join(HOME, "openrail-server-unhealthy.tar.gz");
  let firstRelease = "";
  const healthCounter = join(BASE, "health-counter");

  function clonePack(source: string, target: string): void {
    // A second gzip member changes the pack hash without rebuilding the 250 MB tree.
    const emptyDir = mkdtempSync(join(BASE, "empty-"));
    const emptyMember = join(BASE, "empty-member.tgz");
    execFileSync("tar", ["-czf", emptyMember, "-C", emptyDir, "."]);
    rmSync(emptyDir, { recursive: true, force: true });
    copyFileSync(source, target);
    appendFileSync(target, readFileSync(emptyMember));
  }

  beforeAll(() => {
    copyFileSync(packSource, first);
    clonePack(first, second);
  }, 300_000);

  it("packs the module workspace, unit files and env templates", () => {
    const list = execFileSync("tar", ["-tzf", packSource], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const entry of [
      "services/api/",
      "services/web/",
      "deploy/systemd/openrail-api.service",
      "deploy/env/api.env.example",
      "openrail.modules.json",
      "config/routes.json",
    ]) {
      expect(list).toContain(entry);
    }
    expect(
      JSON.parse(readFileSync(join(REPO, "openrail.modules.json"), "utf8")).modules.length,
    ).toBeGreaterThan(0);
  }, 120_000);

  it("dry-runs upload without a server or a copy", () => {
    const uploadEnv = join(BASE, "upload.env");
    writeFileSync(uploadEnv, "\n", { mode: 0o600 });
    const result = run(join(REPO, "deploy/upload.sh"), ["--dry-run"], {
      OPENRAIL_ENV: uploadEnv,
      SHIM_ID_REAL: "1",
      SERVER_IP: "203.0.113.10",
      SSH_KEY_FILE: join(BASE, "fake-key"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("scp -i");
    expect(result.stdout).toContain("openrail-server-");
  }, 120_000);

  it("the fake systemctl refuses to restart a unit that is not installed", () => {
    const result = spawnSync(
      join(SHIM, "systemctl"),
      ["restart", "openrail-not-installed.service"],
      {
        env: applyEnv(),
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(shimCalls()).toContain("systemctl missing openrail-not-installed.service");
  }, 120_000);

  it("installs the first release and records the restart calls", () => {
    const result = run(APPLY, [first]);
    expect(result.status, result.stderr).toBe(0);
    const current = currentRelease();
    expect(current).not.toBeNull();
    firstRelease = current!;
    expect(releases()).toEqual([current!.split("/").pop()!]);
    expect(shimCalls()).toContain("systemctl restart openrail-indexer.service");
    expect(shimCalls()).toContain("systemctl restart openrail-web.service");
  }, 300_000);

  it("installs a second release, keeps the previous pointer and prunes packs", () => {
    const result = run(APPLY, [second]);
    expect(result.status, result.stderr).toBe(0);
    const current = currentRelease();
    expect(current).not.toBeNull();
    expect(current).not.toBe(firstRelease);
    expect(readFileSync(join(BASE, "opt/previous"), "utf8").trim()).toBe(firstRelease);
    expect(releases()).toEqual([current!.split("/").pop()!]);
    expect(homePacks()).toHaveLength(2);
    expect(homePacks()).toContain("openrail-server-first.tar.gz");
    expect(homePacks()).toContain("openrail-server-second.tar.gz");
  }, 300_000);

  it("reinstalls the previous release with --rollback", () => {
    const result = run(APPLY, ["--rollback"]);
    expect(result.status, result.stderr).toBe(0);
    expect(currentRelease()).toBe(firstRelease);
    // Put the second release live again for the rollback-on-unhealthy case.
    const again = run(APPLY, [second]);
    expect(again.status, again.stderr).toBe(0);
  }, 300_000);

  it("rolls back from an unhealthy release and exits non-zero", () => {
    clonePack(second, unhealthy);
    const before = currentRelease();
    writeFileSync(healthCounter, "0");
    const result = run(APPLY, [unhealthy], {
      SHIM_HEALTH_FAIL_FIRST: "6",
      SHIM_HEALTH_COUNTER: healthCounter,
    });
    expect(result.status).not.toBe(0);
    expect(currentRelease()).toBe(before);
    expect(shimCalls()).toContain("systemctl restart openrail-web.service");
  }, 300_000);

  it("applies and shreds a waiting env upload", () => {
    const envFile = join(HOME, "openrail.env");
    writeFileSync(envFile, "NEAR_ROOT_ACCOUNT=root.test.invalid\n", { mode: 0o600 });
    const result = run(APPLY, [second]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(envFile)).toBe(false);
    expect(existsSync(join(BASE, "etc/api.env"))).toBe(true);
  }, 300_000);

  it("uses no leftover /tmp fetch directory for apply-only runs", () => {
    const before = tmpFetchDirs();
    const result = run(APPLY, [second]);
    expect(result.status, result.stderr).toBe(0);
    expect([...tmpFetchDirs()].filter((name) => !before.has(name))).toEqual([]);
  }, 300_000);
  it("installs and restarts a private module unit and its env template", () => {
    const dir = mkdtempSync(join(BASE, "private-pack-"));
    mkdirSync(join(dir, "deploy/systemd"), { recursive: true });
    mkdirSync(join(dir, "deploy/env"), { recursive: true });
    mkdirSync(join(dir, "services/extra"), { recursive: true });
    writeFileSync(join(dir, "services/extra/package.json"), '{"name":"@openrail/extra"}\n');
    writeFileSync(
      join(dir, "deploy/systemd/openrail-extra.service"),
      "[Service]\nExecStart=/bin/true\n",
    );
    writeFileSync(join(dir, "deploy/env/extra.env.example"), "EXTRA_PORT=\n");
    writeFileSync(
      join(dir, "deploy/split-env.sh"),
      readFileSync(join(REPO, "deploy/split-env.sh")),
    );
    writeFileSync(join(dir, "deploy/healthcheck.sh"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(dir, "deploy/split-env.sh"), 0o755);
    chmodSync(join(dir, "deploy/healthcheck.sh"), 0o755);
    const privatePack = join(HOME, "openrail-server-private.tar.gz");
    execFileSync("tar", ["-czf", privatePack, "-C", dir, "."]);
    rmSync(dir, { recursive: true, force: true });

    const envFile = join(HOME, "openrail.env");
    writeFileSync(envFile, "EXTRA_PORT=9000\n", { mode: 0o600 });
    const result = run(APPLY, [privatePack]);
    expect(result.status, result.stderr).toBe(0);
    expect(shimCalls()).toContain("systemctl restart openrail-extra.service");
    expect(existsSync(join(BASE, "units/openrail-extra.service"))).toBe(true);
    expect(existsSync(join(BASE, "etc/extra.env"))).toBe(true);
    expect(readFileSync(join(BASE, "etc/extra.env"), "utf8")).toContain("EXTRA_PORT=9000");
    expect(existsSync(envFile)).toBe(false);
  }, 300_000);
  it("leaves a unit stopped, and says why, when its environment file does not exist", () => {
    // The payout unit of a private build crash-looped on "Failed to load environment files" (9 Nov).
    const dir = mkdtempSync(join(BASE, "lonely-pack-"));
    mkdirSync(join(dir, "deploy/systemd"), { recursive: true });
    mkdirSync(join(dir, "deploy/env"), { recursive: true });
    mkdirSync(join(dir, "services/lonely"), { recursive: true });
    writeFileSync(join(dir, "services/lonely/package.json"), '{"name":"@openrail/lonely"}\n');
    writeFileSync(
      join(dir, "deploy/systemd/openrail-lonely.service"),
      "[Service]\nEnvironmentFile=/etc/openrail/lonely.env\nExecStart=/bin/true\n",
    );
    writeFileSync(join(dir, "deploy/env/lonely.env.example"), "LONELY_PORT=\n");
    writeFileSync(
      join(dir, "deploy/split-env.sh"),
      readFileSync(join(REPO, "deploy/split-env.sh")),
    );
    writeFileSync(join(dir, "deploy/healthcheck.sh"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(dir, "deploy/split-env.sh"), 0o755);
    chmodSync(join(dir, "deploy/healthcheck.sh"), 0o755);
    const pack = join(HOME, "openrail-server-lonely.tar.gz");
    execFileSync("tar", ["-czf", pack, "-C", dir, "."]);
    rmSync(dir, { recursive: true, force: true });

    const result = run(APPLY, [pack]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SKIPPED openrail-lonely.service");
    expect(result.stdout).toContain("lonely.env");
    expect(shimCalls()).not.toContain("systemctl restart openrail-lonely.service");
    expect(shimCalls()).toContain("systemctl disable --now openrail-lonely.service");
  }, 300_000);
});

describe("openrail-fetch end to end", () => {
  const apiJson = join(BASE, "releases.json");
  const sha = join(BASE, "pack.sha256");
  const badSha = join(BASE, "pack.bad.sha256");
  const fetched = join(HOME, "openrail-server-deadbee.tar.gz");
  const assetDir = join(BASE, "assets");
  const asset = join(assetDir, "openrail-server-deadbee.tar.gz");
  const applyLog = join(BASE, "apply-called.log");

  beforeAll(() => {
    mkdirSync(assetDir, { recursive: true });
    copyFileSync(packSource, asset);
    const sum = execFileSync("sha256sum", [asset], { encoding: "utf8" }).split(/\s+/)[0]!;
    writeFileSync(sha, `${sum}  openrail-server-deadbee.tar.gz\n`);
    writeFileSync(badSha, `${"0".repeat(64)}  openrail-server-deadbee.tar.gz\n`);
    writeFileSync(
      apiJson,
      JSON.stringify([{ tag_name: "server-deadbee", created_at: "2026-11-07T00:00:00Z" }]),
    );
    writeFileSync(applyLog, "");
    const fakeApply = join(BASE, "fake-apply");
    writeFileSync(fakeApply, `#!/usr/bin/env bash\necho "$@" > "${applyLog}"\nexit 0\n`);
    chmodSync(fakeApply, 0o755);
  });

  function fetchEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      SHIM_CURL_MODE: "fetch",
      SHIM_API_JSON: apiJson,
      SHIM_PACK: asset,
      SHIM_SHA: sha,
      OPENRAIL_GH_API: "https://api.test",
      OPENRAIL_GH_DL: "https://dl.test",
      OPENRAIL_APPLY: join(BASE, "fake-apply"),
      OPENRAIL_FETCH_SELF: join(BASE, "self/openrail-fetch"),
      ...extra,
    };
  }

  it("refuses a bad checksum and leaves no downloaded pack", () => {
    if (existsSync(fetched)) rmSync(fetched);
    const result = run(FETCH, ["deadbee"], fetchEnv({ SHIM_SHA: badSha }));
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/CHECKSUM_MISMATCH/);
    expect(existsSync(fetched)).toBe(false);
  }, 120_000);

  it("downloads, verifies, installs and cleans the download folder", () => {
    if (existsSync(fetched)) rmSync(fetched);
    const before = tmpFetchDirs();
    const result = run(FETCH, ["deadbee"], fetchEnv());
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(fetched)).toBe(true);
    expect([...tmpFetchDirs()].filter((name) => !before.has(name))).toEqual([]);
  }, 120_000);

  it("hands --apply to openrail-apply and cleans its download folder", () => {
    const before = tmpFetchDirs();
    const result = run(FETCH, ["--apply", "deadbee"], fetchEnv());
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(applyLog, "utf8")).toContain("openrail-server-deadbee.tar.gz");
    expect([...tmpFetchDirs()].filter((name) => !before.has(name))).toEqual([]);
  }, 120_000);
});
