# I1 end-to-end test plan

This document specifies the end-to-end (E2E) integration test plan (`I1`) for Openrail.
It defines automated Playwright flows that exercise the full local stack—the NEAR
sandbox smart contract, SQLite persistence, backend services, and the web interface—without
mocking backend endpoints.

This plan serves as the actionable implementation specification to be assigned once the core
screens land on `main`.

---

## 1. Local stack and test harness architecture

Unlike unit or isolated screen tests that rely on pre-recorded API fixtures, the I1 E2E suite
runs against the complete live local application stack.

```
┌─────────────────────────────────────────────────────────────┐
│                      Playwright Runner                      │
│   (Chromium, EVM / NEAR Wallet Mock Injections, Webdriver)  │
└──────────────┬──────────────────────────────┬───────────────┘
               │ HTTP (:3100)                 │ Mock RPC (:3030)
               ▼                              │
┌──────────────────────────────┐              │
│       Web Application        │              │
│       (@openrail/web)        │              │
└──────────────┬───────────────┘              │
               │ HTTP (:8787)                 │
               ▼                              │
┌──────────────────────────────┐              │
│      API & Issuer Stack      │              │
│  (@openrail/api, /indexer)   │              │
└──────┬───────────────┬───────┘              │
       │               │                      │
       ▼               ▼                      ▼
┌──────────────┐ ┌────────────────────────────────────────────┐
│ SQLite Store │ │            NEAR Sandbox Daemon             │
│ (Migrations) │ │ (openrail.wasm, c-<n> accounts, intents)   │
└──────────────┘ └────────────────────────────────────────────┘
```

### 1.1 Stack components

1. **NEAR Sandbox Daemon (`near-sandbox`)**:
   - Ephemeral node instance running locally on a dynamic or configured RPC port (default `3030`).
   - Root contract `openrail.wasm` compiled and deployed to the root account (`openrail.test.near`).
   - Initialization parameters applied (`new` method with designated authority and settlement assets).
   - Mock token contracts or `intents.near` simulator (`openrail-mock-intents`) for multi-asset deposits.

2. **SQLite Database**:
   - Ephemeral database instance with all schema migrations applied (`schema_migrations`).
   - Clean tables for API keys, sessions, challenges, invoices, webhooks, and payments.

3. **Backend Services**:
   - **Issuer Service**: Runs with restricted function-call access key to issue claims and relay acknowledgements.
   - **API Server (`services/api`)**: Runs in live mode (no `MOCK=1`) connected to the SQLite database, issuer service, and NEAR sandbox RPC.
   - **Indexer Service**: Watches sandbox blocks and events, updating local SQLite stores.
   - **Watcher Service**: Polls sandbox claim accounts, triggers reconciliation on deposit balance increases, and clears stale locks.

4. **Web Frontend (`services/web`)**:
   - Next.js application running on test port `3100`, configured with `NEXT_PUBLIC_API_URL=http://127.0.0.1:8787` and `NEXT_PUBLIC_NEAR_RPC_URL=http://127.0.0.1:3030`.

5. **Playwright Test Runner**:
   - Automated browser instance with injected wallet providers:
     - **EVM Provider**: Injected `window.ethereum` mock provider capable of signing EIP-712 structured data (`Acknowledge` type with `kind = "OPENRAIL_ACK_V1"` per blueprint §2.7) with deterministic test private keys.
     - **NEAR Provider**: Mock wallet selector allowing programmatic approval of NEP-413 sign-in challenges and NEP-171 transfers.

### 1.2 Offline payment simulation (no real 1Click or mainnet)

Real 1Click network endpoints and external blockchain mainnets are never contacted in CI or local automated tests.
All payments are simulated deterministically via:

1. **Mock 1Click HTTP Service**: Intercepts quote and status requests (`POST /v1/pay/sessions`, etc.) returning predictable quotes, deposit addresses, and state progression (`pending_deposit` → `detecting` → `locked` → `booked` → `distributed`).
2. **Intents Mock Minting (`mt_mint`)**: The test harness invokes `mt_mint` on the local sandbox intents contract (`openrail-mock-intents`) to credit the invoice's keyless subaccount `c-<n>.<root>` directly with the required settlement asset.
3. **Watcher & Reconcile Engine**: The watcher service detects the balance increase on `c-<n>.<root>` via RPC polling, executes `reconcile` on the root contract, sweeps settlement funds to the creditor or assignee, and marks the payment distributed.

