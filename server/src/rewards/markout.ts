// Fill risk: what happens to a maker after someone trades against their quote.
//
// Each public trade has a maker on the other side. If the taker bought at
// 51c, a maker sold at 51c; if the mid is 55c a minute later, that maker is
// 4c per contract worse off than if they hadn't traded. Averaged over many
// fills this "markout" says whether makers in a pool are being picked off
// (negative) or keeping the spread (positive). It is the cost side of
// liquidity rewards, which only measure the payout side.

/** Seconds after a fill at which the maker's position is marked. */
export const HORIZONS_S: readonly number[] = [5, 30, 60];

/** Below this many trades, a pool's markout is too noisy to act on. */
export const MIN_TRADES = 30;

export interface Fill {
  poolId: string;
  symbol: string;
  at: number;
  price: number;
  qty: number;
  /** The taker bought, so the maker sold. */
  takerBuy: boolean;
}

export interface FillRecord extends Fill {
  /** Maker P&L per contract in cents at each horizon; null if the book had no mid then. */
  markoutCents: (number | null)[];
}

/** Maker P&L per contract, in cents, if the mid is `mid` now. */
export function makerPnlCents(fill: Pick<Fill, "price" | "takerBuy">, mid: number): number {
  return (fill.takerBuy ? fill.price - mid : mid - fill.price) * 100;
}

/** Holds fills until every horizon has passed, marking each one as it does. */
export class MarkoutTracker {
  private pending: FillRecord[] = [];
  private readonly longestMs: number;

  /** Horizons are configurable so tests don't have to wait a minute. */
  constructor(private horizonsS: readonly number[] = HORIZONS_S) {
    this.longestMs = horizonsS[horizonsS.length - 1] * 1000;
  }

  add(fill: Fill): void {
    this.pending.push({ ...fill, markoutCents: this.horizonsS.map(() => null) });
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Call about once a second. Marks every horizon that has elapsed using the
   * current mid, and returns the fills whose last horizon is done.
   */
  resolve(now: number, midOf: (symbol: string) => number | undefined): FillRecord[] {
    const done: FillRecord[] = [];
    this.pending = this.pending.filter((r) => {
      const mid = midOf(r.symbol);
      this.horizonsS.forEach((h, i) => {
        if (r.markoutCents[i] === null && now - r.at >= h * 1000 && mid !== undefined) {
          r.markoutCents[i] = makerPnlCents(r, mid);
        }
      });
      // Give a missing mid a little grace; after that the horizon stays null.
      const finished = now - r.at >= this.longestMs + 10_000 || r.markoutCents.every((m) => m !== null);
      if (finished) done.push(r);
      return !finished;
    });
    return done;
  }
}

export interface FillStats {
  trades: number;
  contracts: number;
  /** Size-weighted mean maker P&L per contract at each horizon, in cents. */
  markoutCents: (number | null)[];
  /** Standard error of the 60-second markout, in cents. */
  se60: number | null;
}

/**
 * Size-weighted, because a 100-contract fill moves a maker's P&L 100 times
 * as much as a 1-contract fill. The standard error treats each trade as one
 * observation, which is the honest unit: one big fill is still one event.
 */
export function fillStats(records: FillRecord[]): FillStats {
  const contracts = records.reduce((s, r) => s + r.qty, 0);
  const markoutCents = HORIZONS_S.map((_, i) => {
    const xs = records.filter((r) => r.markoutCents[i] !== null);
    const w = xs.reduce((s, r) => s + r.qty, 0);
    return w > 0 ? xs.reduce((s, r) => s + r.qty * r.markoutCents[i]!, 0) / w : null;
  });
  const last = HORIZONS_S.length - 1;
  const xs = records.filter((r) => r.markoutCents[last] !== null);
  let se60: number | null = null;
  const mean = markoutCents[last];
  if (xs.length >= 2 && mean !== null) {
    const w = xs.reduce((s, r) => s + r.qty, 0);
    const variance = xs.reduce((s, r) => s + r.qty * (r.markoutCents[last]! - mean) ** 2, 0) / w;
    se60 = Math.sqrt(variance / xs.length);
  }
  return { trades: records.length, contracts, markoutCents, se60 };
}

const DAY_MS = 86_400_000;

/** A trade seen this run: its size, and the contracts resting at the price it hit just before. */
export type QueuedTrade = [qty: number, queueAhead: number];

/**
 * Contracts of a `size` quote that would have been filled per day, given the
 * trades seen. A new quote joins the back of the queue at its price, so a
 * trade of Q contracts first fills the contracts already resting there, and
 * only what's left reaches you, never more than your size:
 *   your fill = min(size, max(0, Q - queue ahead))
 * Small trades never reach you, and one huge trade can't fill more than you
 * offered. The queue is the one each trade actually met, not an average.
 */
export function yourFillsPerDay(trades: QueuedTrade[], observedMs: number, size: number): number {
  if (observedMs <= 0) return 0;
  const filled = trades.reduce((s, [q, ahead]) => s + Math.min(size, Math.max(0, q - ahead)), 0);
  return (filled / observedMs) * DAY_MS;
}

/** Daily P&L from those fills in dollars, negative being a cost; null until there are enough trades. */
export function fillPnlPerDay(stats: FillStats, fillsPerDay: number): number | null {
  const m60 = stats.markoutCents[stats.markoutCents.length - 1];
  if (stats.trades < MIN_TRADES || m60 === null) return null;
  return (fillsPerDay * m60) / 100;
}
