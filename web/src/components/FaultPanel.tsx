import type { StatePayload } from "../../../server/src/types";
import { post } from "../useStream";

export function FaultPanel({ state }: { state: StatePayload }) {
  const ready = state.feedState === "live" && state.recovery.inProgressSince === null;

  return (
    <section className="panel faults">
      <header className="panel-head">
        <h2>Break it</h2>
      </header>
      <p className="muted">
        Simulate what goes wrong on a real feed. Each fault is caught a different way: dropped updates by sequence
        numbers, corruption by the integrity check, a cut connection by the socket closing.
      </p>
      <div className="fault-buttons">
        <button disabled={!ready} onClick={() => void post("/api/faults/drop", { count: 3 })}>
          Drop 3 updates
        </button>
        <button disabled={!ready} onClick={() => void post("/api/faults/corrupt")}>
          Corrupt the local book
        </button>
        <button disabled={!ready} onClick={() => void post("/api/faults/disconnect")}>
          Cut the connection
        </button>
      </div>
      {!ready && <p className="muted small">Available once the book is live.</p>}
    </section>
  );
}
