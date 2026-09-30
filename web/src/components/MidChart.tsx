import { useState, type PointerEvent } from "react";
import { fmtClock } from "../format";

const W = 600;
const H = 170;

export function MidChart({ mids }: { mids: { t: number; mid: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);

  if (mids.length < 2) {
    return (
      <section className="glass panel chart">
        <header className="panel-head">
          <h2>Mid price</h2>
        </header>
        <p className="empty">Collecting prices. The line appears after a second of live data.</p>
      </section>
    );
  }

  const values = mids.map((m) => m.mid);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = (hi - lo || Math.abs(hi) * 0.01 || 0.01) * 0.15;
  lo -= pad;
  hi += pad;
  const t0 = mids[0].t;
  const t1 = mids[mids.length - 1].t;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const points = mids.map((m) => `${x(m.t).toFixed(1)},${y(m.mid).toFixed(1)}`).join(" ");
  const area = `0,${H} ${points} ${W},${H}`;

  const first = mids[0];
  const last = mids[mids.length - 1];
  const change = last.mid - first.mid;
  const changePct = first.mid !== 0 ? (change / first.mid) * 100 : 0;
  const deltaClass = change > 0 ? "delta-pos" : change < 0 ? "delta-neg" : "delta-flat";
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  const spanMin = Math.max(1, Math.round((t1 - t0) / 60_000));
  const ticks = [0.2, 0.5, 0.8].map((f) => hi - (hi - lo) * f);

  const hovered = hover !== null && hover < mids.length ? mids[hover] : null;
  const pct = (px: number, total: number) => `${(px / total) * 100}%`;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - box.left) / box.width) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < mids.length; i++) {
      if (Math.abs(mids[i].t - t) < Math.abs(mids[best].t - t)) best = i;
    }
    setHover(best);
  };

  return (
    <section className="glass panel chart">
      <header className="panel-head">
        <h2>Mid price</h2>
        <div className="chart-headline">
          <span className="chart-last">{fmtPrice(last.mid)}</span>
          <span className={`chart-delta ${deltaClass}`}>
            {sign}
            {fmtPrice(Math.abs(change))} ({sign}
            {Math.abs(changePct).toFixed(1)}%)
          </span>
        </div>
      </header>
      <div className="chart-area" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="chart-svg" aria-label="Mid price over time">
          <defs>
            <linearGradient id="mid-stroke" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#22D3EE" />
              <stop offset="50%" stopColor="#818CF8" />
              <stop offset="100%" stopColor="#E879F9" />
            </linearGradient>
            <linearGradient id="mid-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#818CF8" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#818CF8" stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((v) => (
            <line key={v} x1="0" x2={W} y1={y(v)} y2={y(v)} className="chart-grid" />
          ))}
          <line x1="0" x2={W} y1={y(first.mid)} y2={y(first.mid)} className="chart-ref" />
          <polygon points={area} fill="url(#mid-fill)" />
          <polyline points={points} className="chart-line" stroke="url(#mid-stroke)" />
          {hovered && <line x1={x(hovered.t)} x2={x(hovered.t)} y1="0" y2={H} className="chart-cursor" />}
        </svg>
        <div className="chart-axis" aria-hidden="true">
          {ticks.map((v) => (
            <span key={v} style={{ top: pct(y(v), H) }}>
              {fmtPrice(v, 3)}
            </span>
          ))}
        </div>
        {hovered && (
          <>
            <span className="chart-dot" style={{ left: pct(x(hovered.t), W), top: pct(y(hovered.mid), H) }} />
            <div
              className="chart-tip"
              style={
                x(hovered.t) > W / 2
                  ? { right: `calc(${pct(W - x(hovered.t), W)} + 12px)` }
                  : { left: `calc(${pct(x(hovered.t), W)} + 12px)` }
              }
            >
              <strong>{fmtPrice(hovered.mid)}</strong>
              <span>{fmtClock(hovered.t)}</span>
            </div>
          </>
        )}
      </div>
      <footer className="panel-foot">
        Last {spanMin} minute{spanMin === 1 ? "" : "s"}, sampled twice a second. Dashed line marks the window open at{" "}
        {fmtPrice(first.mid)}.
      </footer>
    </section>
  );
}

function fmtPrice(n: number, digits = 6) {
  return Number(n.toFixed(digits)).toString();
}
