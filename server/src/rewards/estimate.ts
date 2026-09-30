import type { Level } from "../types";
import type { Pool } from "./pools";
import { competingScore, quoteCapital, quoteScore, topOfBook } from "./scoring";

export interface QuotePlan {
  /** Contracts quoted on each side of every contract in the pool. */
  size: number;
  sizeCap: number;
  maxSpreadCents: number;
}

/** One pool at one instant. */
export interface PoolSample {
  share: number;
  capital: number;
  contractsQuoted: number;
  oneSided: number;
  noBook: number;
}

export interface PoolEstimate {
  pool: Pool;
  /** Median over samples. */
  share: number;
  capital: number;
  estUsdPerDay: number;
  usdPerDayPer1k: number;
  contractsQuoted: number;
  contractsTotal: number;
  liveEvents: number;
  maxMakers: number;
  samples: number;
}

/**
 * Your share of a pool's score at this instant if you quoted `size` at the
 * best bid and ask of every two-sided contract in it. The pool is split by
 * score summed across all of its events, so competition is summed the same
 * way. Contracts with a one-sided book, or no book yet (upcoming events), are
 * left out.
 */
export function samplePool(
  symbols: string[],
  bookOf: (symbol: string) => { bids: Level[]; asks: Level[] } | undefined,
  plan: QuotePlan,
): PoolSample | null {
  let mine = 0;
  let theirs = 0;
  let capital = 0;
  let contractsQuoted = 0;
  let oneSided = 0;
  let noBook = 0;
  for (const symbol of symbols) {
    const book = bookOf(symbol);
    if (!book) {
      noBook++;
      continue;
    }
    const top = topOfBook(book.bids, book.asks);
    if (!top) {
      oneSided++;
      continue;
    }
    const score = quoteScore(top, plan.size, plan.sizeCap, plan.maxSpreadCents);
    if (score === 0) continue; // the spread is too wide for any quote at the touch to qualify
    mine += score;
    theirs += competingScore(book.bids, book.asks, top.mid, plan.maxSpreadCents);
    capital += quoteCapital(top, plan.size);
    contractsQuoted++;
  }
  if (mine === 0) return null;
  return { share: mine / (mine + theirs), capital, contractsQuoted, oneSided, noBook };
}

export function summarize(pool: Pool, symbols: string[], samples: PoolSample[], liveEvents: number): PoolEstimate | null {
  if (samples.length === 0) return null;
  const share = median(samples.map((s) => s.share));
  const capital = median(samples.map((s) => s.capital));
  const estUsdPerDay = pool.dailyUsd * share;
  return {
    pool,
    share,
    capital,
    estUsdPerDay,
    usdPerDayPer1k: capital > 0 ? (estUsdPerDay / capital) * 1000 : 0,
    contractsQuoted: Math.round(median(samples.map((s) => s.contractsQuoted))),
    contractsTotal: symbols.length,
    liveEvents,
    maxMakers: Math.max(0, ...pool.events.map((e) => e.qualifyingMakers)),
    samples: samples.length,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
