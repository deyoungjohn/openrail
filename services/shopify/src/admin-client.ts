/**
 * Shopify GraphQL Admin API client (`2025-10`).
 *
 * Every GraphQL query, mutation, field, and input type is verified against official Shopify documentation:
 * - Shop query & currencyCode: https://shopify.dev/docs/api/admin-graphql/2025-10/objects/Shop
 * - Order query (`totalOutstandingSet`, `displayFinancialStatus`, `fullyPaid`, `canMarkAsPaid`, `statusPageUrl`):
 *   https://shopify.dev/docs/api/admin-graphql/2025-10/objects/Order
 * - `orderMarkAsPaid` mutation (`OrderMarkAsPaidInput`):
 *   https://shopify.dev/docs/api/admin-graphql/2025-10/mutations/orderMarkAsPaid
 * - `tagsAdd` mutation:
 *   https://shopify.dev/docs/api/admin-graphql/2025-10/mutations/tagsAdd
 * - `orderUpdate` mutation (`OrderInput`):
 *   https://shopify.dev/docs/api/admin-graphql/2025-10/mutations/orderUpdate
 */

export const SHOPIFY_ADMIN_API_VERSION = "2025-10";

export interface ShopifyMoneyV2 {
  amount: string;
  currencyCode: string;
}

export interface ShopifyMoneyBag {
  shopMoney: ShopifyMoneyV2;
  presentmentMoney?: ShopifyMoneyV2;
}

export interface ShopifyShop {
  name: string;
  currencyCode: string;
  myshopifyDomain: string;
  primaryDomain: {
    url: string;
    host: string;
  };
}

export type OrderDisplayFinancialStatus =
  | "PENDING"
  | "AUTHORIZED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED"
  | "VOIDED"
  | "EXPIRED";

export interface ShopifyOrderLineItem {
  title: string;
  quantity: number;
  unitPriceUsd?: string;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  currencyCode: string;
  presentmentCurrencyCode: string;
  displayFinancialStatus: OrderDisplayFinancialStatus;
  fullyPaid: boolean;
  canMarkAsPaid: boolean;
  note: string | null;
  tags: string[];
  statusPageUrl: string;
  confirmationNumber?: string | null;
  totalOutstandingSet: ShopifyMoneyBag;
  currentTotalPriceSet: {
    shopMoney: ShopifyMoneyV2;
  };
  paymentGatewayNames: string[];
  lineItems: ShopifyOrderLineItem[];
}

export interface ShopifyUserError {
  field?: string[] | null;
  message: string;
}

export const SHOP_QUERY = `#graphql
  query OpenrailShopInfo {
    shop {
      name
      currencyCode
      myshopifyDomain
      primaryDomain {
        url
        host
      }
    }
  }
`;

