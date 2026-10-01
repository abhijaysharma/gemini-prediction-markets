import { describe, expect, it } from "vitest";
import {
  fillPnlPerDay,
  fillStats,
  makerPnlCents,
  MarkoutTracker,
  MIN_TRADES,
  yourFillsPerDay,
  type FillRecord,
} from "../server/src/rewards/markout";

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

  it("fills a quote at the back of the queue only with what's left of each trade", () => {
    const hour = 3_600_000;
    // 50 resting ahead of a 100-lot. A 30-lot never reaches us, an 80-lot leaves us 30,
    // and a 1,000-lot fills all 100 of ours but no more: 130 contracts in an hour.
    expect(yourFillsPerDay([30, 80, 1000], hour, 100, 50)).toBeCloseTo(130 * 24, 9);
    // Nothing ahead of us: every trade reaches us, capped at our size.
    expect(yourFillsPerDay([30, 80, 1000], hour, 100, 0)).toBeCloseTo((30 + 80 + 100) * 24, 9);
    expect(yourFillsPerDay([30], 0, 100, 0)).toBe(0);
  });

  it("estimates nothing until there are enough trades", () => {
    const few = fillStats(Array.from({ length: MIN_TRADES - 1 }, () => fill({ markoutCents: [0, 0, -2] })));
    expect(fillPnlPerDay(few, 500)).toBeNull();
  });

  it("turns fills and markout into dollars a day", () => {
    const enough = fillStats(Array.from({ length: MIN_TRADES }, () => fill({ markoutCents: [0, 0, -2] })));
    // 500 of our contracts filled a day at -2c each: -$10 a day.
    expect(fillPnlPerDay(enough, 500)).toBeCloseTo(-10, 9);
  });
});
