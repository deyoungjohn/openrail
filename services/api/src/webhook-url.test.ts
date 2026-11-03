import { describe, expect, it } from "vitest";
import { isBlockedAddress, validateWebhookUrl } from "./webhook-url.js";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

describe("webhook URL validation", () => {
  it.each([
    ["0.0.0.0", true],
    ["10.1.2.3", true],
    ["100.64.0.1", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true],
    ["172.16.0.1", true],
    ["192.168.1.1", true],
    ["198.18.0.1", true],
    ["224.0.0.1", true],
    ["240.0.0.1", true],
    ["::1", true],
    ["::", true],
    ["fc00::1", true],
    ["fe80::1", true],
    ["ff02::1", true],
    ["::ffff:127.0.0.1", true],
    ["8.8.8.8", false],
    ["2606:4700:4700::1111", false],
  ])("classifies %s as blocked=%s", (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });

  it("accepts only https, no credentials and port 443", async () => {
    await expect(validateWebhookUrl("http://example.com/hook", publicResolver)).rejects.toThrow(
      "must use https",
    );
    await expect(
      validateWebhookUrl("https://user:pass@example.com/hook", publicResolver),
    ).rejects.toThrow("credentials");
    await expect(
      validateWebhookUrl("https://example.com:8443/hook", publicResolver),
    ).rejects.toThrow("port 443");
    await expect(
      validateWebhookUrl("https://example.com:443/hook", publicResolver),
    ).resolves.toMatchObject({
      address: "93.184.216.34",
    });
  });

  it("blocks an IP literal without DNS", async () => {
    await expect(validateWebhookUrl("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      "not public",
    );
    await expect(validateWebhookUrl("https://127.0.0.1:8787/health")).rejects.toThrow("port 443");
    await expect(validateWebhookUrl("https://127.0.0.1/health")).rejects.toThrow("not public");
  });

  it("blocks a hostname that resolves to a private address (rebinding)", async () => {
    await expect(
      validateWebhookUrl("https://evil.test/hook", async () => [
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow("not public");
    await expect(
      validateWebhookUrl("https://evil.test/hook", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow("not public");
  });
});
