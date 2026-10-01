import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../server/src/app";
import { createServer } from "../server/src/http";
import { MockExchange, MOCK_SYMBOLS } from "../server/src/mock/exchange";

let mock: MockExchange;
let app: App;
let server: http.Server;

async function boot(publicDemo: boolean): Promise<string> {
  mock = new MockExchange({ tickMs: 20, seed: 5 });
  const port = await mock.start();
  app = new App({
    wsUrl: `ws://127.0.0.1:${port}`,
    restUrl: `http://127.0.0.1:${port}`,
    symbol: MOCK_SYMBOLS[0].symbol,
    mode: "mock",
    quiet: true,
    publicDemo,
  });
  server = createServer(app, { staticDir: "/nonexistent" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await app.start();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

afterEach(async () => {
  app.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await mock.close();
});

describe("public demo mode", () => {
  it("refuses market switching and allows one fault per cooldown across all visitors", async () => {
    const base = await boot(true);
    expect((await post(`${base}/api/symbol`, { symbol: MOCK_SYMBOLS[2].symbol })).status).toBe(403);

    expect((await post(`${base}/api/faults/corrupt`)).status).toBe(200);
    // A second visitor, a moment later, any fault: still cooling down.
    expect((await post(`${base}/api/faults/disconnect`)).status).toBe(429);

    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.publicDemo).toBe(true);
    expect(state.faultsAvailableAt).toBeGreaterThan(state.serverTime);
  });

  it("doesn't let a mistyped fault path use up the shared cooldown", async () => {
    const base = await boot(true);
    expect((await post(`${base}/api/faults/nope`)).status).toBe(404);
    expect((await post(`${base}/api/faults/corrupt`)).status).toBe(200);
  });

  it("leaves a local run unrestricted", async () => {
    const base = await boot(false);
    expect((await post(`${base}/api/faults/corrupt`)).status).toBe(200);
    expect((await post(`${base}/api/faults/corrupt`)).status).toBe(200);
    expect((await post(`${base}/api/symbol`, { symbol: MOCK_SYMBOLS[2].symbol })).status).toBe(200);
    const state = await (await fetch(`${base}/api/state`)).json();
    expect([state.publicDemo, state.faultsAvailableAt]).toEqual([false, null]);
  });
});