### 1.3 Harness lifecycle and isolation

- **Global Setup (`globalSetup`)**:
  - Compiles `openrail.wasm` via `cargo near build`.
  - Spawns sandbox daemon, initializes root contract, and provisions test accounts (`alice.near`, `bob.near`, `acme.near`).
  - Applies database migrations on a fresh SQLite database.
  - Launches backend API and web server, polling `/v1/openapi.json` and `http://127.0.0.1:3100` until healthy.
- **Test Isolation**:
  - Each test suite provisions distinct business accounts and unique invoice idempotency keys to guarantee test independence.
  - Tests clean up temporary sessions and avoid inter-test state leakage.
- **Global Teardown (`globalTeardown`)**:
  - Terminates child processes (web server, API server, sandbox daemon).
  - Cleans up ephemeral SQLite database and temporary sandbox directories.

---

## 2. Core screen Playwright flows

### Flow 1: Business onboarding (`/app/onboarding`)

Verifies the end-to-end onboarding experience for a new merchant business.

1. **Navigate to Onboarding**:
   - Browser navigates to `/app/onboarding`.
   - Ensure redirection to wallet sign-in if unauthenticated, followed by NEP-413 challenge signature to establish session (`or_sess` cookie).
2. **Step 1: Legal Profile**:
   - Fill "Legal Name" (`Acme Industrial Corp`) and "Contact Email" (`billing@acme.example.com`).
   - Click "Save Profile".
   - **Assertion**: Form submits successfully; profile record persists in SQLite database; Step 1 marked complete.
3. **Step 2: Payout Destination**:
   - Enter NEAR payout account (`acme.near`).
   - Click "Configure Payout".
   - **Assertion**: Input validated; payout address saved in business profile; Step 2 marked complete.
4. **Step 3: Storage Prepayment**:
   - Display shows zero or low storage credit banner.
   - Click "Deposit Storage Credit" (attaches 1 NEAR).
   - Injected NEAR wallet signs and submits `deposit_storage_credit` transaction on sandbox.
   - **Assertion**: Sandbox execution succeeds; UI reflects updated storage credit balance; Step 3 marked complete.
5. **Step 4: Completion**:
   - All four steps show completed state.
   - Click "Go to Invoices" / "Create First Invoice".
   - **Assertion**: Browser navigates to `/app` with onboarding checklist completed.

### Flow 2: Dashboard and invoice issuance (`/app`, `/app/invoices`)

Verifies creating, pricing, and issuing an invoice on-chain.

1. **Dashboard Overview**:
   - Navigate to `/app`.
   - **Assertion**: Renders active invoices table, aggregate metrics, and "New Invoice" action.
2. **Open Invoice Modal / Screen**:
   - Click "New Invoice".
   - Input fields:
     - **Debtor Address**: EVM address `0x53C5D39A5828BaDf817E40f22d75d96D731f8239` or NEAR account `debtor.near`.
     - **Amount Due**: `1000.00` USDC.
     - **Settlement Asset**: Select `USDC` (configured settlement asset).
     - **Due Date**: Future unix timestamp (e.g. current time + 14 days).
     - **Description / Terms**: `Invoice #1001 for engineering services`.
3. **Issue Claim Transaction**:
   - Click "Issue Invoice".
   - API allocates dedicated keyless subaccount `c-<n>.<root>` on the sandbox contract.
   - Canonical terms hash generated; contract mints NEP-171 token with ID `c-<n>`.
   - **Assertion**:
     - Modal closes; new invoice appears at the top of the dashboard table with status `Issued (Awaiting Ack)`.
     - Keyless account `c-<n>.<root>` exists on the sandbox.
     - View links for Pay (`/pay/c-<n>`) and Acknowledgement (`/ack/c-<n>`) are displayed and copyable.

### Flow 3: Debtor terms inspection and acknowledgement (`/ack/[tokenId]`)

Verifies that a debtor reviews the legal terms and cryptographically acknowledges the debt.

