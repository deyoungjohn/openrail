import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the mock session exists only in fixture mode", () => {
  it("live mode talks to the API and never uses the mock (no or_sess_mock cookie)", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MODE", "live");
    vi.resetModules();
    const m = await import("./auth");
    expect(m.MOCK_MODE).toBe(false);
    expect(m.auth).not.toBe(m.mockAuth);
  });

  it("fixture mode (the default) uses the mock", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MODE", "");
    vi.resetModules();
    const m = await import("./auth");
    expect(m.MOCK_MODE).toBe(true);
    expect(m.auth).toBe(m.mockAuth);
  });
});
