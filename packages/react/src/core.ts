/**
 * Pure helpers shared by the React button: they build the hosted pay URL and recognise the
 * hosted page's "paid" message. Same protocol as the script-tag widget (packages/widget).
 */

export interface PayTarget {
  /** Claim token id, for example `c-12`. Opens `<payUrl>/pay/<invoice>`. */
  invoice?: string;
  /** Any other hosted pay path on the pay origin, for example `/pay/c-12?route=R4`. Must start with `/`. */
  path?: string;
}

export interface PaidMessage {
  type: "openrail:payment-complete" | "openrail:paid";
  [key: string]: unknown;
}

const PAID_TYPES = new Set(["openrail:payment-complete", "openrail:paid"]);

/** The origin of the hosted pay site, without a trailing slash. Throws on anything but http(s). */
export function payOrigin(payUrl: string): string {
  let url: URL;
  try {
    url = new URL(payUrl);
  } catch {
    throw new Error(`invalid payUrl: ${payUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`payUrl must be http(s): ${payUrl}`);
  }
  return url.origin;
}

/** The iframe URL for a target. Exactly one of `invoice` or `path` must be given. */
export function payFrameUrl(payUrl: string, target: PayTarget): string {
  const origin = payOrigin(payUrl);
  const hasInvoice = typeof target.invoice === "string" && target.invoice.length > 0;
  const hasPath = typeof target.path === "string" && target.path.length > 0;
  if (hasInvoice === hasPath) throw new Error("give exactly one of invoice or path");
  if (hasInvoice) return `${origin}/pay/${encodeURIComponent(target.invoice as string)}`;
  const path = target.path as string;
  // Same-origin only: no scheme, no protocol-relative `//host`, no backslash tricks.
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error(`path must be an absolute path on the pay origin: ${path}`);
  }
  const resolved = new URL(path, origin);
  if (resolved.origin !== origin) throw new Error(`path leaves the pay origin: ${path}`);
  return resolved.toString();
}

/** True when a `message` event comes from the pay origin and says the payment is complete. */
export function isPaidMessage(
  event: { origin: string; data: unknown },
  origin: string,
): PaidMessage | null {
  if (event.origin !== origin) return null;
  const data = event.data;
  if (data === "openrail:payment-complete") return { type: "openrail:payment-complete" };
  if (
    data &&
    typeof data === "object" &&
    PAID_TYPES.has((data as { type?: unknown }).type as string)
  ) {
    return data as PaidMessage;
  }
  return null;
}
