/** Webhook URL policy: HTTPS only, public addresses, pinned DNS, no redirects. */
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export class UnsafeWebhookUrl extends Error {
  override readonly name = "UnsafeWebhookUrl";
  readonly code = "invalid_webhook_url";

  constructor(message = "webhook URL is not allowed") {
    super(message);
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })) as ResolvedAddress[];

function ipv4ToInt(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function inV4(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

function blockedV4(address: string): boolean {
  return (
    inV4(address, "0.0.0.0", 8) ||
    inV4(address, "10.0.0.0", 8) ||
    inV4(address, "100.64.0.0", 10) ||
    inV4(address, "127.0.0.0", 8) ||
    inV4(address, "169.254.0.0", 16) ||
    inV4(address, "172.16.0.0", 12) ||
    inV4(address, "192.0.0.0", 24) ||
    inV4(address, "192.168.0.0", 16) ||
    inV4(address, "198.18.0.0", 15) ||
    inV4(address, "224.0.0.0", 4) ||
    inV4(address, "240.0.0.0", 4)
  );
}

function v6Groups(address: string): number[] | undefined {
  const lower = address.toLowerCase();
  const halves = lower.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (group.includes(".")) {
        const octets = group.split(".").map((octet) => Number(octet));
        groups.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0));
        groups.push(((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
      } else {
        groups.push(Number.parseInt(group || "0", 16));
      }
    }
    return groups;
  };
  const head = parse(halves[0] ?? "");
  const tail = parse(halves[1] ?? "");
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array.from({ length: fill }, () => 0), ...tail];
  return groups.length === 8 &&
    groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
}

function blockedV6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  const groups = v6Groups(lower);
  if (groups === undefined) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return blockedV4(mapped);
  }
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return true; // 64:ff9b::/96
  }
  if (groups[0] === 0x2002) return true; // 2002::/16
  if ((groups[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((groups[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((groups[0]! & 0xff00) === 0xff00) return true; // ff00::/8
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedV4(address);
  if (family === 6) return blockedV6(address);
  return true;
}

export interface ValidatedWebhookUrl {
  url: URL;
  address: string;
  family: number;
}

/** Validate a webhook URL and pin it to a public resolved address. */
export async function validateWebhookUrl(
  input: string,
  resolver: Resolver = defaultResolver,
): Promise<ValidatedWebhookUrl> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeWebhookUrl("webhook URL is invalid");
  }
  if (url.protocol !== "https:") throw new UnsafeWebhookUrl("webhook URL must use https");
  if (url.username !== "" || url.password !== "")
    throw new UnsafeWebhookUrl("webhook URL must not contain credentials");
  if (url.port !== "" && url.port !== "443")
    throw new UnsafeWebhookUrl("webhook URL must use port 443");
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);

  const literal = isIP(url.hostname);
  if (literal !== 0) {
    if (isBlockedAddress(url.hostname)) throw new UnsafeWebhookUrl("webhook address is not public");
    return { url, address: url.hostname, family: literal };
  }

  const addresses = await resolver(url.hostname);
  if (addresses.length === 0) throw new UnsafeWebhookUrl("webhook host did not resolve");
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address))
      throw new UnsafeWebhookUrl("webhook address is not public");
  }
  const first = addresses[0];
  if (first === undefined) throw new UnsafeWebhookUrl("webhook host did not resolve");
  return { url, address: first.address, family: first.family };
}

const MAX_BODY = 4096;

/**
 * The DNS answer is pinned to the address that was checked. Node asks for `{ all: true }` when it tries several
 * addresses (since Node 20): the answer must then be a list, and a single address there fails with
 * "Invalid IP address: undefined" (the webhook test event did exactly that).
 */
export function pinnedLookup(address: string, family: number) {
  return (_hostname: string, options: unknown, callback: (...args: unknown[]) => void): void => {
    const all =
      typeof options === "object" &&
      options !== null &&
      (options as { all?: boolean }).all === true;
    if (all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** HTTPS request with pinned DNS, no redirects, a 10 s timeout and a 4 KB body cap. */
export async function safeWebhookFetch(
  input: string,
  init: RequestInit = {},
  resolver: Resolver = defaultResolver,
): Promise<Response> {
  const validated = await validateWebhookUrl(input, resolver);
  const body = typeof init.body === "string" ? init.body : undefined;
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        protocol: "https:",
        hostname: validated.url.hostname,
        port: 443,
        path: `${validated.url.pathname}${validated.url.search}`,
        method: init.method ?? "POST",
        headers: init.headers as Record<string, string> | undefined,
        servername: validated.url.hostname,
        timeout: 10_000,
        lookup: pinnedLookup(validated.address, validated.family) as never,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size >= MAX_BODY) return;
          const remaining = MAX_BODY - size;
          const part = chunk.subarray(0, remaining);
          chunks.push(part);
          size += part.length;
        });
        response.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks).toString("utf8"), {
              status: response.statusCode ?? 0,
              headers: response.headers as Record<string, string>,
            }),
          );
        });
        response.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("WEBHOOK_TIMEOUT")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Create a fetch implementation pinned to one resolver (for tests). */
export function createSafeFetch(resolver: Resolver = defaultResolver): FetchLike {
  return (input, init) => safeWebhookFetch(input, init, resolver);
}
