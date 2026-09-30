import type { StatePayload } from "../../../server/src/types";
import { fmtInt, fmtMs, median } from "../format";

const STATE_LABEL: Record<StatePayload["feedState"], string> = {
  idle: "Idle",
  connecting: "Connecting",
  syncing: "Waiting for snapshot",
  live: "Live",
  reconnecting: "Reconnecting",
};

export function HealthPanel({ state }: { state: StatePayload }) {
  const { counters: c, metrics: m, recovery: r, integrity: i } = state;

  const rows: [string, string, string?][] = [
    ["Feed", STATE_LABEL[state.feedState]],
    ["Messages per second", m.msgPerSec.toFixed(1)],
    [
      "Feed lag, median and p99",
      `${fmtMs(m.lagP50, 1)} / ${fmtMs(m.lagP99, 1)}`,
      "Exchange event time to arrival here. Includes any offset between this machine's clock and Gemini's.",
    ],
    ["Jitter p99", fmtMs(m.jitterP99, 1), "Lag above the fastest message seen. Cancels out a constant clock offset."],
    ["Gaps detected", fmtInt(c.gaps)],
    ["Rebuilds", fmtInt(c.resyncs)],
    ["Reconnects", fmtInt(c.reconnects)],
    ["Rebuild time, last and median", `${fmtMs(r.lastMs)} / ${fmtMs(median(r.recentMs))}`],
    ["Checks we couldn't line up", fmtInt(i.skipped), "Reference snapshots with no exactly matching local update. Never counted as passes."],
    ["Crossed books seen", fmtInt(c.crossedBooks)],
    ["Last update ID", state.book.lastUpdateId !== null ? String(state.book.lastUpdateId) : "–"],
  ];

  return (
    <section className="panel health">
      <header className="panel-head">
        <h2>Feed health</h2>
      </header>
      <dl>
        {rows.map(([label, value, hint]) => (
          <div key={label} className="stat" title={hint}>
            <dt>
              {label}
              {hint && <span className="hint-dot" aria-hidden="true" />}
            </dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
