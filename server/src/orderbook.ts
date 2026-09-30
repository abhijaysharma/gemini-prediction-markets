import { isZero, normDecimal } from "./decimal";
import type { Level } from "./types";

export type DeltaResult = "applied" | "stale" | "gap";

/**
 * A local L2 order book rebuilt from a snapshot plus sequenced deltas.
 *
 * Sequencing follows Gemini's differential depth stream. On the live feed each
 * frame's U equals the previous frame's u, so a frame covers the IDs after U
 * up to and including u. If U is past the last ID we applied, the frames in
 * between never arrived and the book can no longer be trusted.
 */
export class OrderBook {
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  lastUpdateId: number | null = null;

  get isReady(): boolean {
    return this.lastUpdateId !== null;
  }

  get bidCount(): number {
    return this.bids.size;
  }

  get askCount(): number {
    return this.asks.size;
  }

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.lastUpdateId = null;
  }

  applySnapshot(bids: Level[], asks: Level[], lastUpdateId: number): void {
    this.reset();
    this.applyLevels(this.bids, bids);
    this.applyLevels(this.asks, asks);
    this.lastUpdateId = lastUpdateId;
  }

  applyDelta(firstId: number, lastId: number, bids: Level[], asks: Level[]): DeltaResult {
    if (this.lastUpdateId === null) {
      throw new Error("applyDelta called before a snapshot was applied");
    }
    // Everything in this frame is already reflected in the book.
    if (lastId <= this.lastUpdateId) return "stale";
    // This frame starts after an ID we never saw, so a frame went missing.
    if (firstId > this.lastUpdateId) return "gap";
    // firstId === last is the normal case. An overlap (firstId < last < lastId)
    // is also safe: setting a level's quantity is idempotent.
    this.applyLevels(this.bids, bids);
    this.applyLevels(this.asks, asks);
    this.lastUpdateId = lastId;
    return "applied";
  }

  private applyLevels(side: Map<string, string>, levels: Level[]): void {
    for (const [p, q] of levels) {
      const price = normDecimal(p);
      if (isZero(q)) side.delete(price);
      else side.set(price, normDecimal(q));
    }
  }

  /** Best bids first (highest price). */
  topBids(n = Infinity): Level[] {
    return [...this.bids].sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, n);
  }

  /** Best asks first (lowest price). */
  topAsks(n = Infinity): Level[] {
    return [...this.asks].sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, n);
  }

  bestBid(): string | null {
    let best: string | null = null;
    for (const p of this.bids.keys()) if (best === null || Number(p) > Number(best)) best = p;
    return best;
  }

  bestAsk(): string | null {
    let best: string | null = null;
    for (const p of this.asks.keys()) if (best === null || Number(p) < Number(best)) best = p;
    return best;
  }

  /**
   * Fault injection only: silently change the size at the best level, the way
   * a bug in book-building code would. Sequence numbers can't catch this; only
   * comparing against the exchange can. Returns a description, or null if empty.
   */
  corruptBestLevel(): string | null {
    const [side, price] = this.bestBid() !== null ? ["bid", this.bestBid()!] : ["ask", this.bestAsk()];
    if (price === null) return null;
    const map = side === "bid" ? this.bids : this.asks;
    const before = map.get(price)!;
    const after = String(Number(before) * 2 + 1);
    map.set(price, after);
    return `best ${side} ${price} size changed from ${before} to ${after}`;
  }

  /** A crossed book (best bid >= best ask) should never exist on an exchange. */
  isCrossed(): boolean {
    const bb = this.bestBid();
    const ba = this.bestAsk();
    return bb !== null && ba !== null && Number(bb) >= Number(ba);
  }
}
