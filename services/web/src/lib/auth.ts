import type { AuthChallenge, AuthSession } from "@openrail/api-client";

// Dashboard sign-in (blueprint 2.10, Onboarding). The API holds the session in an HttpOnly cookie
// (S1c), so a reload restores it with one GET and the page never sees or stores a token.

export interface SessionInfo {
  account_id: string;
  expires_at: string;
}

/** What the wallet returns for a NEP-413 message. */
export interface SignedChallenge {
  accountId: string;
  publicKey: string;
  signature: string;
}

export interface ChallengeToSign {
  message: string;
  nonce: string;
  recipient: string;
}

export interface AuthApi {
  /** The current session, or null when signed out. Throws when the check itself failed. */
  session(): Promise<SessionInfo | null>;
  /** `accountId` is the NEAR account the wallet just connected: the API issues the challenge for it. */
  signIn(
    sign: (c: ChallengeToSign) => Promise<SignedChallenge>,
    accountId?: string,
  ): Promise<SessionInfo>;
  signOut(): Promise<void>;
}

export type AuthFetch = (url: string, init: RequestInit) => Promise<Response>;

const JSON_HEADERS = { accept: "application/json", "content-type": "application/json" };

export function liveAuth(baseUrl: string, f: AuthFetch = (url, init) => fetch(url, init)): AuthApi {
  const base = baseUrl.replace(/\/+$/, "");
  const post = (path: string, body: unknown) =>
    f(`${base}${path}`, {
      method: "POST",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  return {
    async session() {
      const r = await f(`${base}/v1/auth/session`, {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (r.status === 401) return null;
      if (!r.ok) throw new Error(`SESSION_CHECK_${r.status}`);
      const s = (await r.json()) as SessionInfo;
      return { account_id: s.account_id, expires_at: s.expires_at };
    },

    async signIn(sign, accountId) {
      const cr = await post("/v1/auth/challenge", { account_id: accountId });
      if (!cr.ok) throw new Error(`CHALLENGE_${cr.status}`);
      const c = (await cr.json()) as AuthChallenge;
      const signed = await sign({ message: c.message, nonce: c.nonce, recipient: c.recipient });
      const vr = await post("/v1/auth/verify", {
        account_id: signed.accountId,
        public_key: signed.publicKey,
        signature: signed.signature,
        nonce: c.nonce,
      });
      if (!vr.ok) throw new Error(`VERIFY_${vr.status}`);
      const s = (await vr.json()) as AuthSession;
      // The body repeats the token for CLI use; the cookie is what the browser relies on.
      return { account_id: s.account_id, expires_at: s.expires_at };
    },

    async signOut() {
      const r = await post("/v1/auth/logout", {});
      if (!r.ok) throw new Error(`LOGOUT_${r.status}`);
    },
  };
}

// ---- fixture mode -------------------------------------------------------------------------
// Until S1c merges the "session" is a plain cookie on this origin, standing in for the real
// HttpOnly one. It holds the account id only, never a token.

const MOCK_COOKIE = "or_sess_mock";
export const MOCK_ACCOUNT = "acme.openrail.near";

const readCookie = (): string | null => {
  const m = document.cookie.split("; ").find((c) => c.startsWith(`${MOCK_COOKIE}=`));
  return m ? decodeURIComponent(m.slice(MOCK_COOKIE.length + 1)) : null;
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const week = () => new Date(Date.now() + 7 * 86_400_000);

export const mockAuth: AuthApi = {
  async session() {
    await wait(250);
    const v = readCookie();
    if (v === "__error") throw new Error("MOCK_SESSION_ERROR");
    // Fixture mode only: hold the check back so a test can look at the loading state.
    if (v === "__slow") {
      await wait(8000);
      return null;
    }
    return v ? { account_id: v, expires_at: week().toISOString() } : null;
  },
  async signIn() {
    await wait(600);
    document.cookie = `${MOCK_COOKIE}=${MOCK_ACCOUNT}; path=/; expires=${week().toUTCString()}; samesite=lax`;
    return { account_id: MOCK_ACCOUNT, expires_at: week().toISOString() };
  },
  async signOut() {
    await wait(150);
    document.cookie = `${MOCK_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  },
};

export const MOCK_MODE = process.env.NEXT_PUBLIC_API_MODE !== "live";

export const auth: AuthApi = MOCK_MODE
  ? mockAuth
  : liveAuth(process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787");
