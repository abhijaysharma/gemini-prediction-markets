import { Activity, Coins, Gauge, LoaderCircle, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";
import { outlook, type PoolOutlook } from "../../../server/src/rewards/estimate";
import { fillPnlPerDay, yourFillsPerDay } from "../../../server/src/rewards/markout";
import type { RewardsPoolView, RewardsState } from "../../../server/src/types";
import { fmtInt } from "../format";
import { useRewards } from "../useStream";
import { Hint } from "./Hint";
import { Kpi } from "./KpiRow";
import { Sparkline } from "./Sparkline";

type SortKey = "per1k" | "est" | "share" | "pool" | "makers" | "net";

interface Row extends PoolOutlook {
  pool: RewardsPoolView;
  trend: { t: number; v: number }[];
  /** Contracts of your quote expected to be traded against per day; null until volume is measured. */
  yourFillsPerDay: number | null;
  /** Reward plus fill P&L per day; null until there are enough trades. */
  net: number | null;
  fillPnl: number | null;
}

const usd = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n < 10 ? 2 : 0 });
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function RewardsPage() {
  const rewards = useRewards(true);
  const [size, setSize] = useState(100);
  const [sort, setSort] = useState<SortKey>("per1k");

  if (!rewards || rewards.status !== "ready") return <Starting rewards={rewards} />;

  return <Ready rewards={rewards} size={size} setSize={setSize} sort={sort} setSort={setSort} />;
}

