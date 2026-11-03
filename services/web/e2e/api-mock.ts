import type { Page, Route } from "@playwright/test";
import { readFileSync } from "node:fs";

export const API = "http://127.0.0.1:8787";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const fixture = (name: string): any =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/api/${name}.json`, import.meta.url), "utf8"));

const CORS = {
  "access-control-allow-origin": "http://127.0.0.1:3100",
  "access-control-allow-credentials": "true",
  "access-control-allow-headers": "authorization,content-type,idempotency-key",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
};

export interface Handler {
  status?: number;
  body: unknown;
  /** Hold the answer back, to look at a loading state. */
  delayMs?: number;
}
export type Handlers = Record<string, Handler | ((req: { body: any; url: URL }) => Handler)>;

/** Intercepts the API at the network level. Keys are `METHOD /path`; `{id}` matches one segment. */
export async function mockApi(page: Page, handlers: Handlers) {
  const calls: { key: string; body: any }[] = [];
  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const entry = Object.entries(handlers).find(([k]) => {
      const [m, p] = k.split(" ");
      if (m !== req.method()) return false;
      const re = new RegExp(`^${p!.replace(/\{[^}]+\}/g, "[^/]+")}$`);
      return re.test(url.pathname);
    });
    const body = req.postData() ? req.postDataJSON() : undefined;
    if (!entry)
      return route.fulfill({
        status: 404,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify({ error: { code: "not_found", message: url.pathname } }),
      });
    calls.push({ key: entry[0], body });
    const h = typeof entry[1] === "function" ? entry[1]({ body, url }) : entry[1];
    if (h.delayMs) await new Promise((r) => setTimeout(r, h.delayMs));
    return route.fulfill({
      status: h.status ?? 200,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify(h.body),
    });
  });
  return calls;
}
