/**
 * Entrypoint. S1a ships only the mock mode; S1b adds the real implementation.
 * Run with: MOCK=1 pnpm --filter @openrail/api start
 */
import { createMockServer } from "./mock.js";

if (process.env.MOCK !== "1") {
  process.stderr.write("S1B_NOT_IMPLEMENTED: S1a ships the mock API only; run with MOCK=1\n");
  process.exit(1);
}

const port = Number(process.env.API_PORT ?? 8787);
const server = createMockServer();
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`MOCK API listening on http://127.0.0.1:${port}\n`);
});
