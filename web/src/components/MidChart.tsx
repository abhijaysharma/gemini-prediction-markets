const W = 600;
const H = 150;

export function MidChart({ mids }: { mids: { t: number; mid: number }[] }) {
  if (mids.length < 2) {
    return (
      <section className="panel chart">
        <header className="panel-head">
          <h2>Mid price</h2>
        </header>
        <p className="muted empty">Collecting prices. The line appears after a second of live data.</p>
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
  const last = mids[mids.length - 1];
  const spanMin = Math.max(1, Math.round((t1 - t0) / 60_000));

  return (
    <section className="panel chart">
      <header className="panel-head">
        <h2>Mid price</h2>
        <span className="chart-last">{Number(last.mid.toFixed(6))}</span>
      </header>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="chart-svg" aria-label="Mid price over time">
        <line x1="0" x2={W} y1={y(last.mid)} y2={y(last.mid)} className="chart-guide" />
        <polyline points={points} className="chart-line" />
      </svg>
      <footer className="panel-foot muted">
        Last {spanMin} minute{spanMin === 1 ? "" : "s"}, sampled twice a second
      </footer>
    </section>
  );
}
