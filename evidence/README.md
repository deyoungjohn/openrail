# Evidence (pre-build spikes, 27–31 Oct 2026)

These reports were produced before the build window, while designing and testing Openrail. Each is the raw JSON written by the test script, with its original timestamp; secrets were redacted at write time. Mainnet transaction hashes inside can be checked on the explorers.

| Report | Date | What it tested | Result |
|---|---|---|---|
| [H0-2026-10-27T15-56-41Z.json](H0-2026-10-27T15-56-41Z.json) | 2026-10-27 | secret-redaction helper self-test | PASS |
| [H0-2026-10-28T11-40-04Z.json](H0-2026-10-28T11-40-04Z.json) | 2026-10-28 | secret-redaction helper self-test | PASS |
| [H0-2026-10-28T13-04-13Z.json](H0-2026-10-28T13-04-13Z.json) | 2026-10-28 | secret-redaction helper self-test | PASS |
| [H0-leak-2026-10-27T15-56-40Z.json](H0-leak-2026-10-27T15-56-40Z.json) | 2026-10-27 | secret-redaction helper self-test | PASS |
| [H0-leak-2026-10-28T11-40-04Z.json](H0-leak-2026-10-28T11-40-04Z.json) | 2026-10-28 | secret-redaction helper self-test | PASS |
| [H0-leak-2026-10-28T13-04-11Z.json](H0-leak-2026-10-28T13-04-11Z.json) | 2026-10-28 | secret-redaction helper self-test | PASS |
| [H0-overlay-leak-2026-10-28T11-40-04Z.json](H0-overlay-leak-2026-10-28T11-40-04Z.json) | 2026-10-28 | secret-redaction helper self-test | PASS |
| [H0-overlay-leak-2026-10-28T13-04-13Z.json](H0-overlay-leak-2026-10-28T13-04-13Z.json) | 2026-10-28 | secret-redaction helper self-test | PASS |
| [K1-2026-10-27T18-42-54Z.json](K1-2026-10-27T18-42-54Z.json) | 2026-10-27 | keyless invoice account from a contract (global vault) | PASS |
| [K1-2026-10-28T15-05-32Z.json](K1-2026-10-28T15-05-32Z.json) | 2026-10-28 | keyless invoice account from a contract (global vault) | PASS |
| [K1-2026-10-28T16-55-12Z.json](K1-2026-10-28T16-55-12Z.json) | 2026-10-28 | keyless invoice account from a contract (global vault) | PASS |
| [K1-2026-10-28T17-22-19Z.json](K1-2026-10-28T17-22-19Z.json) | 2026-10-28 | keyless invoice account from a contract (global vault) | PASS |
| [K10-2026-10-28T11-49-25Z.json](K10-2026-10-28T11-49-25Z.json) | 2026-10-28 | pledge an invoice: advance and lien in one transaction | PASS |
| [K10-2026-10-28T12-49-05Z.json](K10-2026-10-28T12-49-05Z.json) | 2026-10-28 | pledge an invoice: advance and lien in one transaction | PENDING |
| [K10-mainnet-A-2026-10-28T21-54-00Z.json](K10-mainnet-A-2026-10-28T21-54-00Z.json) | 2026-10-28 | pledge an invoice: advance and lien in one transaction | PASS |
| [K10-mainnet-B-2026-10-28T21-56-33Z.json](K10-mainnet-B-2026-10-28T21-56-33Z.json) | 2026-10-28 | pledge an invoice: advance and lien in one transaction | PASS |
| [K10-real-payout-2026-10-28T21-05-49Z.json](K10-real-payout-2026-10-28T21-05-49Z.json) | 2026-10-28 | pledge an invoice: advance and lien in one transaction | PASS |
| [K12-partA-2026-10-29T03-15-27Z.json](K12-partA-2026-10-29T03-15-27Z.json) | 2026-10-29 | checkout speed and cost | PASS |
| [K12-partB-2026-10-29T08-37-39Z.json](K12-partB-2026-10-29T08-37-39Z.json) | 2026-10-29 | checkout speed and cost | FAIL |
| [K12-partB-amended-2026-10-29T12-13-42Z.json](K12-partB-amended-2026-10-29T12-13-42Z.json) | 2026-10-29 | checkout speed and cost | PASS |
| [K13-T0-2026-10-29T16-03-28Z.json](K13-T0-2026-10-29T16-03-28Z.json) | 2026-10-29 | invoice NFT in a real contract; sale re-routes the next payment (mainnet) | PASS |
| [K13-T2-2026-10-29T18-34-40Z.json](K13-T2-2026-10-29T18-34-40Z.json) | 2026-10-29 | invoice NFT in a real contract; sale re-routes the next payment (mainnet) | PASS |
| [K13-standards-crate-check-2026-10-29T19-08-18Z.json](K13-standards-crate-check-2026-10-29T19-08-18Z.json) | 2026-10-29 | invoice NFT in a real contract; sale re-routes the next payment (mainnet) | PASS |
| [K14-T1-2026-10-29T15-48-08Z.json](K14-T1-2026-10-29T15-48-08Z.json) | 2026-10-29 | EIP-712 client acknowledgement verified on-chain (real wallet) | FAIL |
| [K14-T1-2026-10-29T16-06-00Z.json](K14-T1-2026-10-29T16-06-00Z.json) | 2026-10-29 | EIP-712 client acknowledgement verified on-chain (real wallet) | PASS |
| [K14-T1-amended-2026-10-29T15-49-54Z.json](K14-T1-amended-2026-10-29T15-49-54Z.json) | 2026-10-29 | EIP-712 client acknowledgement verified on-chain (real wallet) | PASS |
| [K14-T2-2026-10-29T16-08-09Z.json](K14-T2-2026-10-29T16-08-09Z.json) | 2026-10-29 | EIP-712 client acknowledgement verified on-chain (real wallet) | PASS |
| [K15-T0-2026-10-29T16-28-15Z.json](K15-T0-2026-10-29T16-28-15Z.json) | 2026-10-29 | transfer payload built by the contract, MPC-signed, broadcast (mainnet) | PASS |
| [K15-T0-2026-10-29T18-52-18Z.json](K15-T0-2026-10-29T18-52-18Z.json) | 2026-10-29 | transfer payload built by the contract, MPC-signed, broadcast (mainnet) | PASS |
| [K15-T2-2026-10-29T18-53-12Z.json](K15-T2-2026-10-29T18-53-12Z.json) | 2026-10-29 | transfer payload built by the contract, MPC-signed, broadcast (mainnet) | PASS |
| [K2prime-partA-2026-10-28T11-29-35Z.json](K2prime-partA-2026-10-28T11-29-35Z.json) | 2026-10-28 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partA-routes-2026-10-29T03-08-53Z.json](K2prime-partA-routes-2026-10-29T03-08-53Z.json) | 2026-10-29 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partB-2026-10-28T13-17-26Z.json](K2prime-partB-2026-10-28T13-17-26Z.json) | 2026-10-28 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partB-2026-10-28T18-48-04Z.json](K2prime-partB-2026-10-28T18-48-04Z.json) | 2026-10-28 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partB-2026-10-29T05-48-31Z.json](K2prime-partB-2026-10-29T05-48-31Z.json) | 2026-10-29 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partB-2026-10-29T06-02-30Z.json](K2prime-partB-2026-10-29T06-02-30Z.json) | 2026-10-29 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partB-2026-10-29T08-57-17Z.json](K2prime-partB-2026-10-29T08-57-17Z.json) | 2026-10-29 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | SKIPPED |
| [K2prime-partB-2026-10-29T18-28-32Z.json](K2prime-partB-2026-10-29T18-28-32Z.json) | 2026-10-29 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partB-2026-10-29T18-34-25Z.json](K2prime-partB-2026-10-29T18-34-25Z.json) | 2026-10-29 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partB-2026-10-29T19-11-58Z.json](K2prime-partB-2026-10-29T19-11-58Z.json) | 2026-10-29 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partB-verify-2026-10-28T14-18-45Z.json](K2prime-partB-verify-2026-10-28T14-18-45Z.json) | 2026-10-28 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partC-2026-10-29T07-11-41Z.json](K2prime-partC-2026-10-29T07-11-41Z.json) | 2026-10-29 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partC-2026-10-29T07-40-01Z.json](K2prime-partC-2026-10-29T07-40-01Z.json) | 2026-10-29 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K2prime-partC-negative-check-2026-10-29T09-53-04Z.json](K2prime-partC-negative-check-2026-10-29T09-53-04Z.json) | 2026-10-29 | pay link: payment credited to a public Intents balance after the confidential-only switch; routes | PASS |
| [K3-arbitrum-sweep-2026-10-29T05-01-43Z.json](K3-arbitrum-sweep-2026-10-29T05-01-43Z.json) | 2026-10-29 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-base-sweep-2026-10-28T18-15-58Z.json](K3-base-sweep-2026-10-28T18-15-58Z.json) | 2026-10-28 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-eip3009-2026-10-28T11-28-29Z.json](K3-eip3009-2026-10-28T11-28-29Z.json) | 2026-10-28 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-eip3009-more-chains-2026-10-29T03-10-23Z.json](K3-eip3009-more-chains-2026-10-29T03-10-23Z.json) | 2026-10-29 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-mpc-derive-2026-10-27T19-20-08Z.json](K3-mpc-derive-2026-10-27T19-20-08Z.json) | 2026-10-27 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-mpc-derive-2026-10-28T13-55-37Z.json](K3-mpc-derive-2026-10-28T13-55-37Z.json) | 2026-10-28 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-mpc-derive-2026-10-28T17-31-18Z.json](K3-mpc-derive-2026-10-28T17-31-18Z.json) | 2026-10-28 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-optimism-sweep-2026-10-29T05-02-51Z.json](K3-optimism-sweep-2026-10-29T05-02-51Z.json) | 2026-10-29 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-polygon-sweep-2026-10-29T05-04-16Z.json](K3-polygon-sweep-2026-10-29T05-04-16Z.json) | 2026-10-29 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | FAIL |
| [K3-polygon-sweep-2026-10-29T05-05-46Z.json](K3-polygon-sweep-2026-10-29T05-05-46Z.json) | 2026-10-29 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | FAIL |
| [K3-polygon-sweep-2026-10-29T05-36-11Z.json](K3-polygon-sweep-2026-10-29T05-36-11Z.json) | 2026-10-29 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-rust-parity-2026-10-28T21-02-45Z.json](K3-rust-parity-2026-10-28T21-02-45Z.json) | 2026-10-28 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-sol-keys-2026-10-28T11-28-07Z.json](K3-sol-keys-2026-10-28T11-28-07Z.json) | 2026-10-28 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-solana-2026-10-28T11-28-38Z.json](K3-solana-2026-10-28T11-28-38Z.json) | 2026-10-28 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | ERROR |
| [K3-solana-latency-2026-10-28T19-40-38Z.json](K3-solana-latency-2026-10-28T19-40-38Z.json) | 2026-10-28 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-solana-latency-2026-10-28T19-49-13Z.json](K3-solana-latency-2026-10-28T19-49-13Z.json) | 2026-10-28 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K3-solana-sweep-2026-10-28T21-46-11Z.json](K3-solana-sweep-2026-10-28T21-46-11Z.json) | 2026-10-28 | Chain Signatures: derived addresses, EIP-3009 and Solana sweeps | PASS |
| [K4-mainnet-2026-10-28T19-30-30Z.json](K4-mainnet-2026-10-28T19-30-30Z.json) | 2026-10-28 | reconcile and pay out in one callback on the real intents.near | PASS |
| [K4-sandbox-2026-10-28T17-36-54Z.json](K4-sandbox-2026-10-28T17-36-54Z.json) | 2026-10-28 | reconcile and pay out in one callback on the real intents.near | PASS |
| [K5-2026-10-27T18-33-03Z.json](K5-2026-10-27T18-33-03Z.json) | 2026-10-27 | transfer-vs-collection race (1,000 interleavings) | PASS |
| [K5-2026-10-28T08-58-09Z.json](K5-2026-10-28T08-58-09Z.json) | 2026-10-28 | transfer-vs-collection race (1,000 interleavings) | ERROR |
| [K5-2026-10-28T13-06-23Z.json](K5-2026-10-28T13-06-23Z.json) | 2026-10-28 | transfer-vs-collection race (1,000 interleavings) | PASS |
| [K5-2026-10-28T16-35-42Z.json](K5-2026-10-28T16-35-42Z.json) | 2026-10-28 | transfer-vs-collection race (1,000 interleavings) | PASS |
| [K8-2026-10-28T11-47-17Z.json](K8-2026-10-28T11-47-17Z.json) | 2026-10-28 | "I paid" trace on recorded and real cases | PASS |
| [K8-2026-10-28T12-54-32Z.json](K8-2026-10-28T12-54-32Z.json) | 2026-10-28 | "I paid" trace on recorded and real cases | PASS |
| [K8-real-2026-10-28T19-39-42Z.json](K8-real-2026-10-28T19-39-42Z.json) | 2026-10-28 | "I paid" trace on recorded and real cases | PASS |
| [K8-real-2026-10-28T21-09-46Z.json](K8-real-2026-10-28T21-09-46Z.json) | 2026-10-28 | "I paid" trace on recorded and real cases | PASS |
| [K8-record-evidence-2026-10-28T21-10-29Z.json](K8-record-evidence-2026-10-28T21-10-29Z.json) | 2026-10-28 | "I paid" trace on recorded and real cases | PASS |
| [pay-report-2026-10-31T19-13-15-901Z.json](pay-report-2026-10-31T19-13-15-901Z.json) | 2026-10-31 | live confidential 1Click swap: origin and destination hashes, amounts vs signed quote | SUCCESS |
