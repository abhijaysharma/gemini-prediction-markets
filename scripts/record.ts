// Records raw frames from the public WebSocket to an NDJSON file.
// Useful for building regression fixtures you can replay deterministically
// without a live connection.
//
// Usage: npm run record -- <SYMBOL> [minutes]

import WebSocket from "ws";
import { createWriteStream, mkdirSync } from "node:fs";

const symbol = process.argv[2];
const minutes = Number(process.argv[3] ?? 10);

if (!symbol) {
  console.error("usage: npm run record -- <SYMBOL> [minutes]");
  process.exit(1);
}

mkdirSync("recordings", { recursive: true });
const file = `recordings/${symbol}-${Date.now()}.ndjson`;
const out = createWriteStream(file);

// snapshot=-1: the first depthUpdate frame is the full book, later frames are deltas.
const ws = new WebSocket("wss://ws.gemini.com?snapshot=-1");

const stats = { frames: 0, depth: 0, trades: 0, other: 0, gaps: 0 };
let lastU: number | null = null;

ws.on("open", () => {
  console.log(`Connected. Recording ${symbol} for ${minutes} min -> ${file}`);
  ws.send(
    JSON.stringify({
      id: "sub-1",
      method: "SUBSCRIBE",
      params: [`${symbol}@depth@100ms`, `${symbol}@trade`],
    }),
  );
});

ws.on("message", (data) => {
  const raw = data.toString();
  // Wall-clock receive time in ms. Good enough for recording; we handle
  // clock offset properly when we measure latency later.
  out.write(JSON.stringify({ recvMs: Date.now(), raw }) + "\n");
  stats.frames++;

  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    stats.other++;
    return;
  }

  // Request/response frames (e.g. the SUBSCRIBE ack) carry an `id` and `status`.
  if (msg.id !== undefined && msg.status !== undefined) {
    console.log(`Response to ${msg.id}: status ${msg.status}`, msg.error ?? "");
    return;
  }

  if (msg.e === "depthUpdate") {
    stats.depth++;
    // Continuity rule from the docs: if U skips ahead of the last applied u,
    // we missed updates and the local book can't be trusted.
    if (lastU !== null && msg.U > lastU + 1) {
      stats.gaps++;
      console.warn(`GAP: last u=${lastU}, next U=${msg.U} (missed ${msg.U - lastU - 1})`);
    }
    lastU = msg.u;
  } else if (msg.t !== undefined && msg.p !== undefined) {
    // Trade frames have no `e` field; identify them by shape.
    stats.trades++;
  } else {
    stats.other++;
  }
});

ws.on("close", (code, reason) => {
  console.log(`Closed: ${code} ${reason.toString()}`);
  out.end();
  printStats();
  process.exit(0);
});

ws.on("error", (err) => console.error("WebSocket error:", err.message));

const statsTimer = setInterval(printStats, 5000);

setTimeout(() => {
  clearInterval(statsTimer);
  ws.close(1000, "recording complete");
}, minutes * 60_000);

function printStats() {
  console.log(
    `frames=${stats.frames} depth=${stats.depth} trades=${stats.trades} other=${stats.other} gaps=${stats.gaps} lastU=${lastU}`,
  );
}
