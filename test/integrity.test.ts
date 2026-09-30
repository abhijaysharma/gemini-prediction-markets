import { describe, expect, it } from "vitest";
import { IntegrityChecker } from "../server/src/integrity";
import { OrderBook } from "../server/src/orderbook";

function bookAt(id: number) {
  const book = new OrderBook();
  book.applySnapshot([["0.48", "5000"]], [["0.52", "3200"]], id);
  return book;
}

describe("IntegrityChecker", () => {
  it("passes when the book matches a reference at the same update ID", () => {
    const check = new IntegrityChecker();
    const result = check.onReference(
      { lastUpdateId: 10, bids: [["0.480", "5000"]], asks: [["0.52", "3200.0"]] },
      bookAt(10),
      0,
    );
    expect(result).toBe("match");
    expect(check.stats.matched).toBe(1);
  });

  it("fails with a readable reason when a level differs", () => {
    const check = new IntegrityChecker();
    const result = check.onReference(
      { lastUpdateId: 10, bids: [["0.48", "4000"]], asks: [["0.52", "3200"]] },
      bookAt(10),
      0,
    );
    expect(result).toBe("mismatch");
    expect(check.stats.lastMismatch).toContain("bid level 1");
  });

  it("catches a stale level the local book failed to remove", () => {
    const book = bookAt(10);
    book.applyDelta(10, 11, [["0.40", "7"]], []);
    const check = new IntegrityChecker();
    const result = check.onReference(
      { lastUpdateId: 11, bids: [["0.48", "5000"]], asks: [["0.52", "3200"]] },
      book,
      0,
    );
    expect(result).toBe("mismatch");
  });

  it("holds a reference that is ahead until the book catches up", () => {
    const book = bookAt(10);
    const check = new IntegrityChecker();
    expect(
      check.onReference({ lastUpdateId: 11, bids: [["0.49", "1"], ["0.48", "5000"]], asks: [["0.52", "3200"]] }, book, 0),
    ).toBeNull();
    book.applyDelta(10, 11, [["0.49", "1"]], []);
    expect(check.onBookAdvanced(book, 0)).toBe("match");
  });

  it("reports a pass right after a mismatch as healed", () => {
    const book = bookAt(10);
    const check = new IntegrityChecker();
    const truth = { bids: [["0.48", "5000"]] as [string, string][], asks: [["0.52", "3200"]] as [string, string][] };
    expect(check.onReference({ lastUpdateId: 10, bids: [["0.48", "9"]], asks: truth.asks }, book, 0)).toBe("mismatch");
    // A later update lands and the book matches again, with no rebuild.
    book.applyDelta(10, 11, [], []);
    expect(check.onReference({ lastUpdateId: 11, ...truth }, book, 0)).toBe("healed");
    expect(check.stats).toMatchObject({ matched: 1, mismatched: 1, healed: 1 });
    expect(check.stats.history).toEqual(["mismatch", "healed"]);
    // Once healed, the next pass is an ordinary match.
    book.applyDelta(11, 12, [], []);
    expect(check.onReference({ lastUpdateId: 12, ...truth }, book, 0)).toBe("match");
  });

  it("does not call a pass on a rebuilt book healed", () => {
    const check = new IntegrityChecker();
    check.onReference({ lastUpdateId: 10, bids: [["0.48", "9"]], asks: [["0.52", "3200"]] }, bookAt(10), 0);
    check.resetPending(); // a new book starts building
    const result = check.onReference(
      { lastUpdateId: 20, bids: [["0.48", "5000"]], asks: [["0.52", "3200"]] },
      bookAt(20),
      0,
    );
    expect(result).toBe("match");
    expect(check.stats.healed).toBe(0);
  });

  it("skips a reference the book jumped past, never counting it as a pass", () => {
    const book = bookAt(10);
    const check = new IntegrityChecker();
    check.onReference({ lastUpdateId: 11, bids: [], asks: [] }, book, 0);
    book.applyDelta(10, 12, [], []);
    expect(check.onBookAdvanced(book, 0)).toBeNull();
    expect(check.stats.skipped).toBe(1);
    expect(check.stats.matched).toBe(0);
  });
});
