import type { PoolFills, RewardsPoint, RewardsPoolView, RewardsState } from "../types";
import { medianSample, samplePool, type PoolSample } from "./estimate";
import { FillStore } from "./fillstore";
import { fillStats, HORIZONS_S, MarkoutTracker, MIN_TRADES, type FillRecord } from "./markout";
import {
  fetchContractsByEvent,
  fetchEventContracts,
  fetchPools,
  fetchRewardsConfig,
  MIN_SIZE,
  SIZE_CAP,
  type Pool,
} from "./pools";
import { DepthSampler, type SampledTrade, type SamplerOptions } from "./sampler";
import { topOfBook } from "./scoring";

export interface TrackerOptions {
  restUrl: string;
  wsUrl: string;
  stream?: SamplerOptions["stream"];
  sampleEveryMs?: number;
  /** Samples behind the "now" estimate: one minute at one per second. */
  windowSize?: number;
  /** How often to record a trend point, and refresh the pool list. */
  minuteMs?: number;
  /** Trend points kept per pool: a day of minutes. */
  historySize?: number;
  /** Lookups of newly listed events per refresh, paced at one per second. */
  lookupsPerRefresh?: number;
  /** Where completed fills are saved so markouts survive a restart; omit to keep them in memory only. */
  fillsFile?: string;
  /** Watch a pool this long before extrapolating its trading volume to a day. */
  minObserveMs?: number;
  horizonsS?: readonly number[];
  log?: (msg: string) => void;
}

const RETRY_LOOKUP_MS = 5 * 60_000;
const KEEP_FILLS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RUN_TRADES = 5_000;

/**
 * Measures every liquidity reward pool continuously and keeps a short trend
 * for each. Size-independent: see PoolSample.
 */
export class RewardsTracker {
  private status: RewardsState["status"] = "idle";
  private message: string | null = null;
  private startedAt: number | null = null;
  private updatedAt: number | null = null;
  private maxSpreadCents = 10;
  private pools: Pool[] = [];
  /** Event ticker -> open contract symbols. */
  private contracts = new Map<string, string[]>();
  /** Event ticker -> when we last looked it up and found nothing open. */
  private notYetOpen = new Map<string, number>();
  private windows = new Map<string, PoolSample[]>();
  private history = new Map<string, RewardsPoint[]>();
  /** Fill risk: trades waiting for their markouts, finished fills per pool, and this run's volume. */
  private markouts: MarkoutTracker;
  private fills = new Map<string, FillRecord[]>();
  private poolOfSymbol = new Map<string, string>();
  private tradesThisRun = new Map<string, { at: number; qty: number; queueAhead: number }[]>();
  private watchedSince = new Map<string, number>();
  private store: FillStore | null;
  private sampler: DepthSampler;
  private timers: NodeJS.Timeout[] = [];
  private refreshing = false;
  private readonly log: (msg: string) => void;

  constructor(private opts: TrackerOptions) {
    this.sampler = new DepthSampler({ url: opts.wsUrl, stream: opts.stream, onTrade: (t) => this.onTrade(t) });
    this.store = opts.fillsFile ? new FillStore(opts.fillsFile) : null;
    this.markouts = new MarkoutTracker(opts.horizonsS ?? HORIZONS_S);
    this.log = opts.log ?? (() => {});
  }

  /** Start on first use, so the dashboard costs Gemini nothing until someone opens the Rewards tab. */
  ensureStarted(): void {
    if (this.status === "idle") void this.start();
  }

