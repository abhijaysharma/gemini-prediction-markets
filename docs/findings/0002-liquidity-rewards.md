# Finding 0002: What would a market maker earn from Gemini's liquidity rewards?

*Measured 2026-09-30, 23:30–00:00 UTC, from public endpoints only.*

## Question

Gemini pays daily USD pools to makers who keep quotes resting near the midpoint ([program rules](https://developer.gemini.com/prediction-markets/liquidity-rewards-program)). The pools and the order books are both public. Can we estimate, before posting a single order, what a given quote would earn in each pool?

## What's public

- `GET /v1/prediction-markets/liquidity-rewards/config` returns `max_spread_cents: 10`.
- `GET /v1/prediction-markets/liquidity-rewards/events` lists every event in the program (321 at the time) with `daily_pool_usd`, `pool_id`, `pool_event_count`, recurrence and `qualifying_maker_count`.
- The order book near the mid, from `@depth20@100ms`.

Per-maker scores and payouts are only available to the authenticated maker.

## How pools are shared

A pool is not per event. The Bitcoin pool, for example, is **$150/day shared across every 5-minute BTC event that day** (`recurring_duration: 5 MINUTES`), and the Politics pool is $50/day across 207 events. The listing also includes upcoming events, which have no book yet and show 0 qualifying makers. An earlier reading of "$150/day with 0 makers" was wrong for exactly this reason: the event running at the time had 5.

There were 25 distinct pools, worth about $915/day in total.

## The scoring curve

The docs give the snapshot score as `spread weight × size × two-sided multiplier`, with a spread weight that is only described as "a quadratic curve". We fit candidate curves to the docs' worked example (mid $0.505; Maker A quoting both sides 1.5–2.5¢ away, Maker B both sides 9.5–10.5¢ away, Maker C one side at 1.5¢; documented shares ~74% / ~5% / ~21%):

| Weight at distance d (cents) | A | B | C | w(1.5) / w(10) |
|---|---|---|---|---|
| **1 / d²** | **73.1%** | **5.4%** | **21.5%** | **44×** |
| (1 − d/10)² | 81.1% | 0.6% | 18.2% | ∞ |
| (11 − d)² | 78.3% | 4.3% | 17.4% | 90× |
| (12 − d)² | 74.4% | 9.3% | 16.4% | 28× |

(This table gives B the two-sided bonus even though its bid is past the 10¢ limit. Under the stricter reading of the rules, where the bonus needs both quotes to qualify, `1/d²` gives 74.4% / 3.6% / 21.9%. The estimator follows the stricter reading.)

`1/d²`, zero beyond 10¢, reproduces all three shares within about 1.5 points under either reading, and matches the docs' separate remark that a quote 1.5¢ from mid "scores roughly 50× a quote 10¢ away". It is the model we use. It is still a fit, not a published formula. One open question is its behavior near d = 0, since a quote can't sit closer than half a tick from the mid.

## Estimating a share from the public book

For each contract, we sum `size × w(distance)` over every resting level within 10¢ of the mid, then compare that total with the score of a hypothetical quote. Two unknowns are resolved conservatively, so the estimate understates what you'd earn:

- **Size cap.** The book aggregates makers at each price, so the 250-contract cap per maker can't be applied. Counting all resting size overstates competition.
- **Two-sided bonus.** Every competitor is assumed to earn the 1.5× bonus.

Contracts with a one-sided book are skipped.

## Results

60 seconds of `depth20`, sampled once a second, for a hypothetical quote of 100 contracts at the best bid and best ask on every two-sided contract in the event:

| Pool (event measured) | Pool | Qualifying makers | Median share | Range | Est. $/day | Capital |
|---|---|---|---|---|---|---|
| Zcash (ZEC Oct 1, 7 contracts) | $150/day, 3 events | 2 | 29.4% | 26.3–33.0% | ~$44 | ~$679 |
| Bitcoin (BTC Oct 1, 7 contracts) | $150/day, 23 events | 2 | 8.9% | 8.3–9.6% | ~$13 | ~$675 |
| Ether (ETH Oct 1, 5 of 8 contracts) | $100/day, 23 events | 2 | 7.8% | 4.3–9.8% | ~$8 | ~$489 |
| Politics (TX-23 House, 2 contracts) | $50/day, 207 events | 3 | 62.8% | — | not meaningful | ~$191 |

The dollar figures assume the measured event is representative of its pool. That is reasonable for Zcash, where the pool covers 3 events, and not at all for Politics, where one event is 1 of 207. A real estimate has to measure every event in a pool.

## Conclusion

Pools differ by several times in what the same quote would earn, and that difference is visible from public data. That makes a ranking tool genuinely useful to a market maker deciding where to quote.

Two limits keep it honest:
- **It's an estimate.** The curve is a fit and the book hides individual makers.
- **Rewards are not profit.** A resting quote carries inventory risk. On short-dated crypto contracts, a maker gets filled mostly when the price is about to move against them. The tool should show that risk next to the reward, not hide it.
