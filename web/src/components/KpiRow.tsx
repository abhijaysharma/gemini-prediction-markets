import { Activity, Gauge, RefreshCw, ShieldCheck, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { StatePayload } from "../../../server/src/types";
import { fmtInt, fmtMs, median } from "../format";
import { Hint } from "./Hint";

export function KpiRow({ state }: { state: StatePayload }) {
  const { integrity: i, metrics: m, recovery: r, counters: c } = state;
  const decided = i.matched + i.mismatched;
  const passRate = decided > 0 ? (i.matched / decided) * 100 : null;

  return (
    <section className="kpis" aria-label="Key metrics">
      <Kpi
        icon={ShieldCheck}
        label="Integrity checks passed"
        value={passRate === null ? "–" : `${passRate.toFixed(passRate === 100 ? 0 : 1)}%`}
        meta={`${fmtInt(i.matched)} passed · ${fmtInt(i.mismatched)} failed · ${fmtInt(i.skipped)} skipped`}
      >
        <div className="bar" aria-hidden="true">
          <span style={{ width: `${passRate ?? 0}%` }} />
        </div>
      </Kpi>
      <Kpi
        icon={Gauge}
        label="Feed lag, median"
        hint="Exchange event time to arrival here. Includes any offset between this machine's clock and Gemini's. Jitter is lag above the fastest message seen, which cancels a constant offset."
        value={<Unit text={fmtMs(m.lagP50, 1)} />}
        meta={`p99 ${fmtMs(m.lagP99, 1)} · jitter p99 ${fmtMs(m.jitterP99, 1)}`}
      />
      <Kpi
        icon={Activity}
        label="Messages per second"
        value={m.msgPerSec.toFixed(1)}
        meta={`${fmtInt(c.messages)} received this session`}
      />
      <Kpi
        icon={RefreshCw}
        label="Last rebuild"
        value={<Unit text={fmtMs(r.lastMs)} />}
        meta={`${fmtInt(c.resyncs)} rebuilds · median ${fmtMs(median(r.recentMs))}`}
      />
    </section>
  );
}

function Kpi(props: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  value: ReactNode;
  meta: string;
  children?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div className="glass kpi">
      <div className="kpi-label">
        <Icon size={15} strokeWidth={1.5} aria-hidden="true" />
        {props.label}
        {props.hint && <Hint text={props.hint} />}
      </div>
      <div className="kpi-value">{props.value}</div>
      {props.children}
      <div className="kpi-meta">{props.meta}</div>
    </div>
  );
}

/** Renders "12.3 ms" with the unit set smaller than the number. */
function Unit({ text }: { text: string }) {
  const [n, unit] = text.split(" ");
  return (
    <>
      {n}
      {unit && <small>{unit}</small>}
    </>
  );
}