  async start(): Promise<void> {
    if (this.status === "starting" || this.status === "ready") return;
    this.status = "starting";
    this.message = "Reading reward pools and mapping their events to contracts";
    this.startedAt = Date.now();
    try {
      const config = await fetchRewardsConfig(this.opts.restUrl);
      if (!config.enabled) throw new Error("the liquidity rewards program is not enabled");
      this.maxSpreadCents = config.maxSpreadCents;
      for (const r of this.store?.load() ?? []) this.fills.set(r.poolId, [...(this.fills.get(r.poolId) ?? []), r]);
      this.pools = await fetchPools(this.opts.restUrl);
      // One pass over every listing page up front; newly listed events are looked up one by one later.
      this.contracts = await fetchContractsByEvent(this.opts.restUrl);
      this.syncSymbols();
      this.log(`Rewards: ${this.pools.length} pools, watching ${this.sampler.symbolCount} contracts`);
    } catch (err) {
      this.status = "error";
      this.message = `Could not start: ${(err as Error).message}. Retrying in 30 seconds.`;
      this.timers.push(
        setTimeout(() => {
          this.status = "idle";
          this.ensureStarted();
        }, 30_000),
      );
      return;
    }
    this.status = "ready";
    this.message = null;
    this.timers.push(setInterval(() => this.sample(), this.opts.sampleEveryMs ?? 1000));
    this.timers.push(
      setInterval(() => {
        this.recordTrend();
        void this.refresh();
      }, this.opts.minuteMs ?? 60_000),
    );
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.sampler.stop();
  }

  state(): RewardsState {
    return {
      status: this.status,
      message: this.message,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      maxSpreadCents: this.maxSpreadCents,
      sizeCap: SIZE_CAP,
      minSize: MIN_SIZE,
      horizonsS: this.opts.horizonsS ?? HORIZONS_S,
      minTrades: MIN_TRADES,
      contractsWatched: this.sampler.symbolCount,
      failedSubscriptions: this.sampler.failed.size,
      pools: this.pools.map((p) => this.view(p)),
    };
  }

  private symbolsOf(pool: Pool): string[] {
    return pool.events.flatMap((e) => this.contracts.get(e.ticker) ?? []);
  }

  private syncSymbols(): void {
    this.poolOfSymbol.clear();
    const now = Date.now();
    for (const pool of this.pools) {
      const symbols = this.symbolsOf(pool);
      for (const s of symbols) this.poolOfSymbol.set(s.toUpperCase(), pool.id);
      if (symbols.length && !this.watchedSince.has(pool.id)) this.watchedSince.set(pool.id, now);
    }
    this.sampler.setSymbols(this.poolOfSymbol.keys());
  }

  private onTrade(t: SampledTrade): void {
    const poolId = this.poolOfSymbol.get(t.symbol);
    if (!poolId) return;
    this.markouts.add({ poolId, symbol: t.symbol, at: t.at, price: t.price, qty: t.qty, takerBuy: t.takerBuy });
    // The queue a new quote would have waited behind: what rested at the price this trade hit.
    // A buyer lifts the asks, a seller hits the bids. The snapshot is up to a second old.
    const book = this.sampler.get(t.symbol);
    const top = book ? topOfBook(book.bids, book.asks) : null;
    if (!top) return; // no two-sided book to measure the queue against
    const run = this.tradesThisRun.get(poolId) ?? [];
    run.push({ at: t.at, qty: t.qty, queueAhead: t.takerBuy ? top.bestAskSize : top.bestBidSize });
    // Bound memory on a very busy pool; the observed window then starts at the oldest kept trade.
    if (run.length > MAX_RUN_TRADES) run.shift();
    this.tradesThisRun.set(poolId, run);
  }

  /** Mark pending fills against the current mids, and keep the ones that are done. */
  private markFills(now: number): void {
    const done = this.markouts.resolve(now, (symbol) => {
      const book = this.sampler.get(symbol);
      return book ? topOfBook(book.bids, book.asks)?.mid : undefined;
    });
    if (done.length === 0) return;
    for (const r of done) {
      const list = this.fills.get(r.poolId) ?? [];
      list.push(r);
      while (list.length && now - list[0].at > KEEP_FILLS_MS) list.shift();
      this.fills.set(r.poolId, list);
    }
    this.store?.append(done);
  }

