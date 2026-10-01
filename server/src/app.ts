import { FeedClient } from "./feed";
import { fetchMarkets, pickMarket } from "./markets";
import { RewardsTracker } from "./rewards/tracker";
import type { MarketInfo, StatePayload } from "./types";

export interface AppOptions {
  wsUrl: string;
  restUrl: string;
  /** Fixed symbol. When set, the app never rolls over on its own. */
  symbol?: string;
  mode: "live" | "mock";
  pingMs?: number;
  staleMs?: number;
  quiet?: boolean;
}

const LADDER_DEPTH = 14;
const MID_SAMPLE_MS = 500;
const MID_HISTORY = 600;
const MARKET_REFRESH_MS = 60_000;
const RETRY_DISCOVERY_MS = 10_000;
/** Status values that mean a contract is still (or about to be) tradable. */
const STILL_TRADING = /active|open|trading|approved|awaiting|pending/i;

/**
 * Owns the feed, picks which market to watch, rolls over to the next
 * contract when the current one ends, and builds the dashboard's state.
 */
export class App {
  readonly feed: FeedClient;
  /** Started by the first request for /api/rewards. */
  readonly rewards: RewardsTracker;
  markets: MarketInfo[] = [];
  private mids: { t: number; mid: number }[] = [];
  private lastMidSample = 0;
  private autoRollover: boolean;
  private rolling = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private opts: AppOptions) {
    this.feed = new FeedClient({
      url: opts.wsUrl,
      pingMs: opts.pingMs,
      staleMs: opts.staleMs,
      quiet: opts.quiet,
    });
    this.rewards = new RewardsTracker({
      restUrl: opts.restUrl,
      wsUrl: opts.wsUrl,
      log: opts.quiet ? undefined : (m) => console.log(`[rewards] ${m}`),
    });
    this.autoRollover = !opts.symbol;
    this.feed.on("symbol", () => {
      this.mids = [];
    });
    this.feed.on("contractStatus", (msg: any) => this.onContractStatus(msg));
  }

  async start(): Promise<void> {
    this.timers.push(setInterval(() => void this.refreshMarkets(), MARKET_REFRESH_MS));
    if (this.opts.symbol) {
      this.feed.info(`Using fixed symbol ${this.opts.symbol}`);
      this.feed.start(this.opts.symbol);
      void this.refreshMarkets();
      return;
    }
    await this.discoverAndStart();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.feed.stop();
    this.rewards.stop();
  }

  selectSymbol(symbol: string): void {
    this.autoRollover = true;
    if (this.feed.symbol === null) this.feed.start(symbol);
    else this.feed.setSymbol(symbol);
  }

  private async discoverAndStart(): Promise<void> {
    try {
      this.markets = await fetchMarkets(this.opts.restUrl);
      const symbol = pickMarket(this.markets, null);
      if (!symbol) throw new Error("the events endpoint returned no instrument symbols");
      this.feed.info(`Found ${this.markets.length} contracts, starting with ${symbol}`);
      this.feed.start(symbol);
    } catch (err) {
      this.feed.warn(`Market discovery failed: ${(err as Error).message}. Retrying in 10 seconds.`);
      setTimeout(() => void this.discoverAndStart(), RETRY_DISCOVERY_MS);
    }
  }

  private async refreshMarkets(): Promise<void> {
    try {
      this.markets = await fetchMarkets(this.opts.restUrl);
    } catch (err) {
      this.feed.warn(`Could not refresh the market list: ${(err as Error).message}`);
      return;
    }
    const current = this.feed.symbol;
    if (this.autoRollover && current && this.markets.length && !this.markets.some((m) => m.symbol === current)) {
      void this.rollover(`${current} is no longer listed`);
    }
  }

  private onContractStatus(msg: any): void {
    const current = this.feed.symbol;
    if (!current || typeof msg.s !== "string" || msg.s.toLowerCase() !== current.toLowerCase()) return;
    const status = String(msg.n ?? "unknown");
    this.feed.info(`Contract status changed from ${msg.o ?? "unknown"} to ${status}`);
    if (this.autoRollover && !STILL_TRADING.test(status)) {
      void this.rollover(`contract moved to "${status}"`);
    }
  }

  private async rollover(reason: string): Promise<void> {
    if (this.rolling) return;
    this.rolling = true;
    try {
      this.feed.info(`Rolling over: ${reason}`);
      this.markets = await fetchMarkets(this.opts.restUrl);
      const next = pickMarket(this.markets, this.feed.symbol);
      if (next) this.feed.setSymbol(next);
      else this.feed.warn("No replacement contract is listed yet. Will check again on the next refresh.");
    } catch (err) {
      this.feed.warn(`Rollover failed: ${(err as Error).message}`);
    } finally {
      this.rolling = false;
    }
  }

  buildState(now = Date.now()): StatePayload {
    const f = this.feed;
    const bestBid = f.book.bestBid();
    const bestAsk = f.book.bestAsk();
    const spread = bestBid && bestAsk ? Number(bestAsk) - Number(bestBid) : null;
    const mid = bestBid && bestAsk ? (Number(bestAsk) + Number(bestBid)) / 2 : null;

    if (mid !== null && f.state === "live" && now - this.lastMidSample >= MID_SAMPLE_MS) {
      this.mids.push({ t: now, mid });
      if (this.mids.length > MID_HISTORY) this.mids.shift();
      this.lastMidSample = now;
    }

    const p50 = f.lag.percentile(50);
    const p99 = f.lag.percentile(99);
    const min = f.lag.min();

    return {
      mode: this.opts.mode,
      symbol: f.symbol,
      feedState: f.state,
      connectedSince: f.connectedSince,
      book: {
        bids: f.book.topBids(LADDER_DEPTH),
        asks: f.book.topAsks(LADDER_DEPTH),
        bestBid,
        bestAsk,
        spread,
        mid,
        lastUpdateId: f.book.lastUpdateId,
        bidLevels: f.book.bidCount,
        askLevels: f.book.askCount,
      },
      mids: this.mids,
      trades: f.trades.slice(0, 30),
      counters: { ...f.counters },
      metrics: {
        msgPerSec: f.rate.rate(now),
        lagP50: p50,
        lagP99: p99,
        // Jitter is lag above the fastest message we've seen. It cancels out
        // constant clock offset, so it's more trustworthy than raw lag.
        jitterP99: p99 !== null && min !== null ? p99 - min : null,
        lagSamples: f.lag.size,
      },
      recovery: {
        lastMs: f.recoveries.at(-1) ?? null,
        recentMs: [...f.recoveries],
        inProgressSince: f.recoveryStartedAt,
        reason: f.recoveryReason,
      },
      integrity: { ...f.integrity.stats, history: [...f.integrity.stats.history] },
      log: f.log.slice(-60),
      serverTime: now,
    };
  }
}
