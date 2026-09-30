import { isZero, normDecimal } from "./decimal";
import type { OrderBook } from "./orderbook";
import type { CheckMark, IntegrityStats, Level } from "./types";

/** Depth of the reference stream we subscribe to ({symbol}@depth20@100ms). */
export const REFERENCE_DEPTH = 20;
const HISTORY_CAP = 160;

export type CheckResult = "match" | "mismatch" | "healed";

export interface ReferenceSnapshot {
  lastUpdateId: number;
  bids: Level[];
  asks: Level[];
}

/**
 * Proves the local book is correct by comparing it with the exchange's own
 * published top-of-book snapshots.
 *
 * A comparison is only meaningful when both describe the same moment, so we
 * compare only when the local book's last update ID equals the snapshot's
 * lastUpdateId. A snapshot that's ahead of us is held until the book catches
 * up; one we can't line up exactly is counted as skipped, never as a pass.
 */
export class IntegrityChecker {
  stats: IntegrityStats = freshStats();
  private pending: ReferenceSnapshot | null = null;
  /** The last comparison on the current book failed. */
  private unresolvedMismatch = false;

  /** Called whenever a new book starts building. */
  resetPending(): void {
    this.pending = null;
    this.unresolvedMismatch = false;
  }

  resetAll(): void {
    this.resetPending();
    this.stats = freshStats();
  }

  mark(kind: CheckMark): void {
    this.stats.history.push(kind);
    if (this.stats.history.length > HISTORY_CAP) this.stats.history.shift();
  }

  onReference(ref: ReferenceSnapshot, book: OrderBook, now: number): CheckResult | null {
    const local = book.lastUpdateId;
    if (local === null) {
      this.stats.skipped++;
      return null;
    }
    if (ref.lastUpdateId === local) return this.compare(ref, book, now);
    if (ref.lastUpdateId > local) {
      if (this.pending) this.stats.skipped++;
      this.pending = ref;
      return null;
    }
    this.stats.skipped++;
    return null;
  }

  onBookAdvanced(book: OrderBook, now: number): CheckResult | null {
    const local = book.lastUpdateId;
    if (!this.pending || local === null) return null;
    if (local === this.pending.lastUpdateId) {
      const ref = this.pending;
      this.pending = null;
      return this.compare(ref, book, now);
    }
    if (local > this.pending.lastUpdateId) {
      this.stats.skipped++;
      this.pending = null;
    }
    return null;
  }

  private compare(ref: ReferenceSnapshot, book: OrderBook, now: number): CheckResult {
    const problem =
      diffSide("bid", ref.bids, book.topBids(REFERENCE_DEPTH)) ??
      diffSide("ask", ref.asks, book.topAsks(REFERENCE_DEPTH));
    this.stats.lastCheckedAt = now;
    if (problem) {
      this.stats.mismatched++;
      this.stats.last = "mismatch";
      this.stats.lastMismatch = `update ${ref.lastUpdateId}: ${problem}`;
      this.unresolvedMismatch = true;
      this.mark("mismatch");
      return "mismatch";
    }
    this.stats.matched++;
    this.stats.last = "match";
    // A pass right after a failure on the same book means a later update
    // overwrote the bad level before a rebuild was needed.
    if (this.unresolvedMismatch) {
      this.unresolvedMismatch = false;
      this.stats.healed++;
      this.mark("healed");
      return "healed";
    }
    this.mark("match");
    return "match";
  }
}

function diffSide(label: string, expected: Level[], actual: Level[]): string | null {
  const exp = expected
    .filter(([, q]) => !isZero(q))
    .map(([p, q]) => [normDecimal(p), normDecimal(q)] as Level);
  if (exp.length !== actual.length) {
    return `${label} side has ${exp.length} levels on the exchange and ${actual.length} locally`;
  }
  for (let i = 0; i < exp.length; i++) {
    const [ep, eq] = exp[i];
    const [ap, aq] = actual[i];
    if (ep !== ap || eq !== aq) {
      return `${label} level ${i + 1} is ${ep} x ${eq} on the exchange but ${ap} x ${aq} locally`;
    }
  }
  return null;
}

function freshStats(): IntegrityStats {
  return {
    matched: 0,
    mismatched: 0,
    healed: 0,
    skipped: 0,
    last: null,
    lastCheckedAt: null,
    lastMismatch: null,
    history: [],
  };
}
