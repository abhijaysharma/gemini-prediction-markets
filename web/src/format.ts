export function fmtMs(ms: number | null | undefined, digits = 0): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (Math.abs(ms) >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${ms.toFixed(digits)} ms`;
}

export function fmtClock(t: number, withMs = false): string {
  const d = new Date(t);
  const base = d.toLocaleTimeString([], { hour12: false });
  return withMs ? `${base}.${String(d.getMilliseconds()).padStart(3, "0")}` : base;
}

export function fmtQty(q: string): string {
  const n = Number(q);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : q;
}

export function fmtInt(n: number): string {
  return n.toLocaleString();
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
