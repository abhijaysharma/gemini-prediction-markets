import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockExchange } from "../server/src/mock/exchange";
import { samplePool, summarize } from "../server/src/rewards/estimate";
import { collectContracts, groupPools } from "../server/src/rewards/pools";
import { estimateRewards } from "../server/src/rewards/run";
import { competingScore, quoteScore, spreadWeight, topOfBook, TWO_SIDED_MULTIPLIER } from "../server/src/rewards/scoring";
import type { Level } from "../server/src/types";

describe("reward scoring", () => {
  it("reproduces the docs' worked example", () => {
    // Mid 0.505, max spread 10c. A quotes both sides, B quotes both sides far
    // out (its bid is past the limit), C quotes one side. Docs: ~74% / ~5% / ~21%.
    const legs = {
      A: [[2.5, 50], [1.5, 50]],
      B: [[10.5, 200], [9.5, 200]],
      C: [[1.5, 30]],
    } as Record<string, [number, number][]>;
    const score = (m: string) => {
      const scored = legs[m].map(([d, q]) => q * spreadWeight(d, 10));
      const twoSided = scored.length === 2 && scored.every((s) => s > 0);
      return scored.reduce((a, b) => a + b, 0) * (twoSided ? TWO_SIDED_MULTIPLIER : 1);
    };
    const total = score("A") + score("B") + score("C");
    expect((score("A") / total) * 100).toBeCloseTo(74, -0.5); // within ±1.6 points
    expect((score("B") / total) * 100).toBeCloseTo(5, -0.5);
    expect((score("C") / total) * 100).toBeCloseTo(21, -0.5);
    // "A quote 1.5c from the midpoint scores roughly 50x a quote 10c away."
    expect(spreadWeight(1.5, 10) / spreadWeight(10, 10)).toBeGreaterThan(40);
  });

  it("gives nothing past the max spread", () => {
    expect(spreadWeight(10.5, 10)).toBe(0);
    expect(spreadWeight(10, 10)).toBeGreaterThan(0);
    expect(spreadWeight(0, 10)).toBe(0);
  });

  it("scores a quote at the touch, with the two-sided bonus, only if the spread allows it", () => {
    // At the best bid and ask, both quotes sit half the spread from the mid,
    // so they qualify together or not at all.
    const tight = topOfBook([["0.49", "1"]], [["0.51", "1"]])!;
    expect(quoteScore(tight, 100, 250, 10)).toBeCloseTo((100 + 100) * TWO_SIDED_MULTIPLIER, 6);
    const wide = topOfBook([["0.30", "1"]], [["0.51", "1"]])!; // 21c spread: each side is 10.5c out
    expect(quoteScore(wide, 100, 250, 10)).toBe(0);
  });

  it("caps the size that counts", () => {
    const top = topOfBook([["0.49", "1"]], [["0.51", "1"]])!;
    expect(quoteScore(top, 1000, 250, 10)).toBe(quoteScore(top, 250, 250, 10));
  });

  it("scores resting size near the mid as competition", () => {
    const bids: Level[] = [["0.49", "100"], ["0.30", "1000"]]; // the second level is past 10c
    const asks: Level[] = [["0.51", "100"]];
    expect(competingScore(bids, asks, 0.5, 10)).toBeCloseTo((100 + 100) * TWO_SIDED_MULTIPLIER, 6);
  });

  it("treats a one-sided book as unscorable", () => {
    expect(topOfBook([["0.49", "1"]], [])).toBeNull();
  });
});

describe("reward pools", () => {
  it("groups events that share a pool, and treats overrides as pools of one", () => {
    // Shaped like the live API, where pool_id is a number.
    const pools = groupPools([
      { event_ticker: "BTC1", title: "a", daily_pool_usd: "150.00", pool_id: 70, pool_category_name: "Bitcoin", pool_source: "category_default", qualifying_maker_count: 2, ends_at: "x" },
      { event_ticker: "BTC2", title: "b", daily_pool_usd: "150.00", pool_id: 70, pool_category_name: "Bitcoin", pool_source: "category_default", qualifying_maker_count: 0, ends_at: "y" },
      { event_ticker: "SEN", title: "Delaware US Senate Winner", daily_pool_usd: "10.00", pool_source: "event_override", qualifying_maker_count: 5, ends_at: "z" },
    ]);
    expect(pools.map((p) => [p.id, p.name, p.dailyUsd, p.events.length])).toEqual([
      ["pool:70", "Bitcoin", 150, 2],
      ["event:SEN", "Delaware US Senate Winner", 10, 1],
    ]);
  });

  it("maps nested events to their open contracts", () => {
    const out = new Map<string, string[]>();
    collectContracts(
      [
        {
          ticker: "GAME",
          contracts: [{ instrumentSymbol: "G-A", marketState: "open" }, { instrumentSymbol: "G-B", marketState: "closed" }],
          events: [{ ticker: "GAME-SPREAD", contracts: [{ instrumentSymbol: "S-1", marketState: "open" }] }],
        },
      ],
      out,
    );
    expect(Object.fromEntries(out)).toEqual({ GAME: ["G-A"], "GAME-SPREAD": ["S-1"] });
  });
});

