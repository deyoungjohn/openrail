import { OpenrailClient } from "@openrail/api-client";

// The public pay page uses a publishable key; the dashboard uses the session (later work).
export const client = new OpenrailClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787",
  apiKey: process.env.NEXT_PUBLIC_API_PUBLISHABLE_KEY,
});
