import type { BrowserContext } from "@playwright/test";

/** Fixture mode keeps its stand-in session in this cookie (see src/lib/auth.ts). */
export async function signIn(context: BrowserContext, account = "acme.openrail.near") {
  await context.addCookies([
    { name: "or_sess_mock", value: account, url: "http://127.0.0.1:3100" },
  ]);
}