describe("pool estimates", () => {
  const plan = { size: 100, sizeCap: 250, maxSpreadCents: 10 };
  const book = (bid: string, ask: string, q = "100") => ({ bids: [[bid, q]] as Level[], asks: [[ask, q]] as Level[] });

  it("sums score across every contract in the pool", () => {
    // Two contracts, each with 100 resting on both sides at the touch: joining
    // with 100 more takes exactly half of the pool.
    const books: Record<string, ReturnType<typeof book>> = { X: book("0.49", "0.51"), Y: book("0.20", "0.22") };
    const s = samplePool(["X", "Y"], (sym) => books[sym], plan)!;
    expect(s.share).toBeCloseTo(0.5, 6);
    expect(s.contractsQuoted).toBe(2);
    expect(s.capital).toBeCloseTo(100 * 0.49 + 100 * 0.49 + 100 * 0.2 + 100 * 0.78, 6);
  });

  it("leaves out contracts with no book or a one-sided book", () => {
    const books: Record<string, { bids: Level[]; asks: Level[] }> = { X: book("0.49", "0.51"), Y: { bids: [["0.4", "5"]], asks: [] } };
    const s = samplePool(["X", "Y", "Z"], (sym) => books[sym], plan)!;
    expect([s.contractsQuoted, s.oneSided, s.noBook]).toEqual([1, 1, 1]);
  });

  it("returns null when nothing in the pool can be quoted", () => {
    expect(samplePool(["Z"], () => undefined, plan)).toBeNull();
  });

  it("turns samples into dollars per day per $1,000 of capital", () => {
    const pool = { id: "p", name: "P", dailyUsd: 100, category: null, source: "x", events: [{ ticker: "E", title: "e", qualifyingMakers: 4, endsAt: "" }] };
    const samples = [0.2, 0.3, 0.4].map((share) => ({ share, capital: 500, contractsQuoted: 1, oneSided: 0, noBook: 0 }));
    const e = summarize(pool, ["X"], samples, 1)!;
    expect(e.share).toBe(0.3);
    expect(e.estUsdPerDay).toBeCloseTo(30, 6);
    expect(e.usdPerDayPer1k).toBeCloseTo(60, 6);
    expect(e.maxMakers).toBe(4);
  });
});

describe("estimateRewards end to end", () => {
  let mock: MockExchange;
  let port: number;
  beforeEach(async () => {
    mock = new MockExchange({ tickMs: 20, seed: 3 });
    port = await mock.start();
  });
  afterEach(async () => {
    await mock.close();
  });

  it("ranks live pools from the mock's reward endpoints and depth20", async () => {
    const result = await estimateRewards({
      restUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
      size: 100,
      seconds: 1,
      sampleEveryMs: 200,
    });
    expect(result.maxSpreadCents).toBe(10);
    expect(result.subscribeFailures).toEqual([]);
    const ids = result.estimates.map((e) => e.pool.id).sort();
    expect(ids).toEqual(["event:ETH15M2610011015", "pool:7"]);
    const btc = result.estimates.find((e) => e.pool.id === "pool:7")!;
    // The upcoming window in the pool has no book yet, so only one of its two events is live.
    expect(btc.liveEvents).toBe(1);
    expect(btc.share).toBeGreaterThan(0);
    expect(btc.share).toBeLessThan(1);
    expect(btc.usdPerDayPer1k).toBeGreaterThan(0);
  }, 15_000);

  it("refuses a size below the program minimum", async () => {
    await expect(
      estimateRewards({ restUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}`, size: 5, seconds: 1 }),
    ).rejects.toThrow("at least 10");
  });
});