function Ready(props: {
  rewards: RewardsState;
  size: number;
  setSize: (n: number) => void;
  sort: SortKey;
  setSort: (k: SortKey) => void;
}) {
  const { rewards: r, size, sort } = props;
  const q = { size, sizeCap: r.sizeCap };

  const { rows, idle } = useMemo(() => {
    const rows: Row[] = [];
    const idle: RewardsPoolView[] = [];
    for (const pool of r.pools) {
      if (!pool.now) {
        idle.push(pool);
        continue;
      }
      const o = outlook(pool.now, pool.dailyUsd, q);
      // The queue a new quote joins: contracts resting at the touch, per side, per quoted contract.
      const queueAhead = pool.now.touchSize / pool.now.contractsQuoted;
      const f = pool.fills;
      const fills = f.enoughObserved ? yourFillsPerDay(f.runTradeSizes, f.observedMs, size, queueAhead) : null;
      const fillPnl = fills === null ? null : fillPnlPerDay(f, fills);
      rows.push({
        pool,
        ...o,
        // Share is recomputed for the chosen size at every point, since each point stores size-free inputs.
        trend: pool.history.map((h) => ({ t: h.t, v: outlook(h, pool.dailyUsd, q).share })),
        yourFillsPerDay: fills,
        fillPnl,
        net: fillPnl === null ? null : o.estUsdPerDay + fillPnl,
      });
    }
    const by: Record<SortKey, (a: Row, b: Row) => number> = {
      per1k: (a, b) => b.usdPerDayPer1k - a.usdPerDayPer1k,
      est: (a, b) => b.estUsdPerDay - a.estUsdPerDay,
      share: (a, b) => b.share - a.share,
      makers: (a, b) => a.pool.maxMakers - b.pool.maxMakers,
      // Pools without enough trades to judge sort last.
      net: (a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity),
      pool: (a, b) => a.pool.name.localeCompare(b.pool.name),
    };
    rows.sort(by[sort]);
    return { rows, idle };
  }, [r, size, sort]);

  const totalPool = r.pools.reduce((s, p) => s + p.dailyUsd, 0);
  const best = [...rows].sort((a, b) => b.usdPerDayPer1k - a.usdPerDayPer1k)[0];
  const allEst = rows.reduce((s, x) => s + x.estUsdPerDay, 0);
  const allCapital = rows.reduce((s, x) => s + x.capital, 0);
  const ago = r.updatedAt ? Math.max(0, Math.round((Date.now() - r.updatedAt) / 1000)) : null;
  const tradesMeasured = r.pools.reduce((n, p) => n + p.fills.trades, 0);
  const judged = rows.filter((x) => x.net !== null).length;
  const lastHorizon = r.horizonsS[r.horizonsS.length - 1];

  const th = (key: SortKey, text: string, opts: { right?: boolean; hint?: string } = {}) => (
    <th className={opts.right ? "r" : undefined} aria-sort={sort === key ? "descending" : undefined}>
      <button type="button" className={`sort ${sort === key ? "is-active" : ""}`} onClick={() => props.setSort(key)}>
        {text}
      </button>
      {opts.hint && <Hint text={opts.hint} />}
    </th>
  );

  return (
    <>
      <section className="glass hero rewards-hero">
        <div className="hero-text">
          <span className="chip chip-info">Liquidity rewards</span>
          <h2>Where a quote would earn the most, and what it would cost</h2>
          <p>
            Gemini splits daily pools among makers who rest quotes near the mid. For each pool, this asks: if you quoted{" "}
            {size} contracts at the best bid and ask of every contract in it, what share would you win right now? And
            when someone trades against quotes in that pool, does the price then move against the maker?
          </p>
        </div>
        <div className="size-control">
          <label htmlFor="quote-size">
            Quote size <strong>{size}</strong> contracts per side
          </label>
          <input
            id="quote-size"
            type="range"
            min={r.minSize}
            max={r.sizeCap}
            step={10}
            value={size}
            onChange={(e) => props.setSize(Number(e.target.value))}
          />
          <div className="size-scale">
            <span>{r.minSize}, the minimum to qualify</span>
            <span>{r.sizeCap}, the most that counts</span>
          </div>
        </div>
      </section>

      <section className="kpis" aria-label="Rewards summary">
        <Kpi
          icon={Coins}
          label="Paid out daily"
          value={usd(totalPool)}
          meta={`${r.pools.length} pools, ${rows.length} with contracts trading now`}
        />
        <Kpi
          icon={TrendingUp}
          label="Best return on capital"
          hint="Estimated reward per day for every $1,000 of collateral your quotes tie up."
          value={best ? `${usd(best.usdPerDayPer1k)}` : "–"}
          meta={best ? `per $1k a day, in ${best.pool.name}` : "No pool is quotable right now"}
        />
        <Kpi
          icon={Gauge}
          label="Quoting every live pool"
          value={usd(allEst)}
          meta={`a day, on ${usd(allCapital)} of collateral`}
        />
        <Kpi
          icon={Activity}
          label="Trades measured"
          hint={`Every trade in a reward pool, marked against the mid ${r.horizonsS.join(", ")} seconds later. Saved across restarts.`}
          value={fmtInt(tradesMeasured)}
          meta={`${judged} of ${rows.length} live pools have enough to judge · ${fmtInt(r.contractsWatched)} contracts watched${
            ago === null ? "" : `, updated ${ago}s ago`
          }`}
        />
      </section>

      <section className="glass panel rewards-table">
        <header className="panel-head">
          <h2>Pools, ranked</h2>
          <span className="meta">Medians over the last minute. Click a column to sort.</span>
        </header>
        {rows.length === 0 ? (
          <p className="empty">Nothing in any pool is quotable right now. Short-dated pools reopen with their next window.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {th("pool", "Pool")}
                  <th className="r">Pool/day</th>
                  {th("makers", "Makers", { right: true, hint: "Most qualifying makers on any event in the pool, as Gemini reports it." })}
                  {th("share", "Your share", { right: true })}
                  {th("est", "Reward/day", { right: true })}
                  <th className="r">Capital</th>
                  {th("per1k", "Reward per $1k", { right: true, hint: "Estimated reward per day for every $1,000 of collateral." })}
                  <th className="r">
                    Your fills/day
                    <Hint text="Contracts of your quote that this run's trades would have filled, per day. You join the back of the queue at the best price, so a trade only reaches you after filling everything resting ahead of you." />
                  </th>
                  <th className="r">
                    Maker P&amp;L per fill
                    <Hint
                      text={`Average cents per contract a maker made (+) or lost (−) ${lastHorizon} seconds after being traded against, with a 95% margin of error. Negative means makers here are being picked off.`}
                    />
                  </th>
                  {th("net", "Net/day", {
                    right: true,
                    hint: `Reward plus expected fill P&L. Shown once a pool has ${r.minTrades} trades and 10 minutes of volume.`,
                  })}
                  <th>{trendSpan(rows)}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.pool.id}>
                    <td>
                      <div className="pool-name">{x.pool.name}</div>
                      <div className="pool-meta">
                        {x.pool.totalEvents === 1
                          ? "Single event"
                          : `${x.pool.liveEvents} of ${x.pool.totalEvents} events trading`}
                        {` · ${x.pool.now!.contractsQuoted} of ${x.pool.contractsTotal} contracts quotable`}
                      </div>
                    </td>
                    <td className="r">{usd(x.pool.dailyUsd)}</td>
                    <td className="r">{x.pool.maxMakers}</td>
                    <td className="r strong">{pct(x.share)}</td>
                    <td className="r">{usd(x.estUsdPerDay)}</td>
                    <td className="r">{usd(x.capital)}</td>
                    <td className="r strong">{usd(x.usdPerDayPer1k)}</td>
                    <td className="r">{x.yourFillsPerDay === null ? <Pending text="measuring" /> : fmtInt(Math.round(x.yourFillsPerDay))}</td>
                    <td className="r">
                      <MakerPnl fills={x.pool.fills} minTrades={r.minTrades} />
                    </td>
                    <td className="r strong">
                      {x.net !== null ? (
                        signedUsd(x.net)
                      ) : x.pool.fills.trades < r.minTrades ? (
                        <Pending text={`${x.pool.fills.trades}/${r.minTrades} trades`} />
                      ) : (
                        <Pending text="measuring volume" />
                      )}
                    </td>
                    <td>
                      <Sparkline points={x.trend} format={pct} label={`Share in ${x.pool.name}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {idle.length > 0 && (
          <p className="panel-foot">
            Not trading right now: {idle.map((p) => p.name).join(", ")}.
          </p>
        )}
      </section>

      <section className="glass panel caveats">
        <header className="panel-head">
          <h2>Read these as estimates</h2>
        </header>
        <ul>
          <li>
            Gemini publishes the scoring rule but only calls the spread weight "quadratic". This uses 1 / (cents from
            mid)², which reproduces the docs' worked example to within about a point and a half.
          </li>
          <li>
            The public book merges every maker at a price, so competition is overstated: no per-maker size cap, and
            every competitor is assumed to earn the two-sided bonus. Real shares should be higher.
          </li>
          <li>Estimates assume the book stays as it is and that you meet the program's 50% uptime requirement.</li>
          <li>
            Fill P&amp;L marks each trade {lastHorizon} seconds later. It doesn't capture holding a position to
            settlement, where a contract jumps to $0 or $1. Fills assume you wait behind everything already resting at your
            price, using the pool's typical queue rather than the exact one at each trade, and a quote that never moves.
          </li>
          <li>
            Trading volume is measured over this run only and scaled to a day, and markouts over the last week. Trades
            cluster around news, so a quiet or busy hour scales badly. A pool with few trades can look very good or very
            bad by chance; the ± is a 95% margin of error.
          </li>
        </ul>
      </section>
    </>
  );
}

function MakerPnl({ fills, minTrades }: { fills: RewardsPoolView["fills"]; minTrades: number }) {
  const m = fills.markoutCents[fills.markoutCents.length - 1];
  if (fills.trades === 0 || m === null) return <Pending text="no trades yet" />;
  const margin = fills.se60 === null ? null : 1.96 * fills.se60;
  return (
    <span className={fills.trades < minTrades ? "faint" : undefined} title={`${fills.trades} trades, ${fmtInt(Math.round(fills.contracts))} contracts`}>
      {m >= 0 ? "+" : "−"}
      {Math.abs(m).toFixed(1)}¢{margin !== null && <span className="pm"> ± {margin.toFixed(1)}</span>}
      <span className="n"> n={fills.trades}</span>
    </span>
  );
}

function Pending({ text }: { text: string }) {
  return <span className="pending">{text}</span>;
}

function signedUsd(n: number): string {
  return `${n < 0 ? "−" : ""}${usd(Math.abs(n))}`;
}

function Starting({ rewards }: { rewards: RewardsState | null }) {
  const failed = rewards?.status === "error";
  return (
    <section className="glass panel rewards-starting" aria-live="polite">
      {!failed && <LoaderCircle size={24} strokeWidth={1.5} className="spin" aria-hidden="true" />}
      <h2>{failed ? "Couldn't reach the reward pools" : "Measuring the reward pools"}</h2>
      <p>
        {rewards?.message ??
          "Connecting to the server."}
      </p>
      {!failed && (
        <p className="muted">
          The first pass reads every event listing to find each pool's contracts, which takes about a minute. After
          that, estimates refresh every few seconds.
        </p>
      )}
    </section>
  );
}

function trendSpan(rows: Row[]): string {
  const ts = rows.flatMap((x) => x.trend.map((p) => p.t));
  if (ts.length < 2) return "Share over time";
  const mins = Math.round((Math.max(...ts) - Math.min(...ts)) / 60_000);
  return `Share, last ${mins < 90 ? `${Math.max(1, mins)} min` : `${Math.round(mins / 60)} h`}`;
}
