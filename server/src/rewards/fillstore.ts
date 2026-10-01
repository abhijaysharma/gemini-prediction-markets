import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FillRecord } from "./markout";

// Completed fills, one JSON object per line. Markouts need hours or days of
// trades per pool, so they have to outlive a server restart. Append-only and
// dependency-free: a few thousand small lines a day.

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export class FillStore {
  constructor(private file: string) {}

  /** Fills from the last week. Rewrites the file without older ones, so it can't grow forever. */
  load(now = Date.now()): FillRecord[] {
    if (!existsSync(this.file)) return [];
    const kept: FillRecord[] = [];
    let dropped = 0;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as FillRecord;
        if (now - r.at <= KEEP_MS) kept.push(r);
        else dropped++;
      } catch {
        dropped++; // a line cut short by a crash
      }
    }
    if (dropped > 0) writeFileSync(this.file, kept.map((r) => JSON.stringify(r) + "\n").join(""));
    return kept;
  }

  append(records: FillRecord[]): void {
    if (records.length === 0) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, records.map((r) => JSON.stringify(r) + "\n").join(""));
  }
}
