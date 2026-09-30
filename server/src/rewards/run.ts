import { summarize, samplePool, type PoolEstimate, type PoolSample, type QuotePlan } from "./estimate";
import { fetchContractsByEvent, fetchPools, fetchRewardsConfig, MIN_SIZE, SIZE_CAP } from "./pools";
import { DepthSampler } from "./sampler";

export interface RunOptions {
  restUrl: string;
  wsUrl: string;
  /** Contracts per side per contract. */
  size: number;
  seconds: number;
  sampleEveryMs?: number;
  log?: (msg: string) => void;
}

export interface RunResult {
  estimates: PoolEstimate[];
  /** Pools with no event trading right now, e.g. only upcoming 5-minute windows listed. */
  idlePools: number;
  subscribeFailures: string[];
  maxSpreadCents: number;
}

/** Measure every reward pool for `seconds` and rank them by reward per dollar of capital. */
export async function estimateRewards(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  if (opts.size < MIN_SIZE) throw new Error(`size must be at least ${MIN_SIZE} contracts to qualify`);

  const config = await fetchRewardsConfig(opts.restUrl);
  if (!config.enabled) throw new Error("the liquidity rewards program is not enabled");
  const pools = await fetchPools(opts.restUrl);
  log(`${pools.length} reward pools, $${pools.reduce((s, p) => s + p.dailyUsd, 0).toFixed(0)}/day in total`);

  log("Mapping events to contracts (reads every page of the events listing)...");
  const contracts = await fetchContractsByEvent(opts.restUrl);
  const symbolsByPool = new Map<string, string[]>();
  const liveEventsByPool = new Map<string, number>();
  for (const pool of pools) {
    const live = pool.events.filter((e) => contracts.has(e.ticker));
    symbolsByPool.set(pool.id, live.flatMap((e) => contracts.get(e.ticker)!));
    liveEventsByPool.set(pool.id, live.length);
  }
  const allSymbols = [...new Set([...symbolsByPool.values()].flat())];
  log(`Subscribing to depth20 for ${allSymbols.length} contracts...`);

  const sampler = new DepthSampler({ url: opts.wsUrl });
  const plan: QuotePlan = { size: opts.size, sizeCap: SIZE_CAP, maxSpreadCents: config.maxSpreadCents };
  const samples = new Map<string, PoolSample[]>();
  try {
    await sampler.start(allSymbols);
    // Let the first snapshot for each symbol arrive before sampling.
    await sleep(1500);
    log(`Sampling for ${opts.seconds} s...`);
    const every = opts.sampleEveryMs ?? 1000;
    for (let t = 0; t < opts.seconds * 1000; t += every) {
      for (const pool of pools) {
        const s = samplePool(symbolsByPool.get(pool.id)!, (sym) => sampler.get(sym), plan);
        if (s) samples.set(pool.id, [...(samples.get(pool.id) ?? []), s]);
      }
      await sleep(every);
    }
  } finally {
    sampler.stop();
  }

  const estimates = pools
    .map((p) => summarize(p, symbolsByPool.get(p.id)!, samples.get(p.id) ?? [], liveEventsByPool.get(p.id)!))
    .filter((e): e is PoolEstimate => e !== null)
    .sort((a, b) => b.usdPerDayPer1k - a.usdPerDayPer1k);
  return {
    estimates,
    idlePools: pools.length - estimates.length,
    subscribeFailures: sampler.failed,
    maxSpreadCents: config.maxSpreadCents,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
