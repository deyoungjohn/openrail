"use client";

import { useMemo } from "react";
import { MOCK_MODE } from "../lib/api";
import { useNear } from "./near";

const INTENTS_CONTRACT = process.env.NEXT_PUBLIC_INTENTS_CONTRACT ?? "intents.near";
const TGAS = (n: number) => (BigInt(n) * 10n ** 12n).toString();

export interface Actions {
  acknowledgeNear(rootContract: string, tokenId: string): Promise<void>;
  /** Runs a reconcile and, if it passes, opens the transfer window (blueprint 2.2). */
  prepareTransfer(rootContract: string, tokenId: string): Promise<void>;
  /** Prepays storage for API issuance: `deposit_storage_credit` with the NEAR attached (blueprint 2.2). */
  depositStorageCredit(contractId: string, depositYocto: string): Promise<void>;
  /** `mt_transfer` of the holder's own Intents USDC to a cash-out deposit address (blueprint 2.9). 1 yoctoNEAR. */
  cashOut(a: { tokenId: string; depositAddress: string; amount: string }): Promise<void>;
  /** NEP-171 transfer. Exactly 1 yoctoNEAR; on a sale the memo carries the document hash. */
  nftTransfer(
    rootContract: string,
    a: { tokenId: string; receiver: string; memo: string },
  ): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const mockActions: Actions = {
  acknowledgeNear: () => wait(800),
  prepareTransfer: () => wait(1000),
  depositStorageCredit: () => wait(800),
  cashOut: () => wait(1000),
  nftTransfer: () => wait(1000),
};

/** Fixture mode never signs. Live mode asks the connected NEAR wallet. */
export function useActions(): Actions {
  const { call } = useNear();
  return useMemo<Actions>(
    () =>
      MOCK_MODE
        ? mockActions
        : {
            acknowledgeNear: (root, tokenId) =>
              call({
                receiverId: root,
                methodName: "acknowledge_near",
                args: { token_id: tokenId },
                gas: TGAS(30),
                deposit: "0",
              }),
            prepareTransfer: (root, tokenId) =>
              call({
                receiverId: root,
                methodName: "prepare_transfer",
                args: { token_id: tokenId },
                gas: TGAS(300),
                deposit: "0",
              }),
            depositStorageCredit: (contractId, depositYocto) =>
              call({
                receiverId: contractId,
                methodName: "deposit_storage_credit",
                args: {},
                gas: TGAS(30),
                deposit: depositYocto,
              }),
            cashOut: (a) =>
              call({
                receiverId: INTENTS_CONTRACT,
                methodName: "mt_transfer",
                args: { token_id: a.tokenId, receiver_id: a.depositAddress, amount: a.amount },
                gas: TGAS(30),
                deposit: "1",
              }),
            nftTransfer: (root, a) =>
              call({
                receiverId: root,
                methodName: "nft_transfer",
                args: { receiver_id: a.receiver, token_id: a.tokenId, memo: a.memo },
                gas: TGAS(30),
                deposit: "1",
              }),
          },
    [call],
  );
}
