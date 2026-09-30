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
    book.applyDelta(11, 11, [["0.40", "7"]], []);
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
    book.applyDelta(11, 11, [["0.49", "1"]], []);
    expect(check.onBookAdvanced(book, 0)).toBe("match");
  });

  it("skips a reference the book jumped past, never counting it as a pass", () => {
    const book = bookAt(10);
    const check = new IntegrityChecker();
    check.onReference({ lastUpdateId: 11, bids: [], asks: [] }, book, 0);
    book.applyDelta(11, 12, [], []);
    expect(check.onBookAdvanced(book, 0)).toBeNull();
    expect(check.stats.skipped).toBe(1);
    expect(check.stats.matched).toBe(0);
  });
});
