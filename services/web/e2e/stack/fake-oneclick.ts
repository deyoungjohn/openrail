import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeOneClickServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startFakeOneClickServer(port = 0): Promise<FakeOneClickServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

      // Handle quotes
      if (req.method === "POST" && (url.pathname === "/v1/quote" || url.pathname === "/quote")) {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          // ignore
        }
        const amount = String(parsed.amount ?? "1000000");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            quote: {
              depositAddress: "0x53C5D39A5828BaDf817E40f22d75d96D731f8239",
              deadline: new Date(Date.now() + 3600 * 1000).toISOString(),
              amountIn: amount,
              amountOut: amount,
              minAmountIn: amount,
            },
          }),
        );
        return;
      }

      // Handle pay session status or get quote
      if (req.method === "GET" && url.pathname.startsWith("/v1/pay/sessions/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "booked",
            depositAddress: "0x53C5D39A5828BaDf817E40f22d75d96D731f8239",
          }),
        );
        return;
      }

      // Health
      if (url.pathname === "/health" || url.pathname === "/v1/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      const actualPort = addr.port;
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });

    server.on("error", reject);
  });
}
