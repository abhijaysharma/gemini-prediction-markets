import type { StatePayload } from "../../../server/src/types";
import { fmtInt, fmtMs } from "../format";

type Tone = "ok" | "caution" | "fault" | "neutral";

function summarize(s: StatePayload): { tone: Tone; headline: string; detail: string } {
  const { integrity, recovery, feedState } = s;
  if (recovery.inProgressSince !== null) {
    const elapsed = s.serverTime - recovery.inProgressSince;
    return {
      tone: "caution",
      headline: "Rebuilding the book",
      detail: `${capitalize(recovery.reason ?? "recovering")}. ${fmtMs(elapsed)} so far.`,
    };
  }
  if (feedState !== "live") {
    return { tone: "neutral", headline: "Connecting to the exchange", detail: `Feed is ${feedState}.` };
  }
  if (integrity.last === "mismatch") {
    return {
      tone: "fault",
      headline: "Local book diverged from the exchange",
      detail: integrity.lastMismatch ?? "",
    };
  }
  if (integrity.matched > 0) {
    const recovered = recovery.lastMs !== null ? ` Last rebuild took ${fmtMs(recovery.lastMs)}.` : "";
    return {
      tone: "ok",
      headline: "Local book matches the exchange",
      detail: `${fmtInt(integrity.matched)} checks passed, ${fmtInt(integrity.mismatched)} failed.${recovered}`,
    };
  }
  return {
    tone: "neutral",
    headline: "Waiting for a snapshot to compare against",
    detail: "The first check runs when a reference snapshot lines up with the local book.",
  };
}

export function IntegrityStrip({ state }: { state: StatePayload }) {
  const { tone, headline, detail } = summarize(state);
  const history = state.integrity.history;

  return (
    <section className={`integrity tone-${tone}`} aria-live="polite">
      <div className="integrity-text">
        <h2>{headline}</h2>
        <p>{detail}</p>
      </div>
      <div className="tape-wrap">
        <div className="tape" role="img" aria-label={`Last ${history.length} integrity checks`}>
          {history.map((mark, i) => (
            <span key={i} className={`mark mark-${mark}`} />
          ))}
        </div>
        <p className="tape-caption">
          Each mark compares the local book with Gemini's own top 20 levels. Amber marks a rebuild.
        </p>
      </div>
    </section>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
