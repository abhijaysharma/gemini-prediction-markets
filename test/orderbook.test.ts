import { describe, expect, it } from "vitest";
import { isZero, normDecimal } from "../server/src/decimal";
import { OrderBook } from "../server/src/orderbook";

describe("normDecimal", () => {
  it("canonicalizes equivalent decimal strings", () => {
    expect(normDecimal("0.480")).toBe("0.48");
    expect(normDecimal("0.48")).toBe("0.48");
    expect(normDecimal("5000")).toBe("5000");
    expect(normDecimal("5000.00")).toBe("5000");
    expect(normDecimal("007.10")).toBe("7.1");
    expect(normDecimal(".5")).toBe("0.5");
  });

  it("detects zero quantities in any form", () => {
    expect(isZero("0")).toBe(true);
    expect(isZero("0.00")).toBe(true);
    expect(isZero("0.01")).toBe(false);
  });
});

describe("OrderBook", () => {
  const seed = () => {
    const book = new OrderBook();
    book.applySnapshot(
      [["0.48", "5000"], ["0.47", "200"]],
      [["0.52", "3200"], ["0.55", "10"]],
      100,
    );
    return book;
  };

  it("applies a snapshot and sorts levels numerically", () => {
    const book = new OrderBook();
    book.applySnapshot([["0.9", "1"], ["0.10", "1"], ["0.09", "1"]], [["0.95", "1"]], 1);
    expect(book.topBids().map(([p]) => p)).toEqual(["0.9", "0.1", "0.09"]);
    expect(book.bestBid()).toBe("0.9");
    expect(book.bestAsk()).toBe("0.95");
  });

  it("applies a contiguous delta", () => {
    const book = seed();
    expect(book.applyDelta(101, 103, [["0.49", "100"]], [["0.52", "3000"]])).toBe("applied");
    expect(book.lastUpdateId).toBe(103);
    expect(book.bestBid()).toBe("0.49");
    expect(book.topAsks(1)).toEqual([["0.52", "3000"]]);
  });

  it("removes a level when quantity is zero", () => {
    const book = seed();
    book.applyDelta(101, 101, [["0.48", "0.00"]], []);
    expect(book.bestBid()).toBe("0.47");
    expect(book.bidCount).toBe(1);
  });

  it("treats differently formatted prices as the same level", () => {
    const book = seed();
    book.applyDelta(101, 101, [["0.480", "0"]], []);
    expect(book.bestBid()).toBe("0.47");
  });

  it("ignores stale frames it has already applied", () => {
    const book = seed();
    expect(book.applyDelta(90, 100, [["0.10", "1"]], [])).toBe("stale");
    expect(book.bidCount).toBe(2);
    expect(book.lastUpdateId).toBe(100);
  });

  it("accepts a frame that partially overlaps what it has seen", () => {
    const book = seed();
    expect(book.applyDelta(99, 102, [["0.49", "1"]], [])).toBe("applied");
    expect(book.lastUpdateId).toBe(102);
  });

  it("reports a gap and leaves the book untouched", () => {
    const book = seed();
    expect(book.applyDelta(103, 105, [["0.49", "1"]], [])).toBe("gap");
    expect(book.lastUpdateId).toBe(100);
    expect(book.bestBid()).toBe("0.48");
  });

  it("detects a crossed book", () => {
    const book = seed();
    expect(book.isCrossed()).toBe(false);
    book.applyDelta(101, 101, [["0.53", "1"]], []);
    expect(book.isCrossed()).toBe(true);
  });

  it("refuses deltas before a snapshot", () => {
    expect(() => new OrderBook().applyDelta(1, 1, [], [])).toThrow();
  });
});
