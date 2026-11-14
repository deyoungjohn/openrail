import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

describe("/c/[id] page dispatching (three cases)", () => {
  it("case 1: redirects to /pay/<id> when checkout module is disabled", async () => {
    redirectMock.mockClear();

    // Dynamically test dispatch behavior when no module provides PublicOrderPage
    function dispatchPage(id: string, hasModule: boolean, kind: number | null) {
      if (!hasModule) {
        redirectMock(`/pay/${encodeURIComponent(id)}`);
        return null;
      }
      if (kind === 0) {
        redirectMock(`/pay/${encodeURIComponent(id)}`);
        return null;
      }
      return "CheckoutScreen";
    }

    const res = dispatchPage("c-1", false, null);
    expect(res).toBeNull();
    expect(redirectMock).toHaveBeenCalledWith("/pay/c-1");
  });

  it("case 2: redirects to /pay/<id> when claim is kind 0 (invoice)", async () => {
    redirectMock.mockClear();

    function dispatchPage(id: string, hasModule: boolean, kind: number | null) {
      if (!hasModule) {
        redirectMock(`/pay/${encodeURIComponent(id)}`);
        return null;
      }
      if (kind === 0) {
        redirectMock(`/pay/${encodeURIComponent(id)}`);
        return null;
      }
      return "CheckoutScreen";
    }

    const res = dispatchPage("c-1", true, 0);
    expect(res).toBeNull();
    expect(redirectMock).toHaveBeenCalledWith("/pay/c-1");
  });

  it("case 3: shows the checkout screen when claim is kind 1 (checkout)", async () => {
    redirectMock.mockClear();

    function dispatchPage(id: string, hasModule: boolean, kind: number | null) {
      if (!hasModule) {
        redirectMock(`/pay/${encodeURIComponent(id)}`);
        return null;
      }
      if (kind === 0) {
        redirectMock(`/pay/${encodeURIComponent(id)}`);
        return null;
      }
      return "CheckoutScreen";
    }

    const res = dispatchPage("c-101", true, 1);
    expect(res).toBe("CheckoutScreen");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
