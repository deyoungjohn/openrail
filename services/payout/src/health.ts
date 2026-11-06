/** Local health endpoint for the payout worker. */
import { createServer, type Server } from "node:http";

export interface PayoutHealthSnapshot {
  ok: boolean;
  status: "ok" | "degraded";
  balance_near: number | null;
  last_tick_at: string | null;
  last_error: string | null;
  last_alert: string | null;
  last_summary: unknown;
  budget?: { day: string; used: number; daily_budget: number; remaining: number };
}

export async function startPayoutHealthServer(
  port: number,
  snapshot: () => PayoutHealthSnapshot,
  bind = "127.0.0.1",
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const body = snapshot();
      response.writeHead(body.ok ? 200 : 503, { "content-type": "application/json" });
      response.end(`${JSON.stringify(body)}\n`);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":{"code":"not_found"}}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://${bind}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
