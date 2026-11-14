/**
 * Shopify Payments Apps API client (`2025-10`) for candidate (1) Offsite Payments Extensions.
 *
 * Every mutation and input name is verified against official Shopify documentation:
 * - Offsite payment extension flow: https://shopify.dev/docs/apps/build/payments/offsite
 * - Extension review & approval rule: https://shopify.dev/docs/apps/build/payments/payments-extension-review
 * - `paymentsAppConfigure`: https://shopify.dev/docs/api/payments-apps/2025-10/mutations/paymentsAppConfigure
 * - `paymentSessionResolve`: https://shopify.dev/docs/api/payments-apps/2025-10/mutations/paymentSessionResolve
 * - `paymentSessionPending`: https://shopify.dev/docs/api/payments-apps/2025-10/mutations/paymentSessionPending
 * - `paymentSessionReject`: https://shopify.dev/docs/api/payments-apps/2025-10/mutations/paymentSessionReject
 */

import type { ShopifyUserError } from "./admin-client.js";

export const SHOPIFY_PAYMENTS_APPS_API_VERSION = "2025-10";

export const PAYMENTS_APP_CONFIGURE_MUTATION = `#graphql
  mutation paymentsAppConfigure($externalHandle: String, $ready: Boolean!) {
    paymentsAppConfigure(externalHandle: $externalHandle, ready: $ready) {
      paymentsAppConfiguration {
        externalHandle
        ready
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const PAYMENT_SESSION_RESOLVE_MUTATION = `#graphql
  mutation paymentSessionResolve($id: ID!, $networkTransactionId: String) {
    paymentSessionResolve(id: $id, networkTransactionId: $networkTransactionId) {
      paymentSession {
        id
        state {
          ... on PaymentSessionStateResolved {
            code
          }
        }
        nextAction {
          action
          context {
            ... on PaymentSessionActionsRedirect {
              redirectUrl
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const PAYMENT_SESSION_PENDING_MUTATION = `#graphql
  mutation paymentSessionPending(
    $id: ID!
    $pendingExpiresAt: DateTime!
    $reason: PaymentSessionStatePendingReason!
  ) {
    paymentSessionPending(
      id: $id
      pendingExpiresAt: $pendingExpiresAt
      reason: $reason
    ) {
      paymentSession {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const PAYMENT_SESSION_REJECT_MUTATION = `#graphql
  mutation paymentSessionReject($id: ID!, $reason: PaymentSessionRejectionReasonInput!) {
    paymentSessionReject(id: $id, reason: $reason) {
      paymentSession {
        id
        nextAction {
          action
          context {
            ... on PaymentSessionActionsRedirect {
              redirectUrl
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface ShopifyOffsitePaymentSessionRequest {
  id: string;
  gid: string;
  group: string;
  amount: string;
  currency: string;
  test: boolean;
  kind: "sale" | "authorization";
  cancel_url?: string;
  order_gid?: string;
}

export interface ShopifyPaymentsAppClientOptions {
  shopDomain: string;
  accessToken?: string;
  adminClient?: { getAccessToken(): Promise<string> };
  getToken?: () => Promise<string>;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

export class ShopifyPaymentsAppClient {
  private readonly endpoint: string;
  private readonly accessToken?: string;
  private readonly adminClient?: { getAccessToken(): Promise<string> };
  private readonly getToken?: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ShopifyPaymentsAppClientOptions) {
    const version = options.apiVersion ?? SHOPIFY_PAYMENTS_APPS_API_VERSION;
    const host = options.shopDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.endpoint = `https://${host}/payments_apps/api/${version}/graphql.json`;
    this.accessToken = options.accessToken;
    this.adminClient = options.adminClient;
    this.getToken = options.getToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token =
      this.accessToken ??
      (this.getToken ? await this.getToken() : await this.adminClient?.getAccessToken()) ??
      "";
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`Shopify Payments Apps GraphQL HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `Shopify Payments Apps GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!json.data) {
      throw new Error("Shopify Payments Apps GraphQL returned empty data");
    }
    return json.data;
  }

  async paymentsAppConfigure(
    ready: boolean,
    externalHandle?: string,
  ): Promise<{ Ready: boolean; userErrors: ShopifyUserError[] }> {
    const data = await this.graphql<{
      paymentsAppConfigure: {
        paymentsAppConfiguration?: { ready: boolean } | null;
        userErrors: ShopifyUserError[];
      };
    }>(PAYMENTS_APP_CONFIGURE_MUTATION, {
      ready,
      ...(externalHandle ? { externalHandle } : {}),
    });
    return {
      Ready: Boolean(data.paymentsAppConfigure.paymentsAppConfiguration?.ready),
      userErrors: data.paymentsAppConfigure.userErrors,
    };
  }

  async paymentSessionResolve(
    id: string,
    networkTransactionId?: string,
  ): Promise<{ redirectUrl?: string; userErrors: ShopifyUserError[] }> {
    const data = await this.graphql<{
      paymentSessionResolve: {
        paymentSession?: {
          nextAction?: { context?: { redirectUrl?: string } };
        } | null;
        userErrors: ShopifyUserError[];
      };
    }>(PAYMENT_SESSION_RESOLVE_MUTATION, {
      id,
      ...(networkTransactionId ? { networkTransactionId } : {}),
    });
    const redirectUrl = data.paymentSessionResolve.paymentSession?.nextAction?.context?.redirectUrl;
    return {
      ...(redirectUrl ? { redirectUrl } : {}),
      userErrors: data.paymentSessionResolve.userErrors,
    };
  }

  async paymentSessionPending(
    id: string,
    pendingExpiresAt: string,
    reason:
      | "BUYER_ACTION_REQUIRED"
      | "NETWORK_ACTION_REQUIRED"
      | "PARTNER_ACTION_REQUIRED" = "BUYER_ACTION_REQUIRED",
  ): Promise<{ userErrors: ShopifyUserError[] }> {
    const data = await this.graphql<{
      paymentSessionPending: { userErrors: ShopifyUserError[] };
    }>(PAYMENT_SESSION_PENDING_MUTATION, {
      id,
      pendingExpiresAt,
      reason,
    });
    return { userErrors: data.paymentSessionPending.userErrors };
  }

  async paymentSessionReject(
    id: string,
    code: "PROCESSING_ERROR" | "RISKY" | "AUTHENTICATION_FAILED",
    merchantMessage?: string,
  ): Promise<{ redirectUrl?: string; userErrors: ShopifyUserError[] }> {
    const data = await this.graphql<{
      paymentSessionReject: {
        paymentSession?: {
          nextAction?: { context?: { redirectUrl?: string } };
        } | null;
        userErrors: ShopifyUserError[];
      };
    }>(PAYMENT_SESSION_REJECT_MUTATION, {
      id,
      reason: {
        code,
        ...(merchantMessage ? { merchantMessage } : {}),
      },
    });
    const redirectUrl = data.paymentSessionReject.paymentSession?.nextAction?.context?.redirectUrl;
    return {
      ...(redirectUrl ? { redirectUrl } : {}),
      userErrors: data.paymentSessionReject.userErrors,
    };
  }
}