1. **Open Acknowledgement View**:
   - Browser navigates to `/ack/{tokenId}`.
   - Page queries the live contract and API for claim metadata.
   - **Assertion**:
     - Terms panel displays debtor address, creditor address, gross amount, currency, and canonical `terms_hash`.
     - State indicates `Unacknowledged`.
2. **Connect Debtor Wallet**:
   - Click "Connect Wallet".
   - Mock EVM provider connects with debtor address `0x53C5D39A5828BaDf817E40f22d75d96D731f8239`.
   - **Assertion**: UI displays connected address and confirms address matches debtor specification.
3. **Sign Acknowledgement**:
   - Click "Sign & Acknowledge Terms".
   - Injected wallet receives EIP-712 structured data for the `Acknowledge` primary type with `kind = "OPENRAIL_ACK_V1"` (blueprint §2.7) matching the canonical terms hash.
   - Wallet produces signature `(v, r, s)`.
   - Front-end submits signature to `POST /v1/ack/{token_id}/evm`.
   - Relayer calls `acknowledge_evm` on the root contract in sandbox.
4. **On-Chain Ack Verification**:
   - **Assertion**:
     - Page updates to display `Acknowledged` banner with green verification seal.
     - Contract view `get_ack(token_id)` returns the valid signature and timestamp.
     - Reload page: status immediately displays `Acknowledged` without prompting for re-signing (write-once guarantee).

### Flow 4: Multichain payment flow (`/pay/[tokenId]`)

Verifies route discovery, quote generation, payment deposit detection, and status updates.

1. **Open Pay Screen**:
   - Browser navigates to `/pay/{tokenId}`.
   - **Assertion**: Displays invoice amount outstanding, settlement currency, and countdown to invoice deadline.
2. **Select Payment Route**:
   - Choose origin payment rail (e.g. `Base` chain, `USDC` asset).
   - Input valid refund address for origin chain (`0x53C5D39A5828BaDf817E40f22d75d96D731f8239`).
   - Click "Get Price".
3. **Quote and Deposit Address**:
   - API queries route engine and issues quote.
   - **Assertion**:
     - Deposit card appears showing designated deposit address.
     - Exact payment amount shown with expiration timer.
     - Copy button copies exact deposit address.
4. **Deposit Simulation**:
   - Harness invokes `mt_mint` on `openrail-mock-intents` for the claim account `c-<n>.<root>`.
   - Indexer and watcher detect the inbound balance change.
5. **Real-Time Payment State Progression**:
   - **Assertion**:
     - UI transitions status: `Detecting` → `Locked` → `Booked` → `Distributed`.
     - Invoice status displays `Paid in Full`.
     - Verifiable receipt link becomes available at `/r/<booking tx hash>`.

### Flow 5: Claim NFT transfer (`/app/invoices/[id]/transfer`)

Verifies transferring debt claim ownership to a third-party assignee.

1. **Navigate to Transfer Screen**:
   - Creditor opens `/app/invoices/{id}` and clicks "Transfer Claim".
   - Browser navigates to `/app/invoices/{id}/transfer`.
2. **Pre-Transfer Checks**:
   - UI runs `prepare_transfer` check against sandbox to ensure no reconcile lock or pending dispute.
   - **Assertion**: Displays green indicator confirming claim is eligible for transfer.
3. **Execute Transfer**:
   - Input recipient account: `investor.near`.
   - Input assignment document memo: 64-hex SHA-256 digest (`1111111111111111111111111111111111111111111111111111111111111111`).
   - Click "Transfer Claim Token" (attaches 1 yoctoNEAR).
   - Injected NEAR wallet signs `nft_transfer`.
4. **Post-Transfer Verification**:
   - **Assertion**:
     - Success banner confirms ownership transferred to `investor.near`.
     - Querying sandbox `nft_token` confirms owner is `investor.near`.
     - Original creditor dashboard updates: invoice moves to "Transferred / Factored" tab.

### Flow 6: Statements and verifiable receipts (`/app/statements`, `/r/[hash]`, `/app/cashout`)

Verifies historical statement inspection, receipt verification, and cash-out flow.

1. **Open Statements Screen**:
   - Creditor navigates to `/app/statements`.
   - **Assertion**: Renders table of settled invoices, gross amounts, fees, and net payouts.
