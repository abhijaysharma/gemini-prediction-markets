import type { LogEntry } from "../../../server/src/types";
import { fmtClock } from "../format";

export function EventLog({ log }: { log: LogEntry[] }) {
  const entries = [...log].reverse();
  return (
    <section className="panel log">
      <header className="panel-head">
        <h2>Event log</h2>
      </header>
      <ol className="log-list">
        {entries.map((e, i) => (
          <li key={`${e.t}-${i}`} className={`log-${e.level}`}>
            <time className="muted">{fmtClock(e.t, true)}</time>
            <span>{e.msg}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
