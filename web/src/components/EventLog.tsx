import { CircleX, Info, TriangleAlert } from "lucide-react";
import type { LogEntry } from "../../../server/src/types";
import { fmtClock } from "../format";

const ICON = { info: Info, warn: TriangleAlert, error: CircleX };

export function EventLog({ log }: { log: LogEntry[] }) {
  const entries = [...log].reverse();
  return (
    <section className="glass panel log">
      <header className="panel-head">
        <h2>Event log</h2>
        <span className="meta">Newest first</span>
      </header>
      {entries.length === 0 ? (
        <p className="empty">No events yet.</p>
      ) : (
        <ol className="feed">
          {entries.map((e, i) => {
            const Icon = ICON[e.level];
            return (
              <li key={`${e.t}-${i}`} className={`feed-${e.level}`}>
                <span className="feed-icon">
                  <Icon size={14} strokeWidth={1.75} aria-label={e.level} />
                </span>
                <span className="feed-msg">{e.msg}</span>
                <time dateTime={new Date(e.t).toISOString()}>{fmtClock(e.t, true)}</time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
