import { createServer, type Server } from "node:http";

export interface HealthSnapshot {
  status: "ok" | "degraded";
  last_block_height: number | null;
  near_balance_yocto: string | null;
  near_balance_near: number | null;
  min_balance_near: number;
  claims_tracked: number;
  fast_claims: number;
  slow_claims: number;
  last_tick_at: string | null;
  last_error: string | null;
}

export interface HealthServer {
  url: string;
  close(): Promise<void>;
}

/** `GET /health` returns the snapshot; everything else is 404. Bound to localhost. */
export async function startHealthServer(
  port: number,
  snapshot: () => HealthSnapshot,
  host = "127.0.0.1",
): Promise<HealthServer> {
  const server: Server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.split("?")[0] === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify(snapshot())}\n`);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not_found"}\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://${host}:${boundPort}/health`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
