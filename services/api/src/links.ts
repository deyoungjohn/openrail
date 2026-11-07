/**
 * Public links of an invoice: `<base>/<username>/inv/<ref>` to pay it and
 * `<base>/<username>/inv/ack/<ref>` to accept it. `<ref>` is the invoice's own random id
 * without its prefix, so a link cannot be guessed from the claim counter and survives a
 * username change. The username part is only for reading.
 */

/** Top-level names the web app already uses, plus names that would spoof the product. */
const RESERVED = new Set([
  "app",
  "pay",
  "ack",
  "r",
  "c",
  "api",
  "v1",
  "inv",
  "statement",
  "login",
  "setup",
  "docs",
  "admin",
  "_next",
  "_dev",
  "www",
  "help",
  "support",
  "openrail",
  "near",
  "settings",
  "onboarding",
  "invoices",
  "dashboard",
  "signin",
  "signup",
  "auth",
  "account",
  "accounts",
  "billing",
  "mail",
  "status",
  "blog",
  "terms",
  "privacy",
  "security",
  "legal",
  "system",
  "root",
  "wallet",
  "intents",
]);

const clean = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

/** A lowercase, URL-safe suggestion from the display name, never a name the site uses. */
export function businessSlug(legalName: string, accountId: string): string {
  const slug = clean(legalName) || clean(accountId) || "business";
  return RESERVED.has(slug) ? `${slug}-co` : slug;
}

/** A URL-safe handle suggestion for onboarding. */
export const suggestUsername = (legalName: string): string => clean(legalName);

/** The part of an invoice id (`inv_<hex>`) that goes in a link. */
export const refOf = (invoiceId: string): string => invoiceId.replace(/^inv_/, "");

/**
 * The claim label: the username made URL-safe, cut to 32, then the first 12 hex of the invoice ref.
 * The claim account is `<label>.<root>`; the contract enforces the final NEAR length/rules.
 */
export function claimLabel(username: string, ref: string): string {
  const prefix =
    username
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/g, "") || "business";
  const hash = ref.replace(/^inv_/, "").slice(0, 12).toLowerCase();
  return `${prefix}-${hash}`;
}

export const payLink = (base: string, username: string, ref: string): string =>
  `${base}/${username}/inv/${ref}`;

export const ackLink = (base: string, username: string, ref: string): string =>
  `${base}/${username}/inv/ack/${ref}`;

/** A 64-hex account id is implicit and has no named identity to use as a username. */
export const isImplicitAccountId = (accountId: string): boolean =>
  /^[0-9a-f]{64}$/i.test(accountId);

export const normalizeUsername = (raw: string): string => raw.trim().toLowerCase();

export type UsernameProblem = "invalid" | "reserved" | "taken" | null;

/** The first rule the candidate breaks, or null when the shape is valid. */
export function usernameProblem(raw: string, accountId: string): UsernameProblem {
  const username = normalizeUsername(raw);
  const own = accountId.toLowerCase();
  if (username === "") return "invalid";
  if (username.includes(".")) {
    if (username !== own) return "invalid";
  } else {
    if (username.length < 3 || username.length > 32) return "invalid";
    if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(username)) return "invalid";
    if (/[_-]{2}/.test(username)) return "invalid";
  }
  if (RESERVED.has(username)) return "reserved";
  return null;
}

export const isValidUsername = (raw: string, accountId: string): boolean =>
  usernameProblem(raw, accountId) === null;

/** `{available, reason}` for the availability route; `taken` is the store's claim check. */
export function usernameAvailability(
  raw: string,
  accountId: string,
  taken: boolean,
): { available: boolean; reason: string } {
  const problem = usernameProblem(raw, accountId);
  if (problem !== null) return { available: false, reason: problem };
  if (taken) return { available: false, reason: "taken" };
  return { available: true, reason: "available" };
}
