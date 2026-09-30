# Finding 0001: Are Gemini's prediction markets internally coherent?

*Measured 2026-09-30, 20:30–23:10 UTC, from public market data only.*

## Question

Related contracts constrain each other. If exactly one outcome of an event can resolve YES, the YES prices across its outcomes should sum to about $1. If a contract pays when BTC ends above $92,500, it can never be worth more than one that pays above $90,000. Before building a monitor for these constraints, we wanted to know how often live prices actually break them, and whether a break would survive fees.

## What the constraints are

**Mutually exclusive groups.** Gemini defines these as events where exactly one contract resolves YES: sports winners, weather brackets, crypto price ranges ([Collateral Return](https://developer.gemini.com/prediction-markets/collateral-return)).

- Selling YES on every outcome (buying NO on each) pays at least `n − 1`, because at most one outcome wins. It locks in a profit when the best bids sum to more than 1. This only needs the outcomes to be **exclusive**.
- Buying YES on every outcome pays exactly 1. It locks in a profit when the best asks sum to less than 1. This also needs the list to be **exhaustive**, which a 112-player golf field may not be.

**Ordered ladders.** For "above K" contracts, P(above K) can only fall as K rises. A violation is a higher strike's bid above a lower strike's ask: buying YES on the lower strike and NO on the higher one then pays at least 1 in every outcome. The same holds for "over X.5" totals, and in reverse for "below K".

## Identifying groups from the API

The events endpoint marks both structures, but not everywhere:

| Signal | Meaning |
|---|---|
| `template: "sports-game"`, `"sports-golf"` | Mutually exclusive winner markets, including 3-way ones with a tie contract (`-D`) |
| `strike.type: "above"`, `"over"`, `"below"` with `strike.value` | Ordered ladder rungs |
| `template: null` | Mixed: real winner markets (House races, awards) **and** ladders whose strike exists only in the symbol, such as `...-ABOVE55` with `strike: null` |

So the monitor trusts only explicit signals and skips untemplated events rather than guess.

A single event can hold several ladders. A player-props event carries one ladder per player, and team totals carry one per team. Grouping by event compared one player's "over 0.5" with another player's "over 1.5" and reported 68 violations that were entirely our bug. Ladders are therefore grouped by symbol with the trailing strike digits removed.

## Fees

From the [fee schedule](https://www.gemini.com/fees/predictions): the taker fee is `0.07 × C × P × (1 − P)`, and the maker fee is `0.0175 × C × P × (1 − P)`. Maker fees are waived through December 31, 2026 ([promo](https://developer.gemini.com/prediction-markets/maker-fee-free-trading-promo)). Fees round up to the next cent per order, and there are no settlement fees. The taker fee is at most 1.75¢ per contract (at P = 0.50), so a violation needs roughly 2–3¢ of slack across its legs before it is worth anything.

## Results

**Snapshot of every active event** (best bid and ask from the REST events listing, 1,566 events including nested ones):

- 287 mutually exclusive groups and 610 ladders. **Zero violations**, before or after fees.
- Moneylines sit right at the bound: for two-way games, the asks summed to exactly 1.01 in 56 cases and 1.02 in 35, and the bids summed to 0.99 in 54.
- Adjacent ladder rungs usually sit 4–8¢ apart (lower strike's ask minus higher strike's bid, 2,414 pairs).

**Live, over `@bookTicker`** (3 minutes, 12 groups, 52 contracts, 4,809 updates, including a WNBA game in progress and a BTC ladder an hour from expiry):

- **Zero violation episodes.** The closest any moneyline came to its bound was 1¢, and the closest ladder was 7¢.

## Conclusion

Market makers visibly price these constraints: two-way moneylines hold 1¢ from the bound, the minimum tick. A monitor framed as an arbitrage finder would show nothing, and even a 1¢ break would not survive taker fees.

What is worth monitoring is how tightly each group is held and how quickly a break is corrected, with any real violation logged as a rare event. Three minutes is a small sample. Breaks are most likely around fast moves (a goal, a sharp BTC swing, the minutes before expiry), so the monitor needs to run for hours before we say anything stronger than "rare".

## Side findings

- `bookTicker`'s `u` is on the same exchange-wide sequence as the depth streams, so updates from different books and different stream types can be placed in one global order.
- `@depth20` frames carry a `symbol` field that the docs' example omits. That is what makes routing reference snapshots on a shared connection possible (see [design 0001](../design/0001-multi-contract-feed.md)).
