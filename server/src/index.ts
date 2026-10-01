import path from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "./app";
import { createServer } from "./http";
import { MockExchange } from "./mock/exchange";

// Entry point.
//   npm run dev        live Gemini data (public streams, no API key needed)
//   npm run dev:mock   local mock exchange, fully offline
//
// Environment:
//   PORT            dashboard server port (default 8787)
//   SYMBOL          stream one fixed symbol instead of auto-discovering
//   GEMINI_WS_URL   default wss://ws.gemini.com
//   GEMINI_REST_URL default https://api.gemini.com
//   PUBLIC_DEMO=1   shared public deployment: no market switching, rate-limited faults
//   FILLS_FILE      where the rewards tab saves fills (default data/fills.ndjson,
//                   or data/fills-mock.ndjson with --mock so synthetic fills never mix with real ones)

const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(here, "../../web/dist");
const port = Number(process.env.PORT ?? 8787);
const useMock = process.argv.includes("--mock") || process.env.MOCK === "1";

async function main() {
  let wsUrl = process.env.GEMINI_WS_URL ?? "wss://ws.gemini.com";
  let restUrl = process.env.GEMINI_REST_URL ?? "https://api.gemini.com";
  let mock: MockExchange | null = null;

  if (useMock) {
    mock = new MockExchange({ port: Number(process.env.MOCK_PORT ?? 8788) });
    const mockPort = await mock.start();
    wsUrl = `ws://127.0.0.1:${mockPort}`;
    restUrl = `http://127.0.0.1:${mockPort}`;
    console.log(`Mock exchange running on :${mockPort} (synthetic data)`);
  }

  const app = new App({
    wsUrl,
    restUrl,
    symbol: process.env.SYMBOL || undefined,
    mode: useMock ? "mock" : "live",
    fillsFile: process.env.FILLS_FILE ?? path.resolve(here, `../../data/${useMock ? "fills-mock" : "fills"}.ndjson`),
    publicDemo: process.env.PUBLIC_DEMO === "1",
  });
  // A shared deployment pushes 4 updates a second instead of 10: each open tab
  // otherwise costs ~84 KB/s of metered outbound bandwidth.
  const server = createServer(app, { staticDir, broadcastMs: app.publicDemo ? 250 : 100 });
  server.listen(port, () => {
    console.log(`Dashboard server on http://localhost:${port}`);
    console.log(`Data source: ${useMock ? "mock exchange" : wsUrl}`);
  });
  await app.start();

  const shutdown = async () => {
    app.stop();
    server.close();
    await mock?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
