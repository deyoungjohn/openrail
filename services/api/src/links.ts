/**
 * Public links of an invoice: `<base>/<business>/inv/<ref>` to pay it and `<base>/<business>/inv/ack/<ref>` to
 * accept it. `<ref>` is the invoice's own random id without its prefix, so a link cannot be guessed from the claim
 * counter. The business part is only for reading: the page finds the invoice by `<ref>`.
 */

/** Top-level names the web app already uses for a page; a business is never given one of them. */
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

/** A lowercase, URL-safe form of the business name, or of its NEAR account when the name leaves nothing usable. */
export function businessSlug(legalName: string, accountId: string): string {
  const slug = clean(legalName) || clean(accountId) || "business";
  return RESERVED.has(slug) ? `${slug}-co` : slug;
}

/** The part of an invoice id (`inv_<hex>`) that goes in a link. */
export const refOf = (invoiceId: string): string => invoiceId.replace(/^inv_/, "");

export const payLink = (base: string, slug: string, ref: string): string =>
  `${base}/${slug}/inv/${ref}`;

export const ackLink = (base: string, slug: string, ref: string): string =>
  `${base}/${slug}/inv/ack/${ref}`;
