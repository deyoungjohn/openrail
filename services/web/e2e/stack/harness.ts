import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { startFakeOneClickServer, type FakeOneClickServer } from "./fake-oneclick.js";

export interface SandboxConfig {
  rpcUrl: string;
  rootAccount: string;
  issuerAccountId: string;
  issuerPrivateKey: string;
  relayPrivateKey: string;
  watcherAccountId: string;
  watcherPrivateKey: string;
  aliceAccountId: string;
  bobAccountId: string;
  intentsAccountId: string;
  usdcAccountId: string;
}

export class FullStackHarness {
  public sandboxConfig!: SandboxConfig;
  public fakeOneClick!: FakeOneClickServer;
  private sandboxProcess?: ChildProcess;
  private issuerProcess?: ChildProcess;
  private indexerProcess?: ChildProcess;
  private apiProcess?: ChildProcess;
  private webProcess?: ChildProcess;

  public serviceKey = "stack-test-service-key";
  public issuerPort = 18787;
  public indexerPort = 18788;
  public apiPort = 8787;
  public webPort = 3100;

  public tmpDir: string;
  public apiDbPath: string;
  public indexerDbPath: string;

  constructor() {
    this.tmpDir = resolve(`/tmp/openrail-stack-${Date.now()}-${process.pid}`);
    mkdirSync(this.tmpDir, { recursive: true });
    this.apiDbPath = resolve(this.tmpDir, "api.sqlite");
    this.indexerDbPath = resolve(this.tmpDir, "indexer.sqlite");

    process.once("exit", () => {
      this.stopSync();
    });
  }

  stopSync(): void {
    const kill = (child?: ChildProcess) => {
      if (!child || child.killed) return;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    };
    kill(this.webProcess);
    kill(this.apiProcess);
    kill(this.indexerProcess);
    kill(this.issuerProcess);
    kill(this.sandboxProcess);

    const freePort = (port: number) => {
      try {
        execSync(`fuser -k -9 ${port}/tcp`, { stdio: "ignore" });
      } catch {
        // ignore
      }
    };
    freePort(this.webPort);
    freePort(this.apiPort);
    freePort(this.indexerPort);
    freePort(this.issuerPort);
  }

  async start(): Promise<void> {
    try {
      // 1. Start sandbox daemon
      await this.startSandbox();

      // 2. Start fake 1Click server
      this.fakeOneClick = await startFakeOneClickServer();

      // 3. Start issuer service
      await this.startIssuer();

      // 4. Start indexer service
      await this.startIndexer();

      // 5. Start API service
      await this.startApi();

      // 6. Start Web service
      await this.startWeb();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  private async startSandbox(): Promise<void> {
    const rootDir = resolve(import.meta.dirname, "../../../../");
    const binary = resolve(rootDir, "target/debug/stack_sandbox");
    if (!existsSync(binary)) {
      throw new Error(`stack_sandbox binary not found at ${binary}`);
    }

    const child = spawn(binary, [], {
      cwd: rootDir,
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        RUST_BACKTRACE: "1",
      },
    });
    this.sandboxProcess = child;

    const config = await new Promise<SandboxConfig>((resolvePromise, rejectPromise) => {
      let raw = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
        const lines = raw.split("\n");
        for (const line of lines) {
          if (line.includes("__STACK_SANDBOX_READY__")) {
            const jsonLine = lines.find((l) => l.trim().startsWith("{"));
            if (jsonLine) {
              try {
                const parsed = JSON.parse(jsonLine.trim()) as SandboxConfig;
                resolvePromise(parsed);
                return;
              } catch (e) {
                rejectPromise(e);
                return;
              }
            }
          }
        }
      });
      child.on("error", rejectPromise);
      child.on("exit", (code) => {
        if (code !== 0) rejectPromise(new Error(`stack_sandbox exited with code ${code}`));
      });
    });

