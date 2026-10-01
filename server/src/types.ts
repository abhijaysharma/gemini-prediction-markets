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

/** "healed": a pass right after a mismatch, on the same book, with no rebuild in between. */
export type CheckMark = "match" | "mismatch" | "healed" | "resync";

export interface IntegrityStats {
  matched: number;
  mismatched: number;
  /** Passes that followed a mismatch without a rebuild: a later update corrected the book. Also counted in matched. */
  healed: number;
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
  /** From the parent event: a game in progress, a window currently open, etc. */
  live: boolean;
  /** From the parent event, so every contract in an event shares it. */
  volume24h: number;
}

export interface StatePayload {
  mode: "live" | "mock";
  /** A shared public deployment: market switching is off and faults are rate-limited. */
  publicDemo: boolean;
  /** In a public demo, no fault can be injected before this time. */
  faultsAvailableAt: number | null;
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

/** One point of a pool's trend: medians over one minute, valid for any quote size. */
export interface RewardsPoint {
  t: number;
  quoteWeight: number;
  competing: number;
  capitalPerContract: number;
}

export interface RewardsPoolView {
  id: string;
  name: string;
  dailyUsd: number;
  source: string;
  liveEvents: number;
  totalEvents: number;
  maxMakers: number;
  contractsTotal: number;
  /** Medians over the last minute; null when nothing in the pool can be quoted right now. */
  now: (RewardsPoint & { touchSize: number; contractsQuoted: number; oneSided: number; noBook: number }) | null;
  history: RewardsPoint[];
  fills: PoolFills;
}

/** What happened to makers after trades in this pool. See server/src/rewards/markout.ts. */
export interface PoolFills {
  /** Trades marked out so far, including ones saved from earlier runs. */
  trades: number;
  contracts: number;
  /** Size-weighted maker P&L per contract, in cents, at each of RewardsState.horizonsS. */
  markoutCents: (number | null)[];
  se60: number | null;
  /** Every trade seen in this run as [size, contracts queued at the price it hit], for yourFillsPerDay. */
  runTrades: [number, number][];
  /** How long this run has watched the pool; volume isn't extrapolated until it's long enough. */
  observedMs: number;
  enoughObserved: boolean;
}

export interface RewardsState {
  status: "idle" | "starting" | "ready" | "error";
  message: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  maxSpreadCents: number;
  sizeCap: number;
  minSize: number;
  contractsWatched: number;
  failedSubscriptions: number;
  /** Fill-risk settings, so the dashboard explains the same thresholds the server uses. */
  horizonsS: readonly number[];
  minTrades: number;
  pools: RewardsPoolView[];
}
