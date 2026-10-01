import type { Level } from "../types";
import { competingScore, quoteCapital, quoteScore, topOfBook } from "./scoring";

/**
 * One pool at one instant, measured once and valid for any quote size.
 *
 * A quote at the touch scores linearly in its size (up to the per-maker
 * cap), so instead of scoring one particular size we store the score and
 * collateral of a single contract. Your share for any size q is then
 *   share = q·quoteWeight / (q·quoteWeight + competing)
 * which lets the dashboard answer "what if I quoted 250?" without
 * re-measuring anything.
 */
export interface PoolSample {
  /** Score of quoting one contract at the best bid and ask of every quoted contract. */
  quoteWeight: number;
  /** Score of everything already resting near the mid, across the same contracts. */
  competing: number;
  /** Collateral for one contract on each side of every quoted contract. */
  capitalPerContract: number;
  /** Contracts resting at the touch, per side, summed over quoted contracts. */
  touchSize: number;
  contractsQuoted: number;
  oneSided: number;
  noBook: number;
}

export interface QuoteSize {
  size: number;
  sizeCap: number;
}

/**
 * Measure a pool across all of its contracts. The pool is split by score
 * summed across all of its events, so competition is summed the same way.
 * Contracts with a one-sided book, or no book yet (upcoming events), are
 * left out, as are those whose spread is too wide for any quote at the
 * touch to qualify.
 */
export function samplePool(
  symbols: string[],
  bookOf: (symbol: string) => { bids: Level[]; asks: Level[] } | undefined,
  maxSpreadCents: number,
): PoolSample | null {
  const s: PoolSample = { quoteWeight: 0, competing: 0, capitalPerContract: 0, touchSize: 0, contractsQuoted: 0, oneSided: 0, noBook: 0 };
  for (const symbol of symbols) {
    const book = bookOf(symbol);
    if (!book) {
      s.noBook++;
      continue;
    }
    const top = topOfBook(book.bids, book.asks);
    if (!top) {
      s.oneSided++;
      continue;
    }
    const weight = quoteScore(top, 1, Infinity, maxSpreadCents);
    if (weight === 0) continue;
    s.quoteWeight += weight;
    s.competing += competingScore(book.bids, book.asks, top.mid, maxSpreadCents);
    s.capitalPerContract += quoteCapital(top, 1);
    s.touchSize += (top.bestBidSize + top.bestAskSize) / 2;
    s.contractsQuoted++;
  }
  return s.quoteWeight > 0 ? s : null;
}

export function shareFor(s: Pick<PoolSample, "quoteWeight" | "competing">, q: QuoteSize): number {
  const mine = Math.min(q.size, q.sizeCap) * s.quoteWeight;
  return mine / (mine + s.competing);
}

export interface PoolOutlook {
  share: number;
  estUsdPerDay: number;
  capital: number;
  usdPerDayPer1k: number;
}

/** What a given size would earn in a pool, from a (typically median) sample. */
export function outlook(
  s: Pick<PoolSample, "quoteWeight" | "competing" | "capitalPerContract">,
  dailyUsd: number,
  q: QuoteSize,
): PoolOutlook {
  const share = shareFor(s, q);
  const estUsdPerDay = dailyUsd * share;
  const capital = q.size * s.capitalPerContract;
  return { share, estUsdPerDay, capital, usdPerDayPer1k: capital > 0 ? (estUsdPerDay / capital) * 1000 : 0 };
}

/** Field-by-field median, so one noisy second doesn't move the estimate. */
export function medianSample(samples: PoolSample[]): PoolSample | null {
  if (samples.length === 0) return null;
  const med = (k: keyof PoolSample) => median(samples.map((s) => s[k]));
  return {
    quoteWeight: med("quoteWeight"),
    competing: med("competing"),
    capitalPerContract: med("capitalPerContract"),
    touchSize: med("touchSize"),
    contractsQuoted: Math.round(med("contractsQuoted")),
    oneSided: Math.round(med("oneSided")),
    noBook: Math.round(med("noBook")),
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
