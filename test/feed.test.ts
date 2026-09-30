import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedClient } from "../server/src/feed";
import { MockExchange, MOCK_SYMBOLS } from "../server/src/mock/exchange";

// End-to-end: the real FeedClient against the mock exchange over real sockets.
// The mock keeps the "true" book, so we can check the client's copy exactly.

const SYMBOL = MOCK_SYMBOLS[0].symbol;
let mock: MockExchange;
let feed: FeedClient;

async function waitFor(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Freeze the mock, let in-flight frames land, then compare full books. */
async function expectBooksEqual() {
  mock.pause();
  await waitFor(() => feed.book.lastUpdateId === mock.lastUpdateId(SYMBOL));
  const truth = mock.book(SYMBOL);
  expect(feed.book.topBids()).toEqual(truth.bids);
  expect(feed.book.topAsks()).toEqual(truth.asks);
  mock.resume();
}

beforeEach(async () => {
  mock = new MockExchange({ tickMs: 15, seed: 7 });
  const port = await mock.start();
  feed = new FeedClient({ url: `ws://127.0.0.1:${port}`, quiet: true, pingMs: 200, staleMs: 1000 });
});

afterEach(async () => {
  feed.stop();
  await mock.close();
});

describe("FeedClient", () => {
  it("builds a book from the snapshot and keeps it exactly in sync", async () => {
    feed.start(SYMBOL);
    await waitFor(() => feed.state === "live" && feed.counters.depthUpdates > 30);
    await expectBooksEqual();
    expect(feed.counters.gaps).toBe(0);
  });

  it("passes integrity checks against the reference stream", async () => {
    feed.start(SYMBOL);
    await waitFor(() => feed.integrity.stats.matched >= 10);
    expect(feed.integrity.stats.mismatched).toBe(0);
  });

  it("detects dropped updates, resyncs, and ends with a correct book", async () => {
    feed.start(SYMBOL);
    await waitFor(() => feed.state === "live" && feed.counters.depthUpdates > 10);
    feed.dropNext(3);
    await waitFor(() => feed.counters.resyncs >= 1);
    expect(feed.counters.gaps).toBe(1);
    await waitFor(() => feed.state === "live" && feed.recoveries.length >= 1);
    await waitFor(() => feed.counters.depthUpdates > 60);
    await expectBooksEqual();
  });

  it("detects a gap caused by the exchange side", async () => {
    feed.start(SYMBOL);
    await waitFor(() => feed.state === "live" && feed.counters.depthUpdates > 10);
    mock.injectGap(SYMBOL, 4);
    await waitFor(() => feed.counters.gaps >= 1 && feed.state === "live");
    await expectBooksEqual();
  });

  it("reconnects after the connection is cut", async () => {
    feed.start(SYMBOL);
    await waitFor(() => feed.state === "live");
    feed.killConnection();
    await waitFor(() => feed.counters.reconnects >= 1);
    await waitFor(() => feed.state === "live" && feed.recoveries.length >= 1);
    await expectBooksEqual();
  });

  it("recovers when the exchange drops every connection", async () => {
    feed.start(SYMBOL);
    await waitFor(() => feed.state === "live");
    mock.disconnectAll();
    await waitFor(() => feed.counters.reconnects >= 1 && feed.state === "live");
    await expectBooksEqual();
  });

  it("switches symbols cleanly", async () => {
    feed.start(SYMBOL);
    await waitFor(() => feed.state === "live");
    feed.setSymbol(MOCK_SYMBOLS[2].symbol);
    await waitFor(() => feed.state === "live" && feed.symbol === MOCK_SYMBOLS[2].symbol);
    mock.pause();
    const other = MOCK_SYMBOLS[2].symbol;
    await waitFor(() => feed.book.lastUpdateId === mock.lastUpdateId(other));
    expect(feed.book.topBids()).toEqual(mock.book(other).bids);
    mock.resume();
  });

  it("reports a failed subscription instead of failing silently", async () => {
    feed.start("NOT-A-REAL-SYMBOL");
    await waitFor(() => feed.log.some((l) => l.msg.includes("failed: 400")));
  });
});

describe("FeedClient fault handling", () => {
  it("catches silent corruption with the integrity check and rebuilds", async () => {
    feed.start(SYMBOL);
    await waitFor(() => feed.integrity.stats.matched >= 3);
    mock.pause(); // no new deltas, so nothing can overwrite the corrupted level
    feed.corruptBook();
    mock.resume();
    await waitFor(() => feed.integrity.stats.mismatched >= 1);
    await waitFor(() => feed.counters.resyncs >= 1 && feed.state === "live");
    expect(feed.counters.gaps).toBe(0); // sequence numbers never noticed
    await expectBooksEqual();
  });

  it("does not carry leftover dropped updates into a new connection", async () => {
    feed.start(SYMBOL);
    await waitFor(() => feed.state === "live");
    feed.dropNext(10_000);
    feed.killConnection();
    await waitFor(() => feed.state === "live" && feed.recoveries.length >= 1);
    const before = feed.counters.droppedByChaos;
    await waitFor(() => feed.counters.depthUpdates > 40);
    expect(feed.counters.droppedByChaos).toBe(before);
  });
});

// Live Gemini markets can sit for minutes with no book changes. depth20
// snapshots still arrive every 100 ms, but no deltas do.
describe("FeedClient on a quiet market", () => {
  it("stays live without deltas, and still catches corruption", async () => {
    mock.setQuiet(true);
    feed.start(SYMBOL);
    await waitFor(() => feed.state === "live");
    // Longer than staleMs: depth20 frames keep the watchdog satisfied.
    await new Promise((r) => setTimeout(r, 1200));
    expect(feed.counters.resyncs).toBe(0);

    feed.corruptBook();
    await waitFor(() => feed.counters.resyncs >= 1 && feed.state === "live");
    expect(feed.counters.gaps).toBe(0);
    await expectBooksEqual();
  });

  it("holds a dropped-update fault until real deltas arrive", async () => {
    mock.setQuiet(true);
    feed.start(SYMBOL);
    await waitFor(() => feed.state === "live");
    feed.dropNext(3);
    await new Promise((r) => setTimeout(r, 300));
    expect(feed.counters.droppedByChaos).toBe(0);
    expect(feed.counters.gaps).toBe(0);

    mock.setQuiet(false);
    await waitFor(() => feed.counters.gaps === 1 && feed.state === "live" && feed.recoveries.length >= 1);
    expect(feed.counters.droppedByChaos).toBe(3);
    await expectBooksEqual();
  });
});
