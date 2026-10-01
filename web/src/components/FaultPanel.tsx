import { ChevronRight, FileWarning, Info, SkipForward, Unplug, type LucideIcon } from "lucide-react";
import type { StatePayload } from "../../../server/src/types";
import { post } from "../useStream";

const FAULTS: { icon: LucideIcon; label: string; caughtBy: string; path: string; body?: unknown }[] = [
  { icon: SkipForward, label: "Drop 3 updates", caughtBy: "Caught by sequence numbers", path: "/api/faults/drop", body: { count: 3 } },
  { icon: FileWarning, label: "Corrupt the local book", caughtBy: "Caught by the integrity check", path: "/api/faults/corrupt" },
  { icon: Unplug, label: "Cut the connection", caughtBy: "Caught by the socket closing", path: "/api/faults/disconnect" },
];

export function FaultPanel({ state }: { state: StatePayload }) {
  const live = state.feedState === "live" && state.recovery.inProgressSince === null;
  const coolingDown = state.faultsAvailableAt !== null && state.faultsAvailableAt > state.serverTime;
  const ready = live && !coolingDown;

  return (
    <section className="glass panel faults">
      <header className="panel-head">
        <h2>Inject a fault</h2>
      </header>
      <p className="faults-intro">Simulate what goes wrong on a real feed. Each fault is caught by a different mechanism.</p>
      <div className="actions">
        {FAULTS.map(({ icon: Icon, label, caughtBy, path, body }) => (
          <button key={path} className="action" disabled={!ready} onClick={() => void post(path, body)}>
            <span className="action-icon">
              <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
            </span>
            <span className="action-text">
              <strong>{label}</strong>
              <span>{caughtBy}</span>
            </span>
            <ChevronRight size={16} strokeWidth={1.5} className="action-chevron" aria-hidden="true" />
          </button>
        ))}
      </div>
      {!live && (
        <p className="faults-note">
          <Info size={14} strokeWidth={1.5} aria-hidden="true" />
          Available once the book is live.
        </p>
      )}
      {live && state.publicDemo && (
        <p className="faults-note">
          <Info size={14} strokeWidth={1.5} aria-hidden="true" />
          {coolingDown
            ? `Shared demo: next fault in ${Math.ceil((state.faultsAvailableAt! - state.serverTime) / 1000)} s.`
            : "Shared demo: a fault hits everyone watching, so one runs every 10 seconds."}
        </p>
      )}
    </section>
  );
}
