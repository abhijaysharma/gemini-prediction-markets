import { useRef, useState } from "react";
import { fmtClock } from "../format";

const W = 112;
const H = 28;
const PAD = 3;

/**
 * A small trend line: history in a muted ink, the latest point in the accent,
 * and a crosshair with the exact value on hover.
 */
export function Sparkline({
  points,
  format,
  label,
}: {
  points: { t: number; v: number }[];
  format: (v: number) => string;
  label: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <span className="spark-empty">Collecting</span>;

  const vs = points.map((p) => p.v);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (hi - lo < 1e-9) {
    lo -= 0.5;
    hi += 0.5;
  }
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const last = points.length - 1;
  const shown = hover ?? last;

  const onMove = (e: React.PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left) / box.width) * last);
    setHover(Math.max(0, Math.min(last, i)));
  };

  const summary = `${label}: ${format(points[0].v)} at ${fmtClock(points[0].t)}, ${format(points[last].v)} now`;
  return (
    <span className="spark">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={summary}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <path d={d} className="spark-line" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} className="spark-cursor" />}
        <circle cx={x(shown)} cy={y(points[shown].v)} r={3} className={hover === null ? "spark-dot" : "spark-dot is-hover"} />
      </svg>
      {hover !== null && (
        <span className="spark-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <strong>{format(points[hover].v)}</strong> {fmtClock(points[hover].t)}
        </span>
      )}
    </span>
  );
}
