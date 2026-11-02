"use client";

import { NearConnector, type NearWalletBase } from "@hot-labs/near-connect";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChallengeToSign, SignedChallenge } from "../lib/auth";
import { WalletPicker } from "../components/wallet-picker";
import type { PickerPurpose } from "./groups";

/** One wallet in the picker. `signsMessage`: true or false from the selector, null while unknown. */
export interface NearWalletInfo {
  id: string;
  name: string;
  iconUrl: string | null;
  type: string;
  /** False when the wallet cannot run here, for example an extension that is not installed. */
  available: boolean;
  signsMessage: boolean | null;
}

interface NearState {
  accountId: string | null;
  walletId: string | null;
  ready: boolean;
  error: boolean;
  wallets: NearWalletInfo[];
  /** Opens the wallet picker and then connects the wallet the person chose. */
  signIn: () => void;
  /** Opens the picker and returns the chosen wallet id, or null if it was closed. */
  pickWallet: (purpose: PickerPurpose) => Promise<string | null>;
  /** Connects one wallet (its own pop-up or app). */
  connect: (walletId: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** One FunctionCall transaction, signed by the connected NEAR wallet. */
  call: (c: NearCall) => Promise<void>;
  /** NEP-413 signature of the sign-in challenge. Throws `SIGNMESSAGE_UNSUPPORTED` for wallets without it. */
  signMessage: (c: ChallengeToSign) => Promise<SignedChallenge>;
  /** Asks the selector which wallets support signMessage. Safe to call again. */
  probeWallets: () => Promise<void>;
}

export interface NearCall {
  receiverId: string;
  methodName: string;
  args: object;
  /** Gas as a decimal string of gas units. */
  gas: string;
  /** Deposit in yoctoNEAR as a decimal string. */
  deposit: string;
}

const Ctx = createContext<NearState | null>(null);

export function useNear() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNear must be used inside <NearProvider>");
  return ctx;
}

const network = process.env.NEXT_PUBLIC_NEAR_NETWORK === "testnet" ? "testnet" : "mainnet";

// SPIKE: the same NearState interface backed by NEAR Connect (@hot-labs/near-connect) instead of
// the wallet selector. Capability comes from each wallet's manifest `features.signMessage`.
export function NearProvider({ children }: { children: ReactNode }) {
  const connector = useRef<NearConnector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [wallets, setWallets] = useState<NearWalletInfo[]>([]);
  const [picker, setPicker] = useState<null | {
    purpose: PickerPurpose;
    done: (id: string | null) => void;
  }>(null);

  useEffect(() => {
    const c = new NearConnector({
      network,
      excludedWallets: ["mynearwallet"],
      autoConnect: true,
    });
    connector.current = c;
    const refresh = () =>
      setWallets(
        c.availableWallets.map((w) => ({
          id: w.manifest.id,
          name: w.manifest.name,
          iconUrl: w.manifest.icon || null,
          type: w.manifest.type,
          available: true,
          signsMessage: w.manifest.features.signMessage === true,
        })),
      );
    c.whenManifestLoaded
      .then(() => {
        refresh();
        setReady(true);
        return c.getConnectedWallet().then(
          ({ wallet, accounts }) => {
            setWalletId(wallet.manifest.id);
            setAccountId(accounts[0]?.accountId ?? null);
          },
          () => undefined,
        );
      })
      .catch(() => setError(true));
    c.on("wallet:signIn", (t) => {
      setWalletId(t.wallet.manifest.id);
      setAccountId(t.accounts[0]?.accountId ?? null);
    });
    c.on("wallet:signOut", () => {
      setWalletId(null);
      setAccountId(null);
    });
    c.on("selector:walletsChanged", refresh);
    return () => c.removeAllListeners();
  }, []);

  // Capability is in the manifest, so there is nothing to probe.
  const probeWallets = useCallback(async () => {}, []);

  const pickWallet = useCallback(
    (purpose: PickerPurpose) =>
      new Promise<string | null>((resolve) => {
        setPicker({
          purpose,
          done: (id) => {
            setPicker(null);
            resolve(id);
          },
        });
      }),
    [],
  );

  const connect = useCallback(async (id: string) => {
    await connector.current?.connect({ walletId: id });
  }, []);

  const signIn = useCallback(() => {
    void pickWallet("connect").then((id) => (id ? connect(id) : undefined));
  }, [pickWallet, connect]);

  const signOut = useCallback(async () => {
    await connector.current?.disconnect();
  }, []);

  const call = useCallback(async (c: NearCall) => {
    const wallet: NearWalletBase = await connector.current!.wallet();
    await wallet.signAndSendTransaction({
      receiverId: c.receiverId,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: c.methodName,
            args: c.args as Record<string, unknown>,
            gas: c.gas,
            deposit: c.deposit,
          },
        },
      ],
    });
  }, []);

  const signMessage = useCallback(async (c: ChallengeToSign): Promise<SignedChallenge> => {
    const wallet = await connector.current!.wallet();
    if (wallet.manifest.features.signMessage !== true) throw new Error("SIGNMESSAGE_UNSUPPORTED");
    const nonce = Uint8Array.from(atob(c.nonce), (ch) => ch.charCodeAt(0));
    const signed = await wallet.signMessage({ message: c.message, recipient: c.recipient, nonce });
    return {
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: signed.signature,
    };
  }, []);

  const value = useMemo(
    () => ({
      accountId,
      walletId,
      ready,
      error,
      wallets,
      signIn,
      pickWallet,
      connect,
      signOut,
      call,
      signMessage,
      probeWallets,
    }),
    [
      accountId,
      walletId,
      ready,
      error,
      wallets,
      signIn,
      pickWallet,
      connect,
      signOut,
      call,
      signMessage,
      probeWallets,
    ],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <WalletPicker
        wallets={wallets}
        open={picker !== null}
        purpose={picker?.purpose}
        onPick={(id) => picker?.done(id)}
        onClose={() => picker?.done(null)}
      />
    </Ctx.Provider>
  );
}
