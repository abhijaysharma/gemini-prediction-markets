import { describe, expect, it } from "vitest";
import { fillPnlPerDay, fillStats, makerPnlCents, MarkoutTracker, MIN_TRADES, type FillRecord } from "../server/src/rewards/markout";

const fill = (over: Partial<FillRecord> = {}): FillRecord => ({
  poolId: "p",
  symbol: "X",
  at: 0,
  price: 0.5,
  qty: 1,
  takerBuy: true,
  markoutCents: [0, 0, 0],
  ...over,
});

describe("markout", () => {
  it("scores the maker's side of a trade", () => {
    // A taker bought at 51c, so a maker sold at 51c: the mid falling to 48c is +3c for the maker.
    expect(makerPnlCents({ price: 0.51, takerBuy: true }, 0.48)).toBeCloseTo(3, 9);
    // A taker sold at 49c, so a maker bought: the mid falling to 45c is -4c for the maker.
    expect(makerPnlCents({ price: 0.49, takerBuy: false }, 0.45)).toBeCloseTo(-4, 9);
  });

  it("marks each horizon once it has passed, and releases the fill after the last", () => {
    const m = new MarkoutTracker();
    m.add({ poolId: "p", symbol: "X", at: 0, price: 0.51, qty: 10, takerBuy: true });
    let mid = 0.5;
    expect(m.resolve(4_000, () => mid)).toEqual([]);
    expect(m.resolve(5_000, () => mid)).toEqual([]); // 5 s horizon marked at +1c
    mid = 0.55;
    expect(m.resolve(30_000, () => mid)).toEqual([]); // 30 s at -4c
    mid = 0.6;
    const [done] = m.resolve(60_000, () => mid); // 60 s at -9c
    expect(done.markoutCents.map((c) => Math.round(c! * 100) / 100)).toEqual([1, -4, -9]);
    expect(m.pendingCount).toBe(0);
  });

  it("gives up on a horizon with no mid instead of holding the fill forever", () => {
    const m = new MarkoutTracker();
    m.add({ poolId: "p", symbol: "X", at: 0, price: 0.5, qty: 1, takerBuy: true });
    expect(m.resolve(65_000, () => undefined)).toEqual([]);
    const [done] = m.resolve(70_000, () => undefined);
    expect(done.markoutCents).toEqual([null, null, null]);
  });

  it("weights by size and reports a standard error per trade", () => {
    const s = fillStats([fill({ qty: 3, markoutCents: [0, 0, -2] }), fill({ qty: 1, markoutCents: [0, 0, 2] })]);
    expect(s.trades).toBe(2);
    expect(s.contracts).toBe(4);
    expect(s.markoutCents[2]).toBeCloseTo(-1, 9); // (3 × -2 + 1 × 2) / 4
    // Weighted variance (3·1 + 1·9) / 4 = 3, over 2 trades: sqrt(1.5).
    expect(s.se60).toBeCloseTo(Math.sqrt(1.5), 9);
  });

  it("estimates nothing until there are enough trades", () => {
    const few = fillStats(Array.from({ length: MIN_TRADES - 1 }, () => fill({ markoutCents: [0, 0, -2] })));
    expect(fillPnlPerDay(few, 1000, 100, 100)).toBeNull();
  });

  it("turns markout, volume and queue share into dollars a day", () => {
    const enough = fillStats(Array.from({ length: MIN_TRADES }, () => fill({ markoutCents: [0, 0, -2] })));
    // 1,000 contracts a day, half of each fill is ours, -2c each: -$10 a day.
    expect(fillPnlPerDay(enough, 1000, 100, 100)).toBeCloseTo(-10, 9);
  });
});
