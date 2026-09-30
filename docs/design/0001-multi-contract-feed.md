# Design 0001: Many order books over shared connections

*Status: proposed. 2026-09-30.*

## Context

`FeedClient` maintains one book for one symbol, and owns its own WebSocket. Every planned feature needs many books at once:

- the coherence monitor ([finding 0001](../findings/0001-market-coherence.md)) compares every contract in a group;
- the implied-distribution view needs a whole strike ladder;
- the market health scoreboard ranks every live contract.

A group is typically 2–14 contracts, and the scoreboard wants dozens. This design changes how the feed is structured so that one process can hold many verified books, without weakening any guarantee the single-book version makes.

## Goals

- Hold N books, each with the same guarantees as today: snapshot plus sequenced deltas, gap detection, integrity checks against `depth20`, and automatic recovery.
- One book's failure must not disturb the others. A gap in book A rebuilds only A.
- Keep a single arrival order across books, so later features can reason about cross-book timing using the exchange-wide update IDs.
- Keep the current dashboard working unchanged, showing one "featured" book.
- Every step lands as a small pull request that keeps all tests passing.

## Non-goals

- A dashboard for many books. That comes with the features that need it.
- Coherence logic itself (design 0002).
- Trading, or any authenticated stream.

## Facts this design depends on

All observed on the live feed on 2026-09-30. The docs don't state items 3–6, so each gets a test against recorded live traffic and a runtime check that logs loudly if Gemini's behavior changes.

| # | Fact | How verified |
|---|---|---|
| 1 | One connection can carry many streams. 300 `SUBSCRIBE`s, one every 50 ms, were all acknowledged with 200, and there was no disconnect. | Probe script. `conninfo` returns no published limits. |
| 2 | Each delta's `U` equals the previous delta's `u` for that symbol. IDs are shared across the whole exchange. | 100+ consecutive frames across several contracts |
| 3 | A snapshot frame has `U == u`, and a delta has `U < u`. | 3 of 3 snapshots, 100+ deltas |
| 4 | After an `UNSUBSCRIBE` ack, no more frames arrive for that stream. Subscribing again sends a fresh snapshot, whose `u` is past the last delta seen. | Unsubscribe/resubscribe experiment |
| 5 | **The snapshot arrives before the `SUBSCRIBE` ack.** Subscribing twice to a stream already held returns 200 but sends **no** snapshot. | Same experiment, observed twice |
| 6 | `@depth20` frames include a `symbol` field. The docs' example omits it. | 392 frames, 2 symbols on one connection |
| 7 | `@depth20@100ms` arrives every 100 ms per symbol even when nothing changes. | Earlier live runs |

## Proposed structure

```
MarketData                  owns connections, assigns symbols to them, exposes sessions
├── Connection  (1..k)      one WebSocket: lifecycle, heartbeat, requests and acks,
│                           paced subscriptions, routing frames by symbol
└── BookSession (1..N)      one symbol: OrderBook + IntegrityChecker + recovery state,
                            counters, lag, fault injection
```

**`BookSession`** is today's `FeedClient` with the socket removed. `onDepth`, `onReference`, `handleIntegrity` and `onTrade` move over nearly unchanged. It no longer opens or closes connections. When it needs a rebuild, it asks its `Connection` to resubscribe it.

**`Connection`** is the transport half of today's `FeedClient`:
- connect, with exponential backoff and jitter;
- heartbeat `ping`, and a stale watchdog;
- request IDs and acks;
- routing each frame to a session by symbol, case-insensitive (`depthUpdate.s`, `depth20.symbol`, trade `s`);
- a subscription queue paced at 20 per second, the measured-safe rate, which backs off on a `-1003` rate-limit error.

**`MarketData`** places each symbol on a connection, up to `maxSymbolsPerConnection`, and creates a new connection when all are full. `App` uses it the way it uses `FeedClient` today, and picks one session as the featured book for the existing dashboard payload.

## Rebuilding one book on a shared connection

Today a resync opens a fresh connection. That's simple, and it guarantees no frame from the old subscription can arrive afterwards. With 50 books on one socket, it would throw away 49 healthy books to fix one. Instead:

