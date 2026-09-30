import type { ReactNode } from "react";
import type { StatePayload } from "../../../server/src/types";
import { fmtInt } from "../format";
import { Hint } from "./Hint";

const FEED_STATE: Record<StatePayload["feedState"], { label: string; tone: string }> = {
  idle: { label: "Idle", tone: "info" },
  connecting: { label: "Connecting", tone: "info" },
  syncing: { label: "Waiting for snapshot", tone: "warn" },
  live: { label: "Live", tone: "pos" },
  reconnecting: { label: "Reconnecting", tone: "warn" },
};

export function HealthPanel({ state }: { state: StatePayload }) {
  const { counters: c, integrity: i } = state;
  const feed = FEED_STATE[state.feedState];

  const rows: [string, ReactNode, string?][] = [
    ["Feed", <span className={`chip chip-${feed.tone}`}>{feed.label}</span>],
    ["Gaps detected", fmtInt(c.gaps)],
    ["Rebuilds", fmtInt(c.resyncs)],
    ["Mismatches healed", fmtInt(i.healed), "A check failed, then a later update corrected the book before a second failure, so no rebuild was needed."],
    ["Reconnects", fmtInt(c.reconnects)],
    ["Checks we couldn't line up", fmtInt(i.skipped), "Reference snapshots with no exactly matching local update. Never counted as passes."],
    ["Crossed books seen", fmtInt(c.crossedBooks)],
    ["Last update ID", state.book.lastUpdateId !== null ? String(state.book.lastUpdateId) : "–"],
  ];

  return (
    <section className="glass panel health">
      <header className="panel-head">
        <h2>Feed health</h2>
      </header>
      <dl>
        {rows.map(([label, value, hint]) => (
          <div key={label} className="stat">
            <dt>
              {label}
              {hint && <Hint text={hint} />}
            </dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
