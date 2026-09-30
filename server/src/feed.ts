import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { normDecimal } from "./decimal";
import { IntegrityChecker, type ReferenceSnapshot } from "./integrity";
import { RateMeter, Samples } from "./metrics";
import { OrderBook } from "./orderbook";
import type { Counters, FeedState, Level, LogEntry, Trade } from "./types";

export interface FeedOptions {
  /** Base WebSocket URL, e.g. wss://ws.gemini.com */
  url: string;
  pingMs?: number;
  staleMs?: number;
  quiet?: boolean;
}

const MAX_TRADES = 50;
const MAX_LOG = 200;
const MAX_RECOVERIES = 20;

/**
 * Maintains a correct local order book for one symbol over Gemini's public
 * WebSocket, and recovers on its own from anything that breaks it.
 *
 * Failure handling:
 *  - Sequence gap (missed updates)   -> discard book, resync on a fresh connection
 *  - Local book != exchange snapshot -> resync after two consecutive mismatches
 *  - Socket closed / network drop    -> reconnect with exponential backoff + jitter
 *  - Silent dead connection          -> heartbeat pings; resync if no data for staleMs
 *
 * Resync uses a fresh connection rather than unsubscribe/resubscribe. That
 * costs a TCP+TLS handshake, but it guarantees no frames from the old
 * subscription can arrive after we've reset, so the first depth frame on the
 * new connection is unambiguously the snapshot.
 */
export class FeedClient extends EventEmitter {
  readonly book = new OrderBook();
  readonly integrity = new IntegrityChecker();
  readonly rate = new RateMeter();
  readonly lag = new Samples(2000);

  symbol: string | null = null;
  state: FeedState = "idle";
  trades: Trade[] = [];
  counters: Counters = zeroCounters();
  recoveries: number[] = [];
  recoveryStartedAt: number | null = null;
  recoveryReason: string | null = null;
  connectedSince: number | null = null;
  log: LogEntry[] = [];

  private readonly url: string;
  private readonly pingMs: number;
  private readonly staleMs: number;
  private readonly quiet: boolean;

  private ws: WebSocket | null = null;
  private connId = 0;
  private attempt = 0;
  private reqId = 0;
  private pendingRequests = new Map<string, string>();
  private dropBudget = 0;
  private lastMessageAt = 0;
  private consecutiveMismatches = 0;
  private recentResyncs: number[] = [];
  private wasCrossed = false;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private intervals: NodeJS.Timeout[] = [];

  constructor(opts: FeedOptions) {
    super();
    this.url = opts.url;
    this.pingMs = opts.pingMs ?? 15_000;
    this.staleMs = opts.staleMs ?? 30_000;
    this.quiet = opts.quiet ?? false;
  }

  // ---------------------------------------------------------------- control

  start(symbol: string): void {
    this.symbol = symbol;
    if (this.running) return;
    this.running = true;
    this.intervals.push(setInterval(() => this.heartbeat(), this.pingMs));
    this.intervals.push(setInterval(() => this.watchdog(), 1000));
    this.connect();
  }