export const ORDER_QUERY = `#graphql
  query OpenrailGetOrder($id: ID!) {
    order(id: $id) {
      id
      name
      currencyCode
      presentmentCurrencyCode
      displayFinancialStatus
      fullyPaid
      canMarkAsPaid
      note
      tags
      statusPageUrl
      confirmationNumber
      paymentGatewayNames
      totalOutstandingSet {
        shopMoney {
          amount
          currencyCode
        }
        presentmentMoney {
          amount
          currencyCode
        }
      }
      currentTotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      lineItems(first: 50) {
        nodes {
          title
          quantity
          originalUnitPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

export const ORDER_MARK_AS_PAID_MUTATION = `#graphql
  mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order {
        id
        name
        displayFinancialStatus
        fullyPaid
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const TAGS_ADD_MUTATION = `#graphql
  mutation tagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const ORDER_UPDATE_MUTATION = `#graphql
  mutation orderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        note
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface ShopifyAdminClientOptions {
  shopDomain: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

export class ShopifyAdminClient {
  private readonly endpoint: string;
  private readonly tokenEndpoint: string;
  private readonly staticAccessToken?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;

  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(options: ShopifyAdminClientOptions) {
    const version = options.apiVersion ?? SHOPIFY_ADMIN_API_VERSION;
    const host = options.shopDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.endpoint = `https://${host}/admin/api/${version}/graphql.json`;
    this.tokenEndpoint = `https://${host}/admin/oauth/access_token`;
    this.staticAccessToken = options.accessToken;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Returns a valid Admin API access token.
   * If a static token was supplied, uses it directly.
   * Otherwise uses the client credentials grant (POST /admin/oauth/access_token),
   * caching the token in memory until shortly before expiry (60 s buffer).
   * Never prints or logs the client secret.
   */
  async getAccessToken(): Promise<string> {
    if (this.staticAccessToken) {
      return this.staticAccessToken;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error("MISSING_CREDENTIALS: Provide clientId and clientSecret (or accessToken)");
    }

    const nowSec = this.clock();
    if (this.cachedToken && nowSec < this.tokenExpiresAt - 60) {
      return this.cachedToken;
    }

    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      let desc: string;
      try {
        const errJson = (await response.json()) as { error?: string; error_description?: string };
        desc = errJson.error_description || errJson.error || "";
      } catch {
        desc = await response.text().catch(() => "");
      }
      const safeDesc = desc ? `: ${desc.slice(0, 100)}` : "";
      throw new Error(`token_exchange_failed: HTTP ${response.status}${safeDesc}`);
    }

    const json = (await response.json()) as {
      access_token?: string;
      scope?: string;
      expires_in?: number;
    };

    if (!json.access_token || typeof json.access_token !== "string") {
      throw new Error("token_exchange_failed: missing access_token in token response");
    }

    this.cachedToken = json.access_token;
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 86399;
    this.tokenExpiresAt = nowSec + expiresIn;
    return this.cachedToken;
  }

  private async graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
    isRetry = false,
  ): Promise<T> {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });

    // On 401, if using client credentials grant, invalidate cached token and retry once
    if (response.status === 401 && !isRetry && !this.staticAccessToken && this.clientId) {
      this.cachedToken = null;
      this.tokenExpiresAt = 0;
      return this.graphql<T>(query, variables, true);
    }

    if (!response.ok) {
      throw new Error(`Shopify Admin GraphQL HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `Shopify Admin GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!json.data) {
      throw new Error("Shopify Admin GraphQL returned empty data");
    }
    return json.data;
  }

  async getShop(): Promise<ShopifyShop> {
    const data = await this.graphql<{ shop: ShopifyShop }>(SHOP_QUERY);
    return data.shop;
  }

  async getOrder(orderGid: string): Promise<ShopifyOrder> {
    const data = await this.graphql<{
      order:
        | (Omit<ShopifyOrder, "lineItems"> & {
            lineItems?: {
              nodes?: Array<{
                title: string;
                quantity: number;
                originalUnitPriceSet?: { shopMoney?: { amount?: string } };
              }>;
            };
          })
        | null;
    }>(ORDER_QUERY, { id: orderGid });
    if (!data.order) {
      throw new Error(`Shopify order not found: ${orderGid}`);
    }
    const nodes = data.order.lineItems?.nodes ?? [];
    return {
      ...data.order,
      lineItems: nodes.map((n) => ({
        title: n.title,
        quantity: n.quantity,
        ...(n.originalUnitPriceSet?.shopMoney?.amount
          ? { unitPriceUsd: Number(n.originalUnitPriceSet.shopMoney.amount).toFixed(2) }
          : {}),
      })),
    };
  }

  async markOrderAsPaid(orderGid: string): Promise<{
    order: Partial<ShopifyOrder> | null;
    userErrors: ShopifyUserError[];
  }> {
    const data = await this.graphql<{
      orderMarkAsPaid: {
        order: Partial<ShopifyOrder> | null;
        userErrors: ShopifyUserError[];
      };
    }>(ORDER_MARK_AS_PAID_MUTATION, {
      input: { id: orderGid },
    });
    return data.orderMarkAsPaid;
  }

  async addOrderTags(
    orderGid: string,
    tags: string[],
  ): Promise<{ userErrors: ShopifyUserError[] }> {
    const data = await this.graphql<{
      tagsAdd: { userErrors: ShopifyUserError[] };
    }>(TAGS_ADD_MUTATION, {
      id: orderGid,
      tags,
    });
    return data.tagsAdd;
  }

  async updateOrderNote(
    orderGid: string,
    note: string,
  ): Promise<{ userErrors: ShopifyUserError[] }> {
    const data = await this.graphql<{
      orderUpdate: { userErrors: ShopifyUserError[] };
    }>(ORDER_UPDATE_MUTATION, {
      input: { id: orderGid, note },
    });
    return data.orderUpdate;
  }
}