    this.sandboxConfig = config;
  }

  private async startIssuer(): Promise<void> {
    const rootDir = resolve(import.meta.dirname, "../../../../");
    const tsxBin = resolve(rootDir, "node_modules/.bin/tsx");
    this.issuerProcess = spawn(tsxBin, [resolve(rootDir, "services/issuer/src/index.ts")], {
      cwd: resolve(rootDir, "services/issuer"),
      detached: true,
      env: {
        ...process.env,
        NEAR_ENV: "testnet",
        NEAR_ROOT_ACCOUNT: this.sandboxConfig.rootAccount,
        NEAR_RPC_URL: this.sandboxConfig.rpcUrl,
        NEAR_RPC_URL_FALLBACK: this.sandboxConfig.rpcUrl,
        ISSUER_ACCOUNT_ID: this.sandboxConfig.issuerAccountId,
        ISSUER_PRIVATE_KEY: this.sandboxConfig.issuerPrivateKey,
        RELAY_PRIVATE_KEY: this.sandboxConfig.relayPrivateKey,
        ISSUER_SERVICE_KEY: this.serviceKey,
        ISSUER_PORT: String(this.issuerPort),
      },
      stdio: "inherit",
    });

    await this.waitForHttp(`http://127.0.0.1:${this.issuerPort}/health`, 60_000, "issuer");
  }

  private async startIndexer(): Promise<void> {
    const rootDir = resolve(import.meta.dirname, "../../../../");
    const tsxBin = resolve(rootDir, "node_modules/.bin/tsx");

    let startHeight = 1;
    try {
      const res = await fetch(this.sandboxConfig.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "block",
          params: { finality: "final" },
        }),
      });
      const data = (await res.json()) as { result?: { header?: { height?: number } } };
      if (typeof data.result?.header?.height === "number") {
        startHeight = data.result.header.height;
      }
    } catch {
      // fallback
    }

    this.indexerProcess = spawn(tsxBin, [resolve(rootDir, "services/indexer/src/index.ts")], {
      cwd: resolve(rootDir, "services/indexer"),
      detached: true,
      env: {
        ...process.env,
        NEAR_ENV: "testnet",
        NEAR_ROOT_ACCOUNT: this.sandboxConfig.rootAccount,
        NEAR_RPC_URL: this.sandboxConfig.rpcUrl,
        NEAR_RPC_URL_FALLBACK: this.sandboxConfig.rpcUrl,
        INDEXER_SOURCE: "rpc",
        INDEXER_START_HEIGHT: String(startHeight),
        INDEXER_DB_PATH: this.indexerDbPath,
        INDEXER_PORT: String(this.indexerPort),
        INDEXER_POLL_INTERVAL_MS: "500",
        INDEXER_RETENTION_DAYS: "1",
        ONECLICK_API_URL: this.fakeOneClick.url,
        ONECLICK_JWT: "test-jwt",
      },
      stdio: "inherit",
    });

    await this.waitForHttp(`http://127.0.0.1:${this.indexerPort}/health`, 60_000, "indexer");
  }

  private async startApi(): Promise<void> {
    const rootDir = resolve(import.meta.dirname, "../../../../");
    const tsxBin = resolve(rootDir, "node_modules/.bin/tsx");
    this.apiProcess = spawn(tsxBin, [resolve(rootDir, "services/api/src/server.ts")], {
      cwd: resolve(rootDir, "services/api"),
      detached: true,
      env: {
        ...process.env,
        MOCK: "0",
        NEAR_ROOT_ACCOUNT: this.sandboxConfig.rootAccount,
        NEAR_RPC_URL: this.sandboxConfig.rpcUrl,
        NEAR_RPC_URL_FALLBACK: this.sandboxConfig.rpcUrl,
        ISSUER_URL: `http://127.0.0.1:${this.issuerPort}`,
        ISSUER_SERVICE_KEY: this.serviceKey,
        INDEXER_URL: `http://127.0.0.1:${this.indexerPort}`,
        ONECLICK_API_URL: this.fakeOneClick.url,
        ONECLICK_BASE_URL: this.fakeOneClick.url,
        ONECLICK_JWT: "test-jwt",
        DATABASE_URL: `file:${this.apiDbPath}`,
        API_PORT: String(this.apiPort),
        PORT: String(this.apiPort),
        API_SECRET_KEY: "stack-api-secret",
        API_RECIPIENT: "api.openrail.near",
        WEB_ORIGIN: `http://127.0.0.1:${this.webPort}`,
      },
      stdio: "inherit",
    });

    await this.waitForHttp(`http://127.0.0.1:${this.apiPort}/v1/openapi.json`, 60_000, "api");
  }

  private async startWeb(): Promise<void> {
    const rootDir = resolve(import.meta.dirname, "../../../../");
    const nextBin = resolve(rootDir, "services/web/node_modules/.bin/next");
    this.webProcess = spawn(nextBin, ["start", "-p", String(this.webPort)], {
      cwd: resolve(rootDir, "services/web"),
      detached: true,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_MODE: "live",
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${this.apiPort}`,
        NEXT_PUBLIC_NEAR_RPC_URL: this.sandboxConfig.rpcUrl,
        OPENRAIL_DEV_ROUTES: "1",
      },
      stdio: "inherit",
    });

    await this.waitForHttp(`http://127.0.0.1:${this.webPort}/`, 60_000, "web");
  }

  private async waitForHttp(url: string, timeoutMs: number, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok || res.status === 404 || res.status === 200) {
          return;
        }
      } catch {
        // wait and retry
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`Timed out waiting for ${label} at ${url} after ${timeoutMs}ms`);
  }

  /** Provisions a valid session cookie in the API SQLite database for the given account. */
  createSession(accountId: string): string {
    const token = `or_sess_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    const expiresAt = now + 7 * 86400 * 1000;

    const db = new DatabaseSync(this.apiDbPath);
    // Ensure business profile exists
    db.prepare(
      `
      INSERT OR REPLACE INTO business_profiles (account_id, body)
      VALUES (?, ?)
    `,
    ).run(
      accountId,
      JSON.stringify({
        account_id: accountId,
        legal_name: "Alice Studio LLC",
        country: "US",
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      }),
    );

    // Insert session into sessions table
    db.prepare(
      `
      INSERT INTO sessions (token_hash, account_id, expires_at, absolute_expires_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run(tokenHash, accountId, expiresAt, expiresAt);

    db.close();
    return token;
  }

  /** Issues an invoice through the real issuer service and indexes it in the API database. */
  async issueInvoiceViaIssuer(opts: {
    business: string;
    debtor: { Near: string } | { Evm: string };
    amountDue: string;
    invoiceNumber: string;
  }): Promise<{ tokenId: string; claimAccount: string }> {
    const invId = `inv_${randomBytes(12).toString("hex")}`;
    const dueDate = Math.floor(Date.now() / 1000) + 86400 * 30;

    const res = await fetch(`http://127.0.0.1:${this.issuerPort}/issue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.serviceKey}`,
      },
      body: JSON.stringify({
        business: opts.business,
        kind: 1,
        debtor: opts.debtor,
        termsHash: `0x${"0".repeat(64)}`,
        amountDue: opts.amountDue,
        dueDate,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Issuer issue failed: ${res.status} ${err}`);
    }

    const data = (await res.json()) as { tokenId: string; claimAccount: string };

    // Record invoice in API sqlite database so dashboard API displays it
    const db = new DatabaseSync(this.apiDbPath);
    const amountUsd = (Number(opts.amountDue) / 1e6).toFixed(2);
    const dueDateIso = new Date(dueDate * 1000).toISOString().slice(0, 10);
    const debtorKey = "Near" in opts.debtor ? opts.debtor.Near : opts.debtor.Evm;
    const debtorLegalName = "Bob Consulting Corp";

    const invoiceRecord = {
      id: invId,
      token_id: data.tokenId,
      claim_account: data.claimAccount,
      status: "Issued",
      issuer_id: opts.business,
      owner_id: opts.business,
      debtor: opts.debtor,
      terms_hash: `0x${"0".repeat(64)}`,
      amount_due: opts.amountDue,
      outstanding: opts.amountDue,
      paid_total: "0",
      amount_usd: amountUsd,
      due_date: dueDateIso,
      invoice_number: opts.invoiceNumber,
      issuer_legal_name: "Alice Studio LLC",
      debtor_legal_name: debtorLegalName,
      pay_link: `http://127.0.0.1:${this.webPort}/pay/${data.tokenId}`,
      ack_url: `http://127.0.0.1:${this.webPort}/ack/${data.tokenId}`,
      created_at: new Date().toISOString(),
      created_block: 0,
      terms: {
        invoice_number: opts.invoiceNumber,
        issuer_legal_name: "Alice Studio LLC",
        issuer_account: opts.business,
        debtor_legal_name: debtorLegalName,
        debtor_key: debtorKey,
        amount_usd: amountUsd,
        due_date: dueDateIso,
        line_items_sha256: `0x${"0".repeat(64)}`,
        claim_account: data.claimAccount,
        pay_link: `http://127.0.0.1:${this.webPort}/pay/${data.tokenId}`,
        clauses: ["core:default"],
      },
    };

    db.prepare(
      `
      INSERT OR REPLACE INTO invoices (id, token_id, account_id, body)
      VALUES (?, ?, ?, ?)
    `,
    ).run(invId, data.tokenId, opts.business, JSON.stringify(invoiceRecord));

    db.close();

    return data;
  }

  async stop(): Promise<void> {
    const kill = (child?: ChildProcess) => {
      if (!child || child.killed) return;
      try {
        if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    };

    kill(this.webProcess);
    kill(this.apiProcess);
    kill(this.indexerProcess);
    kill(this.issuerProcess);
    kill(this.sandboxProcess);

    const freePort = (port: number) => {
      try {
        execSync(`fuser -k -9 ${port}/tcp`, { stdio: "ignore" });
      } catch {
        // ignore
      }
    };
    freePort(this.webPort);
    freePort(this.apiPort);
    freePort(this.indexerPort);
    freePort(this.issuerPort);

    if (this.fakeOneClick) {
      await this.fakeOneClick.close().catch(() => {});
    }

    try {
      rmSync(this.tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
