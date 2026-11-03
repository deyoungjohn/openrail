"use client";

import { useEffect } from "react";
import { useNear } from "@/wallet/near";

/** Dev only: what the selector itself says each wallet supports. Feeds the PR's capability table. */
export default function WalletsDev() {
  const { wallets, ready, error, probeWallets } = useNear();
  useEffect(() => {
    if (ready) void probeWallets();
  }, [ready, probeWallets]);

  return (
    <main className="mx-auto max-w-[960px] space-y-6 px-4 py-8">
      <h1 className="text-[32px] leading-10 font-bold">Wallet capabilities</h1>
      <p className="caption">
        Read from the selector at runtime: a wallet supports signMessage when the selector's own
        check does not refuse it.
      </p>
      {error ? <p role="alert">The wallet selector did not start.</p> : null}
      <table className="w-full text-[14px]" data-testid="capabilities">
        <caption className="sr-only">Wallet capabilities</caption>
        <thead>
          <tr className="text-left">
            <th scope="col" className="py-2">
              Wallet
            </th>
            <th scope="col">Id</th>
            <th scope="col">Type</th>
            <th scope="col">Available here</th>
            <th scope="col">signMessage</th>
          </tr>
        </thead>
        <tbody>
          {wallets.map((w) => (
            <tr key={w.id} className="border-t border-border">
              <td className="py-2">{w.name}</td>
              <td className="font-mono text-[13px]">{w.id}</td>
              <td>{w.type}</td>
              <td data-field="available">{w.available ? "yes" : "no"}</td>
              <td data-field="signs">
                {w.signsMessage === null ? "unknown" : w.signsMessage ? "yes" : "no"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
