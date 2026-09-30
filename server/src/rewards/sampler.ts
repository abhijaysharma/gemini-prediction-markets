import WebSocket from "ws";
import type { Level } from "../types";

// Latest depth20 snapshot for many symbols at once.
//
// No sequencing or rebuilding is needed here: depth20 is the exchange's own
// top-20 snapshot, pushed every 100 ms whether or not the book changed. Each
// frame carries a `symbol` field (not in the docs' example, but present on the
// live feed), which is what lets many symbols share one connection.

export interface DepthSnapshot {
  bids: Level[];
  asks: Level[];
  receivedAt: number;
}

export interface SamplerOptions {
  url: string;
  /** Streams per connection. 300 were verified on one connection; stay well under. */
  perConnection?: number;
  /** Delay between SUBSCRIBE requests; 20 per second was verified safe. */
  subscribeGapMs?: number;
}

export class DepthSampler {
  readonly latest = new Map<string, DepthSnapshot>();
  readonly failed: string[] = [];
  private sockets: WebSocket[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(private opts: SamplerOptions) {}

  /** Resolves once every SUBSCRIBE has been sent. Snapshots keep arriving after that. */
  async start(symbols: string[]): Promise<void> {
    const per = this.opts.perConnection ?? 150;
    const chunks: string[][] = [];
    for (let i = 0; i < symbols.length; i += per) chunks.push(symbols.slice(i, i + per));
    await Promise.all(chunks.map((chunk) => this.open(chunk)));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    for (const ws of this.sockets) ws.terminate();
    this.sockets = [];
  }

  get(symbol: string): DepthSnapshot | undefined {
    return this.latest.get(symbol.toUpperCase());
  }

  private open(symbols: string[]): Promise<void> {
    const gap = this.opts.subscribeGapMs ?? 50;
    const ws = new WebSocket(this.opts.url);
    this.sockets.push(ws);
    const pending = new Map<string, string>();

    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id !== undefined && msg.status !== undefined) {
        if (msg.status !== 200) this.failed.push(pending.get(String(msg.id)) ?? `request ${msg.id}`);
        pending.delete(String(msg.id));
        return;
      }
      if (typeof msg.symbol === "string" && Array.isArray(msg.bids) && Array.isArray(msg.asks)) {
        this.latest.set(msg.symbol.toUpperCase(), { bids: msg.bids, asks: msg.asks, receivedAt: Date.now() });
      }
    });
    ws.on("error", () => {});

    return new Promise((resolve, reject) => {
      ws.once("error", reject);
      ws.once("open", () => {
        symbols.forEach((symbol, i) => {
          this.timers.push(
            setTimeout(() => {
              if (ws.readyState !== WebSocket.OPEN) return;
              const id = `${symbol}#${i}`;
              pending.set(id, symbol);
              ws.send(JSON.stringify({ id, method: "SUBSCRIBE", params: [`${symbol}@depth20@100ms`] }));
              if (i === symbols.length - 1) resolve();
            }, i * gap),
          );
        });
        if (symbols.length === 0) resolve();
      });
    });
  }
}
