import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { Level } from "../types";

// A local stand-in for Gemini's public market data, speaking the same wire
// protocol the docs describe: snapshot-on-subscribe, sequenced depthUpdate
// deltas (U..u), @depth20 reference snapshots, trades, and ping.
//
// Used by the test suite and by `npm run dev:mock` for offline demos.
// All data here is synthetic.

interface Market {
  symbol: string;
  title: string;
  contract: string;
  bids: Map<number, number>; // price in cents -> quantity
  asks: Map<number, number>;
  mid: number;
  lastId: number;
  tradeId: number;
}

interface Client {
  ws: WebSocket;
  streams: Set<string>;
  snapshot: number;
}

export interface MockExchangeOptions {
  port?: number;
  tickMs?: number;
  seed?: number;
}

export const MOCK_SYMBOLS = [
  { symbol: "GEMI-BTC05M2610011000-UP", title: "Bitcoin up or down in 5 minutes (mock)", contract: "Up" },
  { symbol: "GEMI-BTC05M2610011000-DOWN", title: "Bitcoin up or down in 5 minutes (mock)", contract: "Down" },
  { symbol: "GEMI-ETH15M2610011015-UP", title: "Ether up or down in 15 minutes (mock)", contract: "Up" },
];

export class MockExchange {
  private server: http.Server;
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private markets = new Map<string, Market>();
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private rand: () => number;
  private readonly tickMs: number;
  port = 0;

  constructor(private opts: MockExchangeOptions = {}) {
    this.tickMs = opts.tickMs ?? 100;
    this.rand = mulberry32(opts.seed ?? 42);
    for (const m of MOCK_SYMBOLS) this.markets.set(m.symbol.toUpperCase(), this.seedMarket(m));

    this.server = http.createServer((req, res) => this.onHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(this.opts.port ?? 0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    return this.port;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients) c.ws.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ------------------------------------------------------------ test hooks

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Burn update IDs without sending them, so every client sees a sequence gap. */
  injectGap(symbol: string, count = 5): void {
    const m = this.market(symbol);
    if (m) m.lastId += count;
  }

  disconnectAll(): void {
    for (const c of this.clients) c.ws.terminate();
  }

  lastUpdateId(symbol: string): number | null {
    return this.market(symbol)?.lastId ?? null;
  }

  /** The true book, formatted the way the client should hold it. */
  book(symbol: string): { bids: Level[]; asks: Level[] } {
    const m = this.market(symbol)!;
    return { bids: sortLevels(m.bids, "desc"), asks: sortLevels(m.asks, "asc") };
  }

  // ------------------------------------------------------------------ HTTP

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === "GET" && req.url?.startsWith("/v1/prediction-markets/events")) {
      const byTitle = new Map<string, { instrumentSymbol: string; name: string; status: string }[]>();
      for (const m of this.markets.values()) {
        const list = byTitle.get(m.title) ?? [];
        list.push({ instrumentSymbol: m.symbol, name: m.contract, status: "Active" });
        byTitle.set(m.title, list);
      }
      const data = [...byTitle].map(([title, contracts]) => ({ title, contracts }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
      return;
    }
    res.writeHead(404).end();
  }

  // ------------------------------------------------------------- WebSocket

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://mock");
    const client: Client = { ws, streams: new Set(), snapshot: Number(url.searchParams.get("snapshot") ?? 0) };
    this.clients.add(client);

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const id = msg.id;
      if (msg.method === "SUBSCRIBE" && Array.isArray(msg.params)) {
        for (const stream of msg.params as string[]) {
          if (!this.isValidStream(stream)) {
            send(ws, { id, status: 400, error: { code: -1013, msg: `Invalid stream ${stream}` } });
            return;
          }
        }
        for (const stream of msg.params as string[]) {
          client.streams.add(stream.toLowerCase());
          send(ws, { id, status: 200 });
          const [sym, kind] = splitStream(stream);
          if (kind === "depth@100ms" && client.snapshot !== 0) {
            const m = this.market(sym)!;
            send(ws, {
              e: "depthUpdate",
              E: nowNs(),
              s: m.symbol,
              U: m.lastId,
              u: m.lastId,
              b: sortLevels(m.bids, "desc"),
              a: sortLevels(m.asks, "asc"),
            });
          }
        }
        return;
      }
      if (msg.method === "ping" || msg.method === "time") {
        send(ws, { id, status: 200, result: { serverTime: Date.now() } });
        return;
      }
      send(ws, { id, status: 400, error: { code: -1020, msg: "Unsupported operation" } });
    });