  private fillsView(poolId: string): PoolFills {
    const stats = fillStats(this.fills.get(poolId) ?? []);
    const run = this.tradesThisRun.get(poolId) ?? [];
    let since = this.watchedSince.get(poolId);
    if (since !== undefined && run.length === MAX_RUN_TRADES) since = Math.max(since, run[0].at);
    const observedMs = since === undefined ? 0 : Date.now() - since;
    return {
      ...stats,
      runTrades: run.map((t) => [t.qty, t.queueAhead]),
      observedMs,
      enoughObserved: observedMs >= (this.opts.minObserveMs ?? 10 * 60_000),
    };
  }

  private sample(): void {
    const size = this.opts.windowSize ?? 60;
    for (const pool of this.pools) {
      const s = samplePool(this.symbolsOf(pool), (sym) => this.sampler.get(sym), this.maxSpreadCents);
      const w = this.windows.get(pool.id) ?? [];
      // An empty sample still has to push old ones out, or a pool that stops
      // trading would keep showing its last estimate.
      w.push(s ?? EMPTY);
      if (w.length > size) w.splice(0, w.length - size);
      this.windows.set(pool.id, w);
    }
    this.updatedAt = Date.now();
    this.markFills(this.updatedAt);
  }

  private now(poolId: string): RewardsPoolView["now"] {
    const live = (this.windows.get(poolId) ?? []).filter((s) => s !== EMPTY);
    // Require most of the window, so a pool that just stopped trading reads as idle.
    if (live.length === 0 || live.length * 2 < (this.windows.get(poolId)?.length ?? 0)) return null;
    const m = medianSample(live)!;
    return { t: this.updatedAt ?? Date.now(), ...m };
  }

  private recordTrend(): void {
    const keep = this.opts.historySize ?? 24 * 60;
    for (const pool of this.pools) {
      const n = this.now(pool.id);
      if (!n) continue;
      const h = this.history.get(pool.id) ?? [];
      h.push({ t: n.t, quoteWeight: n.quoteWeight, competing: n.competing, capitalPerContract: n.capitalPerContract });
      if (h.length > keep) h.splice(0, h.length - keep);
      this.history.set(pool.id, h);
    }
  }

  /** Pick up new and expired events: each 5-minute window is a new event. */
  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.pools = await fetchPools(this.opts.restUrl);
      const listed = new Set(this.pools.flatMap((p) => p.events.map((e) => e.ticker)));
      for (const t of [...this.contracts.keys()]) if (!listed.has(t)) this.contracts.delete(t);
      for (const t of [...this.notYetOpen.keys()]) if (!listed.has(t)) this.notYetOpen.delete(t);

      const now = Date.now();
      const unknown = [...listed].filter(
        (t) => !this.contracts.has(t) && now - (this.notYetOpen.get(t) ?? 0) > RETRY_LOOKUP_MS,
      );
      for (const ticker of unknown.slice(0, this.opts.lookupsPerRefresh ?? 20)) {
        const symbols = await fetchEventContracts(this.opts.restUrl, ticker);
        if (symbols.length) this.contracts.set(ticker, symbols);
        else this.notYetOpen.set(ticker, now);
        await new Promise((r) => setTimeout(r, 1000)); // public REST: stay under 1 request a second
      }
      this.syncSymbols();
    } catch (err) {
      this.log(`Rewards refresh failed: ${(err as Error).message}`);
    } finally {
      this.refreshing = false;
    }
  }

  private view(pool: Pool): RewardsPoolView {
    return {
      id: pool.id,
      name: pool.name,
      dailyUsd: pool.dailyUsd,
      source: pool.source,
      liveEvents: pool.events.filter((e) => this.contracts.has(e.ticker)).length,
      totalEvents: pool.events.length,
      maxMakers: Math.max(0, ...pool.events.map((e) => e.qualifyingMakers)),
      contractsTotal: this.symbolsOf(pool).length,
      now: this.now(pool.id),
      history: this.history.get(pool.id) ?? [],
      fills: this.fillsView(pool.id),
    };
  }
}

/** Marks a second in which nothing in the pool could be quoted. */
const EMPTY: PoolSample = Object.freeze({
  quoteWeight: 0,
  competing: 0,
  capitalPerContract: 0,
  touchSize: 0,
  contractsQuoted: 0,
  oneSided: 0,
  noBook: 0,
});