2. **Filter by Invoice**:
   - Provide query parameter `?token_id={tokenId}`.
   - **Assertion**: Table filters to show only the selected invoice.
3. **Inspect Verifiable Receipt (`/r/[hash]`)**:
   - Click "View Receipt" for a settled invoice to open `/r/<booking tx hash>`.
   - **Assertion**:
     - Receipt view displays:
       - Invoice ID and terms digest.
       - Origin payment hash on external chain.
       - NEAR settlement execution hash and timestamp.
       - Payout destination transaction hash.
     - "Download Statement (CSV)" produces valid CSV export.
     - "Download Invoice Envelope (PDF)" delivers base64-decoded PDF document.
4. **Cash-Out Flow (`/app/cashout`)**:
   - Navigate to `/app/cashout`.
   - Select destination external chain and payout address.
   - **Assertion**: Displays exact output received, network route fee, and arrival confirmation once processed.

### Flow 7: Developer settings and API keys (`/app/developers`)

Verifies scoped API key provisioning and webhook configurations.

1. **Navigate to Developers Screen**:
   - Navigate to `/app/developers`.
2. **Generate Scoped API Key**:
   - Click "Create New Secret Key".
   - Check desired scopes: `invoices:read`, `invoices:write`, `payments:read`.
   - Click "Create".
   - **Assertion**:
     - Dialog displays secret key `or_sk_live_...` with copy button and warning that it is shown only once.
     - SQLite database contains SHA-256 hash of key with exact scope bitmask.
     - Key table lists key with its label, prefix, and scope badges.
3. **Revoke Key**:
   - Click "Revoke" on an active key; confirm modal.
   - **Assertion**: Key status updates to `Revoked`. Automated test calling API with revoked key receives HTTP 401.
4. **Configure Webhooks**:
   - Enter webhook destination URL `https://mock.example.com/webhook`.
   - Select event subscriptions (`invoice.issued`, `payment.booked`).
   - Click "Save Webhook".
   - **Assertion**: Webhook endpoint appears in active webhooks table.

---

## 3. README steps ("Do X → see Y") Playwright E2E flows

The root [`README.md`](../../../README.md) details eight operational steps. The E2E suite
validates each step against the sandbox stack:

| Step  | Action                                                   | Expected Outcome                                                          | E2E Playwright Automation                                                        |
| :---- | :------------------------------------------------------- | :------------------------------------------------------------------------ | :------------------------------------------------------------------------------- |
| **1** | `cp .env.example .env`                                   | Valid variable names loaded without committing values                     | Configuration validator tests clean boot with required environment keys          |
| **2** | `make test`                                              | Full sandbox, model, and service test suites pass                         | Runner executes contract suite and API test commands, verifying clean exit code  |
| **3** | Create claim with debtor EVM address                     | Keyless `c-<n>.<root>` account created on sandbox; NFT in business wallet | UI flow issues claim; verifies zero access keys on `c-<n>` and `nft_token` owner |
| **4** | Open ack link and sign with debtor wallet                | Terms displayed; `ack` event emitted; immutable state                     | UI connects EVM wallet, signs EIP-712 payload; verifies contract `ack` event     |
| **5** | Open pay link, select chain/asset, and pay               | Balance increases; `booked` and `distributed` status; receipt hashes      | UI selects route; simulates deposit; verifies balance rise, status, and receipt  |
| **6** | Transfer claim token to second account; pay on same link | Payout distributed 100% to assignee, 0% to seller                         | UI transfers NFT; simulates payment; asserts full payout routed to assignee      |
| **7** | Transfer during reconcile refusal                        | Refusal with rule number in plain words                                   | Triggers active reconcile window; attempts transfer; asserts Rule 2 refusal      |
| **8** | Cash out to another chain                                | Route cost displayed, payout arrives                                      | Requests cash-out quote; verifies net calculation and simulated external arrival |

### Step details & assertions

#### Step 3: Keyless subaccount and claim issuance

