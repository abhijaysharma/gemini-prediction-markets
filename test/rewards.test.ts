import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FillStore } from "../server/src/rewards/fillstore";
import { MockExchange } from "../server/src/mock/exchange";
import { medianSample, outlook, samplePool, shareFor } from "../server/src/rewards/estimate";
import { collectContracts, groupPools } from "../server/src/rewards/pools";
import { estimateRewards } from "../server/src/rewards/run";
import { RewardsTracker } from "../server/src/rewards/tracker";
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
  const book = (bid: string, ask: string, q = "100") => ({ bids: [[bid, q]] as Level[], asks: [[ask, q]] as Level[] });

  it("sums score across every contract in the pool", () => {
    // Two contracts, each with 100 resting on both sides at the touch: joining
    // with 100 more takes exactly half of the pool.
    const books: Record<string, ReturnType<typeof book>> = { X: book("0.49", "0.51"), Y: book("0.20", "0.22") };
    const s = samplePool(["X", "Y"], (sym) => books[sym], 10)!;
    expect(shareFor(s, { size: 100, sizeCap: 250 })).toBeCloseTo(0.5, 6);
    expect(s.contractsQuoted).toBe(2);
    expect(s.capitalPerContract).toBeCloseTo(0.49 + 0.49 + 0.2 + 0.78, 6);
  });

  it("answers any quote size from one measurement", () => {
    const s = samplePool(["X"], () => book("0.49", "0.51"), 10)!;
    expect(shareFor(s, { size: 100, sizeCap: 250 })).toBeCloseTo(1 / 2, 6);
    expect(shareFor(s, { size: 200, sizeCap: 250 })).toBeCloseTo(2 / 3, 6);
    // Past the per-maker cap, more size earns nothing more.
    expect(shareFor(s, { size: 1000, sizeCap: 250 })).toBeCloseTo(shareFor(s, { size: 250, sizeCap: 250 }), 9);
  });

  it("leaves out contracts with no book or a one-sided book", () => {
    const books: Record<string, { bids: Level[]; asks: Level[] }> = { X: book("0.49", "0.51"), Y: { bids: [["0.4", "5"]], asks: [] } };
    const s = samplePool(["X", "Y", "Z"], (sym) => books[sym], 10)!;
    expect([s.contractsQuoted, s.oneSided, s.noBook]).toEqual([1, 1, 1]);
  });

  it("returns null when nothing in the pool can be quoted", () => {
    expect(samplePool(["Z"], () => undefined, 10)).toBeNull();
  });

  it("turns a sample into dollars per day per $1,000 of capital", () => {
    // quoteWeight 1, competing 100: a 100-lot takes half.
    const o = outlook({ quoteWeight: 1, competing: 100, capitalPerContract: 2 }, 60, { size: 100, sizeCap: 250 });
    expect(o.share).toBeCloseTo(0.5, 9);
    expect(o.estUsdPerDay).toBeCloseTo(30, 9);
    expect(o.capital).toBeCloseTo(200, 9);
    expect(o.usdPerDayPer1k).toBeCloseTo(150, 9);
  });

  it("takes medians field by field", () => {
    const mk = (quoteWeight: number, competing: number) => ({ quoteWeight, competing, capitalPerContract: 1, touchSize: 1, contractsQuoted: 1, oneSided: 0, noBook: 0 });
    expect(medianSample([mk(1, 50), mk(3, 10), mk(2, 1000)])).toMatchObject({ quoteWeight: 2, competing: 50 });
  });
});

