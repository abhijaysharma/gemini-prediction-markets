import type { RewardsPoolView } from "../types";
import { outlook, type PoolOutlook } from "./estimate";
import { MIN_SIZE, SIZE_CAP } from "./pools";
import { RewardsTracker, type TrackerOptions } from "./tracker";

export interface RunOptions {
  restUrl: string;
  wsUrl: string;
  /** Contracts per side per contract. */
  size: number;
  seconds: number;
  sampleEveryMs?: number;
  stream?: TrackerOptions["stream"];
  log?: (msg: string) => void;
}

export interface RankedPool extends PoolOutlook {
  pool: RewardsPoolView;
}

export interface RunResult {
  ranked: RankedPool[];
  /** Pools with nothing quotable right now, e.g. only upcoming 5-minute windows listed. */
  idlePools: number;
  failedSubscriptions: number;
  maxSpreadCents: number;
}

/** Run the tracker for `seconds`, then rank pools by reward per dollar of capital for one size. */
export async function estimateRewards(opts: RunOptions): Promise<RunResult> {
  if (opts.size < MIN_SIZE) throw new Error(`size must be at least ${MIN_SIZE} contracts to qualify`);
  const tracker = new RewardsTracker({
    restUrl: opts.restUrl,
    wsUrl: opts.wsUrl,
    stream: opts.stream,
    sampleEveryMs: opts.sampleEveryMs,
    windowSize: Math.max(1, Math.round((opts.seconds * 1000) / (opts.sampleEveryMs ?? 1000))),
    log: opts.log,
  });
  try {
    opts.log?.("Reading reward pools and mapping their events to contracts...");
    await tracker.start();
    const started = tracker.state();
    if (started.status !== "ready") throw new Error(started.message ?? "the rewards tracker did not start");
    opts.log?.(`Sampling ${started.contractsWatched} contracts for ${opts.seconds} s...`);
    await new Promise((r) => setTimeout(r, opts.seconds * 1000 + 500));

    const state = tracker.state();
    const ranked = state.pools
      .filter((p) => p.now !== null)
      .map((p) => ({ pool: p, ...outlook(p.now!, p.dailyUsd, { size: opts.size, sizeCap: SIZE_CAP }) }))
      .sort((a, b) => b.usdPerDayPer1k - a.usdPerDayPer1k);
    return {
      ranked,
      idlePools: state.pools.length - ranked.length,
      failedSubscriptions: state.failedSubscriptions,
      maxSpreadCents: state.maxSpreadCents,
    };
  } finally {
    tracker.stop();
  }
}
