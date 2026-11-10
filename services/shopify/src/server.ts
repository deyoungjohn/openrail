import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ShopifyAdminClient } from "./admin-client.js";
import {
  createHttpCheckoutApiPort,
  createShopifyApp,
  loadShopifyAppEnv,
  type HttpRequest,
  type ShopifyAppEnv,
} from "./app.js";
import { ShopifyPaymentsAppClient } from "./payments-app-client.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

export function createShopifyHttpListener(
  app: ReturnType<typeof createShopifyApp>,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    const path = parsed.pathname;

    const query: Record<string, string | undefined> = {};
    for (const [k, v] of parsed.searchParams.entries()) {
      query[k] = v;
    }

    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) {
        headers[k.toLowerCase()] = v.join(", ");
      } else if (v !== undefined) {
        headers[k.toLowerCase()] = v;
      }
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let bodyTooLarge = false;

    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buf.length;
      if (receivedBytes > MAX_BODY_BYTES) {
        bodyTooLarge = true;
        break;
      }
      chunks.push(buf);
    }

    if (bodyTooLarge) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "payload_too_large", message: "Request body exceeds 1 MB" } }));
      return;
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");

    const httpReq: HttpRequest = {
      method,
      path,
      query,
      headers,
      rawBody,
    };

    try {
      const httpRes = await app.handle(httpReq);
      const contentType =
        Object.entries(httpRes.headers ?? {}).find(
          ([k]) => k.toLowerCase() === "content-type",
        )?.[1] ?? "application/json";

      const resHeaders: Record<string, string> = {
        "Content-Type": contentType,
        ...(httpRes.headers ?? {}),
      };

      res.writeHead(httpRes.status, resHeaders);
      if (httpRes.status === 302 && httpRes.headers?.location) {
        res.end();
      } else if (contentType.includes("text/html") && typeof httpRes.body?.html === "string") {
        res.end(httpRes.body.html);
      } else {
        res.end(JSON.stringify(httpRes.body));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "internal_error",
            message: err instanceof Error ? err.message : "Internal server error",
          },
        }),
      );
    }
  };
}

export function startShopifyServer(
  env: ShopifyAppEnv = loadShopifyAppEnv(),
  portOverride?: number,
) {
  const adminClient = new ShopifyAdminClient({
    shopDomain: env.SHOPIFY_SHOP_DOMAIN,
    clientId: env.SHOPIFY_CLIENT_ID,
    clientSecret: env.SHOPIFY_CLIENT_SECRET,
    accessToken: env.SHOPIFY_ADMIN_ACCESS_TOKEN,
  });

  const paymentsAppClient = new ShopifyPaymentsAppClient({
    shopDomain: env.SHOPIFY_SHOP_DOMAIN,
    adminClient,
  });

  const checkoutApi = createHttpCheckoutApiPort(
    env.OPENRAIL_API_URL,
    env.OPENRAIL_API_KEY,
  );

  const app = createShopifyApp({
    env,
    adminClient,
    paymentsAppClient,
    checkoutApi,
  });

  const port = portOverride ?? parseInt(env.SHOPIFY_PORT ?? "8083", 10);
  const listener = createShopifyHttpListener(app);
  const server = createServer(listener);

  server.listen(port, "127.0.0.1", () => {
    // Log port without exposing secrets (Hard Rule 1)
    console.log(`Openrail Shopify app listening on 127.0.0.1:${port}`);
  });

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return server;
}

// Auto-start when executed directly
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  startShopifyServer();
}