    ws.on("close", () => this.clients.delete(client));
    ws.on("error", () => this.clients.delete(client));
  }

  private isValidStream(stream: string): boolean {
    if (stream === "contractStatus") return true;
    const [sym, kind] = splitStream(stream);
    return !!this.market(sym) && ["depth@100ms", "depth20@100ms", "trade"].includes(kind);
  }

  // ------------------------------------------------------------ simulation

  private tick(): void {
    if (this.paused) return;
    for (const m of this.markets.values()) {
      const changes = this.mutate(m);
      if (changes.bids.size === 0 && changes.asks.size === 0) continue;

      const U = m.lastId + 1;
      m.lastId += changes.count;
      const E = nowNs();
      const key = m.symbol.toLowerCase();

      this.broadcast(`${key}@depth@100ms`, {
        e: "depthUpdate",
        E,
        s: m.symbol,
        U,
        u: m.lastId,
        b: [...changes.bids].map(([p, q]) => [cents(p), String(q)]),
        a: [...changes.asks].map(([p, q]) => [cents(p), String(q)]),
      });
      this.broadcast(`${key}@depth20@100ms`, {
        lastUpdateId: m.lastId,
        bids: sortLevels(m.bids, "desc").slice(0, 20),
        asks: sortLevels(m.asks, "asc").slice(0, 20),
      });

      if (this.rand() < 0.35) {
        const buy = this.rand() < 0.5;
        const price = buy ? minKey(m.asks) : maxKey(m.bids);
        if (price !== null) {
          this.broadcast(`${key}@trade`, {
            E,
            s: m.symbol,
            t: ++m.tradeId,
            p: cents(price),
            q: String(1 + Math.floor(this.rand() * 400)),
            m: !buy,
          });
        }
      }
    }
  }

  /** Random walk around a mid price, never letting the book cross. */
  private mutate(m: Market) {
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    let count = 0;
    const set = (side: "bid" | "ask", price: number, qty: number) => {
      const book = side === "bid" ? m.bids : m.asks;
      const changes = side === "bid" ? bids : asks;
      if (qty === 0) book.delete(price);
      else book.set(price, qty);
      changes.set(price, qty);
      count++;
    };

    if (this.rand() < 0.12) {
      const dir = this.rand() < 0.5 ? -1 : 1;
      const next = Math.min(94, Math.max(6, m.mid + dir));
      if (next !== m.mid) {
        m.mid = next;
        for (const p of [...m.asks.keys()]) if (p <= m.mid) set("ask", p, 0);
        for (const p of [...m.bids.keys()]) if (p >= m.mid) set("bid", p, 0);
        set(dir > 0 ? "bid" : "ask", dir > 0 ? m.mid - 1 : m.mid + 1, this.qty());
      }
    }

    const n = 1 + Math.floor(this.rand() * 4);
    for (let i = 0; i < n; i++) {
      const side = this.rand() < 0.5 ? "bid" : "ask";
      const offset = 1 + Math.floor(this.rand() * 14);
      const price = side === "bid" ? m.mid - offset : m.mid + offset;
      if (price < 1 || price > 99) continue;
      const remove = this.rand() < 0.2;
      set(side, price, remove ? 0 : this.qty());
    }
    return { bids, asks, count };
  }

  private qty(): number {
    return 50 * (1 + Math.floor(this.rand() * 60));
  }

  private seedMarket(info: (typeof MOCK_SYMBOLS)[number]): Market {
    const mid = 30 + Math.floor(this.rand() * 40);
    const m: Market = {
      ...info,
      bids: new Map(),
      asks: new Map(),
      mid,
      lastId: 1_000_000 + Math.floor(this.rand() * 1_000_000),
      tradeId: 1_000_000,
    };
    for (let i = 1; i <= 14; i++) {
      if (mid - i >= 1 && this.rand() < 0.85) m.bids.set(mid - i, this.qty());
      if (mid + i <= 99 && this.rand() < 0.85) m.asks.set(mid + i, this.qty());
    }
    return m;
  }

  private market(symbol: string): Market | undefined {
    return this.markets.get(symbol.toUpperCase());
  }

  private broadcast(stream: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const c of this.clients) {
      if (c.streams.has(stream) && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }
}

function splitStream(stream: string): [string, string] {
  const i = stream.indexOf("@");
  return i === -1 ? [stream, ""] : [stream.slice(0, i), stream.slice(i + 1)];
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function cents(p: number): string {
  return (p / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function sortLevels(side: Map<number, number>, dir: "asc" | "desc"): Level[] {
  return [...side]
    .sort((a, b) => (dir === "asc" ? a[0] - b[0] : b[0] - a[0]))
    .map(([p, q]) => [cents(p), String(q)] as Level);
}

function minKey(m: Map<number, number>): number | null {
  let v: number | null = null;
  for (const k of m.keys()) if (v === null || k < v) v = k;
  return v;
}

function maxKey(m: Map<number, number>): number | null {
  let v: number | null = null;
  for (const k of m.keys()) if (v === null || k > v) v = k;
  return v;
}

function nowNs(): number {
  return Date.now() * 1e6;
}

/** Small seeded PRNG so test runs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
