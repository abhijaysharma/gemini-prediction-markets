import { Coins, Gauge, LoaderCircle, Radar, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";
import { outlook, type PoolOutlook } from "../../../server/src/rewards/estimate";
import type { RewardsPoolView, RewardsState } from "../../../server/src/types";
import { fmtInt } from "../format";
import { useRewards } from "../useStream";
import { Hint } from "./Hint";
import { Kpi } from "./KpiRow";
import { Sparkline } from "./Sparkline";

type SortKey = "per1k" | "est" | "share" | "pool" | "makers";

interface Row extends PoolOutlook {
  pool: RewardsPoolView;
  trend: { t: number; v: number }[];
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
      rows.push({
        pool,
        ...outlook(pool.now, pool.dailyUsd, q),
        // Share is recomputed for the chosen size at every point, since each point stores size-free inputs.
        trend: pool.history.map((h) => ({ t: h.t, v: outlook(h, pool.dailyUsd, q).share })),
      });
    }
    const by: Record<SortKey, (a: Row, b: Row) => number> = {
      per1k: (a, b) => b.usdPerDayPer1k - a.usdPerDayPer1k,
      est: (a, b) => b.estUsdPerDay - a.estUsdPerDay,
      share: (a, b) => b.share - a.share,
      makers: (a, b) => a.pool.maxMakers - b.pool.maxMakers,
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
          <h2>Where a quote would earn the most</h2>
          <p>
            Gemini splits daily pools among makers who rest quotes near the mid. For each pool, this asks: if you quoted{" "}
            {size} contracts at the best bid and ask of every contract in it, what share would you win right now?
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
          icon={Radar}
          label="Contracts watched"
          value={fmtInt(r.contractsWatched)}
          meta={`${ago === null ? "waiting for data" : `updated ${ago}s ago`}${r.failedSubscriptions ? `, ${r.failedSubscriptions} unavailable` : ""}`}
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
                  <th className="r">Quoted</th>
                  {th("share", "Your share", { right: true })}
                  {th("est", "Est. per day", { right: true })}
                  <th className="r">Capital</th>
                  {th("per1k", "Per $1k", { right: true, hint: "Estimated reward per day for every $1,000 of collateral." })}
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
                      </div>
                    </td>
                    <td className="r">{usd(x.pool.dailyUsd)}</td>
                    <td className="r">{x.pool.maxMakers}</td>
                    <td className="r">
                      {x.pool.now!.contractsQuoted}/{x.pool.contractsTotal}
                    </td>
                    <td className="r strong">{pct(x.share)}</td>
                    <td className="r">{usd(x.estUsdPerDay)}</td>
                    <td className="r">{usd(x.capital)}</td>
                    <td className="r strong">{usd(x.usdPerDayPer1k)}</td>
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
            Rewards are not profit. Resting quotes get filled, and on short-dated contracts mostly when the price is
            about to move against you.
          </li>
        </ul>
      </section>
    </>
  );
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