describe("rewards against the mock exchange", () => {
  let mock: MockExchange;
  let port: number;
  beforeEach(async () => {
    mock = new MockExchange({ tickMs: 20, seed: 3 });
    port = await mock.start();
  });
  afterEach(async () => {
    await mock.close();
  });

  it("ranks live pools from the reward endpoints and depth20", async () => {
    const result = await estimateRewards({
      restUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
      size: 100,
      seconds: 1,
      sampleEveryMs: 100,
      stream: "depth20@100ms",
    });
    expect(result.maxSpreadCents).toBe(10);
    expect(result.failedSubscriptions).toBe(0);
    expect(result.ranked.map((r) => r.pool.id).sort()).toEqual(["event:ETH15M2610011015", "pool:7"]);
    const btc = result.ranked.find((r) => r.pool.id === "pool:7")!;
    // The upcoming window in the pool has no contracts open yet, so one of its two events is live.
    expect([btc.pool.liveEvents, btc.pool.totalEvents]).toEqual([1, 2]);
    expect(btc.share).toBeGreaterThan(0);
    expect(btc.share).toBeLessThan(1);
    expect(btc.usdPerDayPer1k).toBeGreaterThan(0);
  }, 15_000);

  it("records a trend point each interval and looks up events it hasn't seen", async () => {
    const tracker = new RewardsTracker({
      restUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
      stream: "depth20@100ms",
      sampleEveryMs: 50,
      windowSize: 5,
      minuteMs: 300,
    });
    try {
      expect(tracker.state().status).toBe("idle");
      tracker.ensureStarted();
      await waitFor(() => tracker.state().pools.some((p) => (p.history.length ?? 0) >= 2), 8000);
      const state = tracker.state();
      expect(state.status).toBe("ready");
      expect(state.contractsWatched).toBe(3);
      const btc = state.pools.find((p) => p.id === "pool:7")!;
      expect(btc.now).not.toBeNull();
      expect(btc.history[0].quoteWeight).toBeGreaterThan(0);
      // The upcoming window wasn't in the start-up listing, so the refresh asked for it by name.
      expect(mock.requests).toContain("/v1/prediction-markets/events/BTC05M2610011005");
    } finally {
      tracker.stop();
    }
  }, 15_000);

  it("works with the defaults the dashboard uses (the once-a-second depth20 stream)", async () => {
    const tracker = new RewardsTracker({ restUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` });
    try {
      await tracker.start();
      await waitFor(() => tracker.state().pools.every((p) => p.now !== null), 6000);
      expect(tracker.state().failedSubscriptions).toBe(0);
    } finally {
      tracker.stop();
    }
  }, 10_000);

  it("marks out real fills, saves them, and loads them again after a restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fills-"));
    const fillsFile = path.join(dir, "fills.ndjson");
    const opts = {
      restUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
      stream: "depth20@100ms" as const,
      sampleEveryMs: 50,
      horizonsS: [0.1, 0.2, 0.3], // seconds, so the test needn't wait a minute
      minObserveMs: 0,
      fillsFile,
    };
    const first = new RewardsTracker(opts);
    try {
      await first.start();
      await waitFor(() => first.state().pools.some((p) => p.fills.trades >= 3), 10_000);
      const btc = first.state().pools.find((p) => p.fills.trades >= 3)!.fills;
      expect(btc.markoutCents.every((m) => m !== null)).toBe(true);
      expect(btc.runTradeSizes.length).toBeGreaterThanOrEqual(3);
      expect(btc.enoughObserved).toBe(true);
    } finally {
      first.stop();
    }
    const saved = readFileSync(fillsFile, "utf8").trim().split("\n").length;
    expect(saved).toBeGreaterThanOrEqual(3);

    const second = new RewardsTracker(opts);
    try {
      await second.start();
      // Before the new run has seen a single trade, the saved ones are already counted.
      expect(second.state().pools.reduce((n, p) => n + p.fills.trades, 0)).toBeGreaterThanOrEqual(saved);
    } finally {
      second.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses a size below the program minimum", async () => {
    await expect(
      estimateRewards({ restUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}`, size: 5, seconds: 1 }),
    ).rejects.toThrow("at least 10");
  });
});

async function waitFor(cond: () => boolean, timeoutMs: number) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("fill store", () => {
  it("keeps a week of fills, and drops older and half-written lines", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fills-"));
    const file = path.join(dir, "fills.ndjson");
    const now = Date.UTC(2026, 9, 10);
    const rec = (daysAgo: number) =>
      JSON.stringify({ poolId: "p", symbol: "X", at: now - daysAgo * 86_400_000, price: 0.5, qty: 1, takerBuy: true, markoutCents: [0, 0, 0] });
    writeFileSync(file, [rec(1), rec(8), '{"poolId":"p","sym'].join("\n") + "\n");
    const store = new FillStore(file);
    expect(store.load(now).map((r) => r.at)).toEqual([now - 86_400_000]);
    // The file was rewritten without the stale and broken lines.
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