1. The session enters `resyncing`, resets its book, and drops any depth frame that arrives for it.
2. The connection sends `UNSUBSCRIBE {sym}@depth@100ms` and waits for the ack. Fact 4: after the ack, nothing more arrives from that subscription.
3. The connection sends `SUBSCRIBE {sym}@depth@100ms`. The session is now `awaitingSnapshot`.
4. The first depth frame with `U == u` is the snapshot (fact 3). It is accepted **whether or not the ack has arrived yet**, because the snapshot comes first (fact 5). Deltas arriving before it are dropped and counted.
5. If no snapshot arrives within 5 s, retry from step 2. After three failed attempts, escalate to reconnecting the connection. The existing guard against rebuild loops (three rebuilds in 10 s trigger a 2 s backoff) moves into the session unchanged.

Step 2 is required, not an optimization: subscribing twice without unsubscribing returns 200 but sends no snapshot (fact 5), so the book would never rebuild.

**What we give up, and why it's still safe.** The fresh-connection approach needs no assumptions about the server. This one relies on the unsubscribe ordering (fact 4) and the `U == u` signal (fact 3). There are two backstops:
- A late frame from the old subscription would have `u` at or below the new snapshot's `u`, so `applyDelta` already classifies it as stale.
- If one slipped through anyway, the integrity check against `depth20` would catch the resulting wrong book.

**When a connection drops,** every session on it goes to `awaitingSnapshot`. The connection reconnects and resubscribes all of them, paced, and each book rebuilds from its own snapshot. Recovery time is recorded per book.

**Watchdog.** Staleness becomes a connection-level check. `depth20` arrives every 100 ms for every symbol (fact 7), so a connection with no frames at all for 30 s is dead. A book with no deltas is normal on a quiet market and triggers nothing.

## Load

Each full book subscribes to 3 streams: `depth@100ms`, `depth20@100ms` and `trade`. So `maxSymbolsPerConnection` defaults to **50** (150 streams), half the measured 300.

The reference stream dominates traffic: 10 messages per second per symbol, so about 500 per second for 50 books. That's fine for Node, but it's real JSON parsing, so the scoreboard's "many books" mode will report messages per second per connection. We'll measure before optimizing.

## Fault injection

Drop and corrupt become per-session, and "cut the connection" becomes per-connection. The dashboard's buttons act on the featured book and its connection, so they behave exactly as today.

## Alternatives considered

**One `FeedClient` (and one socket) per symbol.** This carries no risk to the engine and keeps the fresh-connection resync. But:
- 50+ sockets means 50+ TLS handshakes in any reconnect storm, against limits we can't see;
- there is no single arrival order across books;
- it multiplies the heartbeat traffic.

It remains available as a degenerate configuration (`maxSymbolsPerConnection: 1`), which is also a useful fallback if facts 3–5 ever stop holding.

**Unsubscribe everything and resubscribe on any gap.** This is simpler, but one flaky quiet contract would keep resetting every busy book. It violates goal 2.

## Migration plan

Each step is one pull request, and all tests pass after each.

1. **Real-traffic fixtures.**
   - Update `scripts/record.ts`: several symbols, `depth20`, the corrected gap rule, and time stamps relative to the start of the recording.
   - Add a replay server that serves a recording over the same protocol as the mock.
   - Commit two short recordings, a busy book and a quiet one, and add tests that replay them through the current `FeedClient`. This happens *before* the refactor, so the refactor is checked against real traffic, not only against our own mock.
2. **CI.** A GitHub Actions workflow runs typecheck, tests and build on every push and pull request. It adds no new dependencies.
3. **Mock parity.** Teach the mock facts 3–6: the snapshot before the ack, `U == u` snapshots, unsubscribe and resubscribe semantics, and `symbol` on `depth20`. Add a test for each.
4. **Extract `BookSession`** from `FeedClient`, with no change in behavior. `FeedClient` becomes a single-session wrapper.
5. **`Connection` and `MarketData`,** with per-book resync. New tests:
   - one book rebuilds while the others keep streaming, with their `lastUpdateId`s advancing throughout;
   - a connection drop rebuilds every book;
   - a stale frame injected after the unsubscribe ack is rejected;
   - symbol routing is case-insensitive;
   - the snapshot timeout escalates.
6. **Switch `App` to `MarketData`,** with one featured session. The dashboard is unchanged.

## Open questions

- **Real limits.** Per-connection subscription and message-rate limits aren't published. We tested 300 subscriptions at 20 per second, and we won't probe harder against a production exchange. The design keeps both as configuration.
- **Duplicate snapshots.** Could a snapshot and a delta ever carry the same `u`? Not observed. The session would treat that frame as stale, which is correct either way.
- **When to drop the trade stream.** Most books only need depth. Making `trade` subscription optional per session would cut a third of the streams. That's deferred until the scoreboard shows whether it matters.
