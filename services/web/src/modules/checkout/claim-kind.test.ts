import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClaimKind } from "./claim-kind";

describe("claim kind resolution and /c/<id> legacy route dispatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("case 2: resolves kind 0 for an invoice claim and redirects to /pay/<id>", async () => {
    // "c-1" is in mockClaims as an invoice
    const kind = await resolveClaimKind("c-1");
    expect(kind).toBe(0);
  });

  it("case 3: resolves kind 1 for a checkout claim", async () => {
    // Mock the API public checkout endpoint returning 200
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/public/checkouts/chk_opaque_123")) {
        return new Response(JSON.stringify({ id: "chk_opaque_123", status: "pending" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    }) as typeof fetch;

    try {
      const kind = await resolveClaimKind("chk_opaque_123");
      expect(kind).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("case 2 (via API): resolves kind 0 when public claim endpoint returns an invoice", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/public/checkouts/inv_opaque_999")) {
        return new Response(JSON.stringify({ error: { code: "checkout_not_found" } }), {
          status: 404,
        });
      }
      if (urlStr.includes("/v1/pay/claims/inv_opaque_999")) {
        return new Response(
          JSON.stringify({ token_id: "inv_opaque_999", invoice_number: "INV-999" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    }) as typeof fetch;

    try {
      const kind = await resolveClaimKind("inv_opaque_999");
      expect(kind).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("supports opaque token ids without assuming c-<n> prefix", async () => {
    const opaqueIds = [
      "alice-9f3c2a7d41b8.openrail.near",
      "acme-shop-a1b2c3d4e5f6",
      "merch_tok_789xyz",
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      for (const id of opaqueIds) {
        if (urlStr.includes(`/v1/public/checkouts/${encodeURIComponent(id)}`)) {
          return new Response(JSON.stringify({ id, token_id: id, status: "pending" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    }) as typeof fetch;

    try {
      for (const id of opaqueIds) {
        const kind = await resolveClaimKind(id);
        expect(kind).toBe(1);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
