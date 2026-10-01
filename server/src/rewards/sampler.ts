import WebSocket from "ws";
import type { Level } from "../types";

// Latest depth20 snapshot for many symbols at once, and optionally every
// trade on them.
//
// No sequencing or rebuilding is needed here: depth20 is the exchange's own
// top-20 snapshot. Each frame carries a `symbol` field (not in the docs'
// example, but present on the live feed), which is what lets many symbols
// share one connection.

export interface DepthSnapshot {
  bids: Level[];
  asks: Level[];
  receivedAt: number;
}

export interface SampledTrade {
  symbol: string;
  price: number;
  qty: number;
  /** The taker bought, so a resting sell order was filled. */
  takerBuy: boolean;
  /** Local receive time, the same clock the depth snapshots are timed on. */
  at: number;
}

export interface SamplerOptions {
  url: string;
  /**
   * `depth20` arrives once a second, `depth20@100ms` ten times a second.
   * Rewards are scored once a minute, so once a second is plenty.
   */
  stream?: "depth20" | "depth20@100ms";
  /** Also subscribe to each symbol's @trade stream and report every trade. */
  onTrade?: (trade: SampledTrade) => void;
  /** Symbols per connection. 300 streams were verified on one connection; stay well under. */
  perConnection?: number;
  /** Delay between requests; 20 a second was verified safe. */
  requestGapMs?: number;
}

interface Conn {
  ws: WebSocket | null;
  symbols: Set<string>;
  queue: object[];
  attempt: number;
}

/** Holds the latest depth20 for a changing set of symbols, reconnecting as needed. */
export class DepthSampler {
  readonly failed = new Set<string>();
  private latest = new Map<string, DepthSnapshot>();
  private conns: Conn[] = [];
  private stopped = false;
  private reqId = 0;
  private timers = new Set<NodeJS.Timeout>();

  constructor(private opts: SamplerOptions) {}

  get symbolCount(): number {
    return this.conns.reduce((n, c) => n + c.symbols.size, 0);
  }

  get(symbol: string): DepthSnapshot | undefined {
    return this.latest.get(symbol.toUpperCase());
  }

  /** Subscribe to whatever is new in `wanted` and unsubscribe from whatever left it. */
  setSymbols(wanted: Iterable<string>): void {
    const want = new Set([...wanted].map((s) => s.toUpperCase()));
    for (const c of this.conns) {
      for (const s of [...c.symbols]) {
        if (want.has(s)) continue;
        c.symbols.delete(s);
        this.latest.delete(s);
        this.enqueue(c, "UNSUBSCRIBE", s);
      }
    }
    const held = new Set(this.conns.flatMap((c) => [...c.symbols]));
    for (const s of want) {
      if (held.has(s)) continue;
      const c = this.connWithRoom();
      c.symbols.add(s);
      this.enqueue(c, "SUBSCRIBE", s);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const c of this.conns) c.ws?.terminate();
  }

  private connWithRoom(): Conn {
    // Two streams per symbol when trades are on: keep each connection at 200 streams or fewer.
    const per = this.opts.perConnection ?? (this.opts.onTrade ? 100 : 150);
    const open = this.conns.find((c) => c.symbols.size < per);
    if (open) return open;
    const c: Conn = { ws: null, symbols: new Set(), queue: [], attempt: 0 };
    this.conns.push(c);
    this.connect(c);
    return c;
  }

  private streams(symbol: string): string[] {
    const depth = `${symbol}@${this.opts.stream ?? "depth20"}`;
    return this.opts.onTrade ? [depth, `${symbol}@trade`] : [depth];
  }

  private enqueue(c: Conn, method: string, symbol: string): void {
    const wasEmpty = c.queue.length === 0;
    for (const stream of this.streams(symbol)) {
      const id = `${method === "SUBSCRIBE" ? "s" : "u"}:${symbol}:${++this.reqId}`;
      c.queue.push({ id, method, params: [stream] });
    }
    if (wasEmpty && c.ws?.readyState === WebSocket.OPEN) this.drain(c);
  }

  /** Send queued requests one at a time, paced, so a burst of new symbols can't trip a rate limit. */
  private drain(c: Conn): void {
    const next = c.queue.shift();
    if (!next || c.ws?.readyState !== WebSocket.OPEN) return;
    c.ws.send(JSON.stringify(next));
    if (c.queue.length) this.later(() => this.drain(c), this.opts.requestGapMs ?? 50);
  }

  private connect(c: Conn): void {
    const ws = new WebSocket(this.opts.url);
    c.ws = ws;
    ws.on("open", () => {
      c.attempt = 0;
      // A fresh connection holds nothing: resubscribe everything this one owns.
      c.queue = [...c.symbols].flatMap((s) =>
        this.streams(s).map((stream) => ({ id: `s:${s}:${++this.reqId}`, method: "SUBSCRIBE", params: [stream] })),
      );
      this.drain(c);
    });
    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id !== undefined && msg.status !== undefined) {
        const [kind, symbol] = String(msg.id).split(":");
        if (kind === "s" && symbol) {
          if (msg.status === 200) this.failed.delete(symbol);
          else this.failed.add(symbol);
        }
        return;
      }
      if (typeof msg.symbol === "string" && Array.isArray(msg.bids) && Array.isArray(msg.asks)) {
        const symbol = msg.symbol.toUpperCase();
        // Ignore a frame that was already in flight when we unsubscribed.
        if (c.symbols.has(symbol)) this.latest.set(symbol, { bids: msg.bids, asks: msg.asks, receivedAt: Date.now() });
        return;
      }
      // Trade frames carry no `e`: {E, s, t, p, q, m}, where m means the buyer was the maker.
      if (this.opts.onTrade && typeof msg.s === "string" && msg.t !== undefined && msg.p !== undefined) {
        const symbol = msg.s.toUpperCase();
        if (!c.symbols.has(symbol)) return;
        this.opts.onTrade({ symbol, price: Number(msg.p), qty: Number(msg.q), takerBuy: !msg.m, at: Date.now() });
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (c.ws !== ws || this.stopped) return;
      for (const s of c.symbols) this.latest.delete(s);
      const delay = Math.min(30_000, 500 * 2 ** c.attempt++);
      this.later(() => this.connect(c), delay);
    });
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(t);
  }
}
