import type { Level } from "../types";

// Liquidity rewards scoring, as documented at
// https://developer.gemini.com/prediction-markets/liquidity-rewards-program
//
//   snapshot score = spread weight × size × two-sided multiplier
//
// The docs only call the spread weight "a quadratic curve". 1/d² (d = cents
// from the midpoint, zero past the max spread) reproduces the docs' worked
// example to within a point (73/5/21% against ~74/5/21%), where the obvious
// quadratics don't. See docs/findings/0002-liquidity-rewards.md.
//
// Unlike the order book, this is arithmetic on prices, so it uses numbers.

export const TWO_SIDED_MULTIPLIER = 1.5;

export function spreadWeight(distanceCents: number, maxSpreadCents: number): number {
  if (!(distanceCents > 0) || distanceCents > maxSpreadCents + 1e-9) return 0;
  return 1 / (distanceCents * distanceCents);
}

export interface TopOfBook {
  bestBid: number;
  bestAsk: number;
  mid: number;
}

/** Null for a one-sided or empty book: the docs score those differently, and we skip them. */
export function topOfBook(bids: Level[], asks: Level[]): TopOfBook | null {
  if (bids.length === 0 || asks.length === 0) return null;
  const bestBid = Math.max(...bids.map(([p]) => Number(p)));
  const bestAsk = Math.min(...asks.map(([p]) => Number(p)));
  return { bestBid, bestAsk, mid: (bestBid + bestAsk) / 2 };
}

/**
 * Score of everything already resting near the mid. The public book merges
 * makers at each price, so two things are unknowable and are resolved
 * against us: the per-maker size cap isn't applied, and every competitor is
 * assumed to earn the two-sided bonus. Both overstate competition.
 */
export function competingScore(bids: Level[], asks: Level[], mid: number, maxSpreadCents: number): number {
  let score = 0;
  for (const [p, q] of [...bids, ...asks]) {
    score += Number(q) * spreadWeight(Math.abs(Number(p) - mid) * 100, maxSpreadCents);
  }
  return score * TWO_SIDED_MULTIPLIER;
}

/** Score of a hypothetical quote: `size` at the best bid and `size` at the best ask. */
export function quoteScore(top: TopOfBook, size: number, sizeCap: number, maxSpreadCents: number): number {
  const q = Math.min(size, sizeCap);
  const bid = q * spreadWeight((top.mid - top.bestBid) * 100, maxSpreadCents);
  const ask = q * spreadWeight((top.bestAsk - top.mid) * 100, maxSpreadCents);
  // The bonus needs a qualifying quote on both sides.
  return bid > 0 && ask > 0 ? (bid + ask) * TWO_SIDED_MULTIPLIER : bid + ask;
}

/** Collateral for that quote: YES bought at the bid, plus NO bought at (1 - ask). */
export function quoteCapital(top: TopOfBook, size: number): number {
  return size * top.bestBid + size * (1 - top.bestAsk);
}
