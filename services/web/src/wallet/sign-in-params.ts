/**
 * What to ask a wallet when connecting for sign-in. Almost all wallets connect with no contract, so no
 * access key is added (a key costs a transaction, and some wallets refuse it below 0.1 NEAR). Here
 * Wallet is the exception: its key-less connect signs an "authenticate" message before any account is
 * stored, so its app receives an empty account selector and refuses the request ("Invalid schema").
 * It needs the key-based connect, which stores the account first.
 */
const NEEDS_CONTRACT: readonly string[] = ["here-wallet"];

export function signInParams(walletId: string, contractId: string): { contractId?: string } {
  return NEEDS_CONTRACT.includes(walletId) ? { contractId } : {};
}
