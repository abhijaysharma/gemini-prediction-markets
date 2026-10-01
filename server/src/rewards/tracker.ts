import type { RewardsPoint, RewardsPoolView, RewardsState } from "../types";
import { medianSample, samplePool, type PoolSample } from "./estimate";
import {
  fetchContractsByEvent,
  fetchEventContracts,
  fetchPools,
  fetchRewardsConfig,
  MIN_SIZE,
  SIZE_CAP,
  type Pool,
} from "./pools";
import { DepthSampler, type SamplerOptions } from "./sampler";

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
  log?: (msg: string) => void;
}

const RETRY_LOOKUP_MS = 5 * 60_000;

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
  private sampler: DepthSampler;
  private timers: NodeJS.Timeout[] = [];
  private refreshing = false;
  private readonly log: (msg: string) => void;

  constructor(private opts: TrackerOptions) {
    this.sampler = new DepthSampler({ url: opts.wsUrl, stream: opts.stream });
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
      contractsWatched: this.sampler.symbolCount,
      failedSubscriptions: this.sampler.failed.size,
      pools: this.pools.map((p) => this.view(p)),
    };
  }

  private symbolsOf(pool: Pool): string[] {
    return pool.events.flatMap((e) => this.contracts.get(e.ticker) ?? []);
  }

  private syncSymbols(): void {
    this.sampler.setSymbols(new Set(this.pools.flatMap((p) => this.symbolsOf(p))));
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
    };
  }
}

/** Marks a second in which nothing in the pool could be quoted. */
const EMPTY: PoolSample = Object.freeze({
  quoteWeight: 0,
  competing: 0,
  capitalPerContract: 0,
  contractsQuoted: 0,
  oneSided: 0,
  noBook: 0,
});
