import { OpenrailClient } from "@openrail/api-client";

// The public pay page uses a publishable key; the dashboard uses the session (later work).
export const client = new OpenrailClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787",
  apiKey: process.env.NEXT_PUBLIC_API_PUBLISHABLE_KEY,
});

/**
 * Guest mode: a visitor who has not signed in sees every app page with its layout and nothing in it (14 Nov, human:
 * people want to see before they sign in). The dashboard's reads are answered here with empty data in the API's own
 * shapes, without calling the server; anything that would change something is refused with `sign_in_required`.
 * The auth gate turns it on while signed out and off once a session exists.
 */
let guest = false;
export function setGuestMode(on: boolean): void {
  guest = on;
}
export const isGuestMode = (): boolean => guest;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const EMPTY_BUSINESS = {
  account_id: "",
  username: "",
  legal_name: "",
  payout_account: "",
  contact_email: "",
  created_at: "1970-01-01T00:00:00Z",
  updated_at: "1970-01-01T00:00:00Z",
  fee_mode: "absorb",
};

export function guestResponse(url: string, method: string): Response {
  if (method.toUpperCase() !== "GET")
    return json(401, { error: { code: "sign_in_required", message: "Sign in to do this." } });
  const path = new URL(url).pathname;
  if (path === "/v1/business") return json(200, EMPTY_BUSINESS);
  if (path === "/v1/business/storage_credit")
    return json(200, {
      balance: "0",
      account_id: "",
      contract_id: "openrail.near",
      amount: "20000000000000000000000",
      method: "deposit_storage_credit",
    });
  if (path === "/v1/balance/intents") return json(200, { balances: [] });
  // The confidential balance needs its own signature: it shows as locked.
  if (path === "/v1/balance/confidential")
    return json(409, {
      error: { code: "confidential_session_required", message: "Sign in first." },
    });
  if (path === "/v1/auth/session")
    return json(401, { error: { code: "unauthorized", message: "Not signed in." } });
  // Every list the pages read: empty.
  return json(200, { data: [], next_cursor: null });
}

// Dashboard calls carry the HttpOnly session cookie (the client sends credentials by default).
export const dashClient = new OpenrailClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787",
  fetchImpl: (input, init) =>
    guest
      ? Promise.resolve(guestResponse(String(input), init?.method ?? "GET"))
      : fetch(input, init),
});
