/** NEAR token payments from the connected wallet: the function calls only (no React, no network). */

/** NEP-145 storage for one account on a NEP-141 token: enough for every token we route (0.00125 NEAR). */
export const NEAR_TOKEN_STORAGE_YOCTO = "1250000000000000000000";

/**
 * A NEAR token payment as one transaction to the token contract: register the deposit address with the token (it is
 * a fresh account the token does not know yet; wallets warn that it "does not exist", which is expected), then the
 * transfer. Registering an account twice refunds the deposit.
 */
export function nearTokenPayment(to: string, amount: bigint, contract = "", from = "") {
  // Native NEAR is paid as wrapped NEAR: register the payer with wrap.near, wrap the amount, then the same transfer.
  const wrap =
    contract === "wrap.near"
      ? [
          {
            methodName: "storage_deposit",
            args: { account_id: from, registration_only: true },
            gas: "30000000000000",
            deposit: NEAR_TOKEN_STORAGE_YOCTO,
          },
          {
            methodName: "near_deposit",
            args: {},
            gas: "30000000000000",
            deposit: amount.toString(),
          },
        ]
      : [];
  return [
    ...wrap,
    {
      methodName: "storage_deposit",
      args: { account_id: to, registration_only: true },
      gas: "30000000000000",
      deposit: NEAR_TOKEN_STORAGE_YOCTO,
    },
    {
      methodName: "ft_transfer",
      args: { receiver_id: to, amount: amount.toString() },
      gas: "30000000000000",
      deposit: "1",
    },
  ];
}
