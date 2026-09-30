/** Messages per second over a sliding window. */
export class RateMeter {
  private hits: number[] = [];
  constructor(private windowMs = 5000) {}

  hit(now: number): void {
    this.hits.push(now);
  }

  rate(now: number): number {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.hits.length && this.hits[i] < cutoff) i++;
    if (i > 0) this.hits.splice(0, i);
    return this.hits.length / (this.windowMs / 1000);
  }
}

/** A bounded buffer of samples with percentile queries. */
export class Samples {
  private buf: number[] = [];
  constructor(private cap = 2000) {}

  add(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.shift();
  }

  clear(): void {
    this.buf = [];
  }

  percentile(p: number): number | null {
    if (this.buf.length === 0) return null;
    const sorted = [...this.buf].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }

  min(): number | null {
    if (this.buf.length === 0) return null;
    return Math.min(...this.buf);
  }
}
