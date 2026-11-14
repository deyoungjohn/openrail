/** Reads the merchant's payout settings from the API over the loopback/internal key. */
import { requireEnv } from "@openrail/shared";
import type { PayoutSettings, PayoutSettingsPort } from "./types.js";

export class HttpPayoutSettings implements PayoutSettingsPort {
  private readonly baseUrl: string;
  private readonly key: string;

  constructor(baseUrl: string, key: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.key = key;
  }

  static fromEnv(): HttpPayoutSettings {
    return new HttpPayoutSettings(requireEnv("PAYOUT_API_URL"), requireEnv("PAYOUT_INTERNAL_KEY"));
  }

  async forToken(tokenId: string): Promise<PayoutSettings | null> {
    const response = await fetch(
      `${this.baseUrl}/v1/internal/payout_settings?token_id=${encodeURIComponent(tokenId)}`,
      { headers: { "x-openrail-internal-key": this.key }, signal: AbortSignal.timeout(15_000) },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`PAYOUT_SETTINGS_HTTP_${response.status}`);
    const body = (await response.json()) as { schedule?: unknown; destination?: unknown };
    const schedule = body.schedule;
    if (
      schedule !== "manual" &&
      schedule !== "each_payment" &&
      schedule !== "daily" &&
      schedule !== "weekly" &&
      schedule !== "monthly"
    )
      throw new Error("PAYOUT_SETTINGS_INVALID");
    return {
      schedule,
      destination: typeof body.destination === "string" ? body.destination : null,
    };
  }
}