- **Flow**: Business creates claim via UI with EVM debtor address `0x53C5D39A5828BaDf817E40f22d75d96D731f8239`.
- **Sandbox Assertion**:
  ```ts
  const accessKeys = await sandboxRpc.viewAccessKeys(`c-1.${rootContract}`);
  expect(accessKeys.keys).toHaveLength(0); // Keyless account constraint
  const token = await sandboxRpc.viewMethod(rootContract, "nft_token", {
    token_id: "c-1",
  });
  expect(token.owner_id).toBe("acme.near");
  ```

#### Step 4: Acknowledgement and write-once enforcement

- **Flow**: Debtor signs acknowledgement on `/ack/c-1` using `Acknowledge` EIP-712 typed signature with `kind = "OPENRAIL_ACK_V1"`.
- **Sandbox Assertion**:
  ```ts
  const ack = await sandboxRpc.viewMethod(rootContract, "get_ack", {
    token_id: "c-1",
  });
  expect(ack.debtor_address.toLowerCase()).toBe("0x53c5d39a5828badf817e40f22d75d96d731f8239");
  expect(ack.timestamp_nanos).toBeGreaterThan(0);
  ```

#### Step 5: Deposit, reconcile, and receipt generation

- **Flow**: Harness credits `c-1.<root>` via `mt_mint` on `openrail-mock-intents`. Reconcile runs, and client inspects receipt on `/r/<booking tx hash>`.
- **Sandbox Assertion**:
  ```ts
  const claimBalance = await sandboxRpc.viewBalance(`c-1.${rootContract}`);
  expect(claimBalance).toBeGreaterThanOrEqual(expectedAmount);
  // Reconcile sweeps claim account to settlement recipient
  const payoutBalance = await sandboxRpc.viewBalance("acme.near");
  expect(payoutBalance).toBeGreaterThanOrEqual(netAmount);
  ```

#### Step 6: Post-transfer payment routing (K13 invariant)

- **Flow**: Creditor transfers token `c-1` to `investor.near`. Payment then deposited on `/pay/c-1`.
- **Sandbox Assertion**:
  ```ts
  const token = await sandboxRpc.viewMethod(rootContract, "nft_token", {
    token_id: "c-1",
  });
  expect(token.owner_id).toBe("investor.near");
  // Post-payment distribution assertion
  const sellerDelta = await getBalanceDelta("acme.near");
  const investorDelta = await getBalanceDelta("investor.near");
  expect(sellerDelta).toBe(0n);
  expect(investorDelta).toBe(netPaymentAmount);
  ```

#### Step 7: Transfer refusal during active reconcile window

- **Flow**: Contract triggers reconciliation locking window. Creditor attempts transfer on `/app/invoices/c-1/transfer`.
- **UI & Contract Assertion**:
  - Web UI displays error banner: `Transfer Refused: Claim is locked in active reconciliation window (Rule 2)`.
  - Sandbox transaction status is failure with message containing `RULE_2_TRANSFER_WINDOW_LOCKED`.

---

## 4. Execution tiers, CI budget, and conventions

### 4.1 CI execution tiers and cost control

Running the complete multi-process stack (NEAR sandbox, SQLite, API, issuer, Next.js, and Playwright) on every commit would exhaust CI minutes and create feedback bottlenecks. Tests are therefore structured in two strict tiers:

1. **Per-PR Signed-in Smoke Test (Fast)**:
   - Runs against Next.js with the lightweight mock API (`MOCK=1`).
   - Verifies signed-in sessions, core screen rendering, and wallet picker interactions in < 60 seconds.
   - Runs on every PR that modifies `services/web/**`.
2. **Full-Stack End-to-End Suite (Comprehensive)**:
   - Spawns the real NEAR sandbox, compiles contract wasm, applies SQLite migrations, and boots all background services.
   - Executes the full Playwright suite across all screens and README flows.
   - Runs on merge to `main` and on-demand via manual workflow dispatch (`workflow_dispatch`) before releases.
   - Never runs on untrusted pull requests.

### 4.2 File organization and commands

- Screen flows: `services/web/e2e/flows/*.spec.ts`.
- README flows: `services/web/e2e/readme/*.spec.ts`.
- Shared harnesses and wallet mocks: `services/web/e2e/harness/`.
- Commands:
  ```bash
  # Per-PR smoke test
  pnpm --filter @openrail/web test:e2e:smoke

  # Full-stack local sandbox integration
  pnpm --filter @openrail/web test:e2e:stack
  ```
