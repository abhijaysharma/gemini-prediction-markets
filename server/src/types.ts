// Shared types between the server and the dashboard.

/** One price level: [price, quantity], both as decimal strings. */
export type Level = [string, string];

export type FeedState = "idle" | "connecting" | "syncing" | "live" | "reconnecting";

export interface Trade {
  id: number;
  price: string;
  qty: string;
  /** Side of the taker (the aggressor). */
  side: "buy" | "sell";
  timeMs: number;
}

export interface LogEntry {
  t: number;
  level: "info" | "warn" | "error";
  msg: string;
}

export type CheckMark = "match" | "mismatch" | "resync";

export interface IntegrityStats {
  matched: number;
  mismatched: number;
  /** Reference snapshots we couldn't line up with an exact local update ID. */
  skipped: number;
  last: "match" | "mismatch" | null;
  lastCheckedAt: number | null;
  lastMismatch: string | null;
  /** Recent outcomes, oldest first, for the dashboard's integrity strip. */
  history: CheckMark[];
}

export interface Counters {
  messages: number;
  depthUpdates: number;
  trades: number;
  gaps: number;
  resyncs: number;
  reconnects: number;
  staleFrames: number;
  crossedBooks: number;
  droppedByChaos: number;
}

export interface MarketInfo {
  symbol: string;
  title: string | null;
  status: string | null;
}

export interface StatePayload {
  mode: "live" | "mock";
  symbol: string | null;
  feedState: FeedState;
  connectedSince: number | null;
  book: {
    bids: Level[];
    asks: Level[];
    bestBid: string | null;
    bestAsk: string | null;
    spread: number | null;
    mid: number | null;
    lastUpdateId: number | null;
    bidLevels: number;
    askLevels: number;
  };
  mids: { t: number; mid: number }[];
  trades: Trade[];
  counters: Counters;
  metrics: {
    msgPerSec: number;
    lagP50: number | null;
    lagP99: number | null;
    jitterP99: number | null;
    /** How many deltas the lag figures are based on. */
    lagSamples: number;
  };
  recovery: {
    lastMs: number | null;
    recentMs: number[];
    inProgressSince: number | null;
    reason: string | null;
  };
  integrity: IntegrityStats;
  log: LogEntry[];
  serverTime: number;
}