  stop(): void {
    this.running = false;
    for (const t of this.intervals) clearInterval(t);
    this.intervals = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown();
    this.state = "idle";
  }

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return;
    this.info(`Switching to ${symbol}`);
    this.symbol = symbol;
    this.trades = [];
    this.lag.clear();
    this.integrity.resetAll();
    this.consecutiveMismatches = 0;
    this.recoveryStartedAt = null;
    this.recoveryReason = null;
    this.emit("symbol", symbol);
    if (!this.running) return;
    this.teardown();
    this.attempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connect();
  }

  /** Fault injection: silently discard the next n book updates. */
  dropNext(n: number): void {
    this.dropBudget += n;
    this.info(`Fault injected: dropping the next ${n} book updates`);
  }

  /** Fault injection: corrupt the local book without touching sequence numbers. */
  corruptBook(): void {
    const what = this.book.corruptBestLevel();
    if (what) this.info(`Fault injected: local book corrupted (${what})`);
  }

  /** Fault injection: kill the socket as if the network dropped. */
  killConnection(): void {
    if (!this.ws) return;
    this.info("Fault injected: connection cut");
    this.ws.terminate();
  }

  info(msg: string): void {
    this.pushLog("info", msg);
  }

  warn(msg: string): void {
    this.pushLog("warn", msg);
  }

  // ------------------------------------------------------------- connection

  private connect(): void {
    this.reconnectTimer = null;
    if (!this.symbol) return;
    const id = ++this.connId;
    this.state = "connecting";
    this.book.reset();
    this.integrity.resetPending();

    const url = new URL(this.url);
    // snapshot=-1: the first depth frame after subscribing is the full book.
    url.searchParams.set("snapshot", "-1");
    const ws = new WebSocket(url.toString());
    this.ws = ws;

    ws.on("open", () => {
      if (id !== this.connId) return;
      this.state = "syncing";
      this.connectedSince = Date.now();
      this.lastMessageAt = Date.now();
      // One SUBSCRIBE per stream, so a stream this symbol doesn't support
      // (e.g. contractStatus on a spot pair) can't take the others down with it.
      for (const stream of this.streams()) {
        this.request("SUBSCRIBE", [stream], `subscribe ${stream}`);
      }
    });

    ws.on("message", (data) => {
      if (id !== this.connId) return;
      this.onRaw(data.toString(), Date.now());
    });

    ws.on("close", (code) => {
      if (id !== this.connId) return;
      this.ws = null;
      this.dropBudget = 0;
      this.connectedSince = null;
      if (!this.running) return;
      this.warn(`Connection closed (code ${code})`);
      this.scheduleReconnect("connection lost");
    });

    ws.on("error", (err) => {
      if (id !== this.connId) return;
      this.warn(`WebSocket error: ${err.message}`);
      // A 'close' event always follows, which schedules the reconnect.
    });
  }

  private streams(): string[] {
    const s = this.symbol!;
    return [`${s}@depth@100ms`, `${s}@depth20@100ms`, `${s}@trade`, "contractStatus"];
  }

  /** Close the current socket and ignore anything it emits from now on. */
  private teardown(): void {
    const ws = this.ws;
    this.connId++;
    this.dropBudget = 0;
    this.ws = null;
    this.connectedSince = null;
    this.pendingRequests.clear();
    if (ws) {
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.recoveryStartedAt === null) this.integrity.mark("resync");
    this.beginRecovery(reason);
    this.state = "reconnecting";
    this.counters.reconnects++;
    const base = Math.min(10_000, 250 * 2 ** this.attempt);
    // "Equal jitter": half fixed, half random, so many clients don't reconnect in lockstep.
    const delay = Math.round(base / 2 + (Math.random() * base) / 2);
    this.attempt++;
    this.info(`Reconnecting in ${delay} ms (attempt ${this.attempt})`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private resync(reason: string): void {
    const now = Date.now();
    this.counters.resyncs++;
    this.integrity.mark("resync");
    this.beginRecovery(reason);
    this.warn(`Resyncing: ${reason}`);

    this.recentResyncs = this.recentResyncs.filter((t) => now - t < 10_000);
    this.recentResyncs.push(now);
    // Guard against a resync loop hammering the exchange.
    const delay = this.recentResyncs.length >= 3 ? 2000 : 0;
    if (delay) this.warn("Three resyncs in 10 seconds, backing off for 2 seconds");

    this.teardown();
    this.state = "reconnecting";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private beginRecovery(reason: string): void {
    if (this.recoveryStartedAt === null) {
      this.recoveryStartedAt = Date.now();
      this.recoveryReason = reason;
    }
  }

  private markLive(): void {
    this.state = "live";
    this.attempt = 0;
    if (this.recoveryStartedAt !== null) {
      const ms = Date.now() - this.recoveryStartedAt;
      this.recoveries.push(ms);
      if (this.recoveries.length > MAX_RECOVERIES) this.recoveries.shift();
      this.info(`Book rebuilt and live again after ${ms} ms`);
      this.recoveryStartedAt = null;
      this.recoveryReason = null;
    }
    this.emit("live");
  }

  private heartbeat(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.request("ping", undefined, "ping");
  }

  private watchdog(): void {
    if (!this.ws || (this.state !== "live" && this.state !== "syncing")) return;
    if (Date.now() - this.lastMessageAt > this.staleMs) {
      this.resync(`no data for ${Math.round(this.staleMs / 1000)} seconds`);
    }
  }

  private request(method: string, params: unknown, description: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const id = String(++this.reqId);
    this.pendingRequests.set(id, description);
    const msg: Record<string, unknown> = { id, method };
    if (params !== undefined) msg.params = params;
    this.ws.send(JSON.stringify(msg));
  }

  // --------------------------------------------------------------- messages

  private onRaw(raw: string, recvMs: number): void {
    this.lastMessageAt = recvMs;
    this.counters.messages++;
    this.rate.hit(recvMs);

    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.warn(`Unparseable frame: ${raw.slice(0, 80)}`);
      return;
    }
    // Defensive: unwrap a combined-stream envelope if one ever appears.
    if (msg && typeof msg === "object" && "stream" in msg && "data" in msg) msg = msg.data;
    if (!msg || typeof msg !== "object") return;

    // Responses to our own requests carry id + status.
    if (msg.id !== undefined && msg.status !== undefined) {
      const what = this.pendingRequests.get(String(msg.id)) ?? `request ${msg.id}`;
      this.pendingRequests.delete(String(msg.id));
      if (msg.status !== 200) {
        this.warn(`${what} failed: ${msg.status} ${msg.error?.msg ?? ""}`.trim());
      }
      return;
    }

    // Events that carry an `e` field.
    if (msg.e === "depthUpdate") return this.onDepth(msg, recvMs);
    if (msg.e === "contractStatus") {
      this.emit("contractStatus", msg);
      return;
    }
    if (typeof msg.e === "string") return; // unknown event types are forward-compatible additions

    // Partial depth and trade frames have no `e`; identify them by shape.
    if (typeof msg.lastUpdateId === "number" && Array.isArray(msg.bids)) {
      return this.onReference(msg, recvMs);
    }
    if (msg.t !== undefined && msg.p !== undefined && msg.q !== undefined) {
      return this.onTrade(msg, recvMs);
    }
  }

  private onDepth(msg: any, recvMs: number): void {
    this.counters.depthUpdates++;

    const bids: Level[] = Array.isArray(msg.b) ? msg.b : [];
    const asks: Level[] = Array.isArray(msg.a) ? msg.a : [];

    if (!this.book.isReady) {
      this.book.applySnapshot(bids, asks, msg.u);
      this.info(
        `Snapshot applied: ${this.book.bidCount} bids and ${this.book.askCount} asks at update ${msg.u}`,
      );
      this.markLive();
      return;
    }

    // Fault injection happens after the snapshot, so it simulates packet loss mid-stream.
    if (this.dropBudget > 0) {
      this.dropBudget--;
      this.counters.droppedByChaos++;
      return;
    }

    // Sample lag on deltas only. The snapshot's E is when the book last
    // changed, which on a quiet market can be minutes old.
    // E is nanoseconds since epoch. It exceeds 2^53, so JSON.parse loses the
    // last few digits, but that's sub-microsecond and irrelevant at ms scale.
    if (typeof msg.E === "number") this.lag.add(recvMs - msg.E / 1e6);

    const prev = this.book.lastUpdateId!;
    const result = this.book.applyDelta(msg.U, msg.u, bids, asks);
    if (result === "gap") {
      this.counters.gaps++;
      const missed = msg.U - prev - 1;
      this.resync(`missed ${missed} update${missed === 1 ? "" : "s"} (${prev + 1} to ${msg.U - 1})`);
      return;
    }
    if (result === "stale") {
      this.counters.staleFrames++;
      return;
    }

    this.handleIntegrity(this.integrity.onBookAdvanced(this.book, recvMs));

    const crossed = this.book.isCrossed();
    if (crossed && !this.wasCrossed) {
      this.counters.crossedBooks++;
      this.warn(`Book crossed: best bid ${this.book.bestBid()} >= best ask ${this.book.bestAsk()}`);
    }
    this.wasCrossed = crossed;
  }

  private onReference(msg: any, recvMs: number): void {
    const ref: ReferenceSnapshot = {
      lastUpdateId: msg.lastUpdateId,
      bids: msg.bids,
      asks: Array.isArray(msg.asks) ? msg.asks : [],
    };
    this.handleIntegrity(this.integrity.onReference(ref, this.book, recvMs));
  }

  private handleIntegrity(result: "match" | "mismatch" | null): void {
    if (result === "match") {
      this.consecutiveMismatches = 0;
    } else if (result === "mismatch") {
      this.consecutiveMismatches++;
      this.warn(`Integrity check failed at ${this.integrity.stats.lastMismatch}`);
      // Two in a row rules out a one-off race; the local book is wrong.
      if (this.consecutiveMismatches >= 2) {
        this.consecutiveMismatches = 0;
        this.resync("local book no longer matches the exchange");
      }
    }
  }

  private onTrade(msg: any, recvMs: number): void {
    this.counters.trades++;
    this.trades.unshift({
      id: Number(msg.t),
      price: normDecimal(msg.p),
      qty: normDecimal(msg.q),
      // m = "buyer is maker", so the taker was selling.
      side: msg.m ? "sell" : "buy",
      timeMs: typeof msg.E === "number" ? Math.round(msg.E / 1e6) : recvMs,
    });
    if (this.trades.length > MAX_TRADES) this.trades.length = MAX_TRADES;
  }

  private pushLog(level: LogEntry["level"], msg: string): void {
    this.log.push({ t: Date.now(), level, msg });
    if (this.log.length > MAX_LOG) this.log.shift();
    if (!this.quiet) {
      const line = `[feed] ${msg}`;
      if (level === "info") console.log(line);
      else console.warn(line);
    }
  }
}

function zeroCounters(): Counters {
  return {
    messages: 0,
    depthUpdates: 0,
    trades: 0,
    gaps: 0,
    resyncs: 0,
    reconnects: 0,
    staleFrames: 0,
    crossedBooks: 0,
    droppedByChaos: 0,
  };
}
