import { CliError } from "./errors.js";

export interface CliConfig {
  apiUrl: string;
  apiKey: string;
  nearAccountId?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new CliError("MISSING_ENV", `MISSING_ENV: ${name}`);
  }
  return value;
}

export function loadConfig(apiUrlOverride?: string): CliConfig {
  return {
    apiUrl: apiUrlOverride ?? required("OPENRAIL_API_URL"),
    apiKey: required("OPENRAIL_API_KEY"),
    nearAccountId: process.env.NEAR_ACCOUNT_ID,
  };
}
