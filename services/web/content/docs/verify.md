# Verify a payment

You do not have to trust Openrail's word that a payment happened. Every booking is a transaction of `openrail.near` on NEAR mainnet, and every receipt says how to check it.

## On the explorer

1. Open the receipt (`/r/<booking_tx_hash>`) or the [Proof page](/proof).
2. Follow **NEAR booking transaction** to NearBlocks. The transaction calls `openrail.near` and emits a `booked` event with the invoice's token id, the payment, the fee and the share credited to the owner.
3. Follow **Payer's transaction** to the payer's own chain (Etherscan, Basescan, Arbiscan, Solscan, BscScan and so on).
4. Open the invoice's account (`<business>-<ref>.openrail.near`): its history shows the money arriving and leaving only under the contract.

## With the command line

The receipt prints the exact command:

```bash Shell
openrail-verify claim acme-3f2a9c41d07b.openrail.near \
    --terms-hash 0x393f2d767ec9db2e96d5c9e19fe2d5b516975a0c3df31a5856f2b5c592ee41a6
```

It reads the claim from the contract and checks that the terms fingerprint, the owner and the booked amounts match the receipt.

## Read the contract yourself

All of these are view calls, free and open to anyone:

```bash near-cli
near view openrail.near claim '{"token_id":"acme-3f2a9c41d07b"}'
near view openrail.near nft_token '{"token_id":"acme-3f2a9c41d07b"}'
near view openrail.near sponsor_status '{"account_id":"acme.near"}'
```

## Book a payment yourself

If the watcher were down, a payment would wait, but nothing would be lost. Anyone can book it:

```bash near-cli
near call openrail.near reconcile '{"token_id":"acme-3f2a9c41d07b"}' \
    --accountId <your-account> --gas 250000000000000
```

The `booked` event appears if the invoice's balance rose.

## Proof data for programs

[`/proof.json`](/proof.json) lists the demo business's recent transactions as data: type, amount, time, claim account, transaction hash and explorer link, newest first.
