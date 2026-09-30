import type { MarketInfo } from "./types";

// Market discovery over the public REST API. The docs say the events endpoint
// is where instrumentSymbol values come from; rather than hardcode a response
// schema we haven't validated against live data, we walk the JSON and collect
// every object that has an instrumentSymbol.

const TITLE_KEYS = ["title", "eventTitle", "name", "label", "description"];
const STATUS_KEYS = ["status", "contractStatus", "state"];
const ACTIVE = /active|open|trading/i;

export async function fetchMarkets(restUrl: string): Promise<MarketInfo[]> {
  const res = await fetch(`${restUrl}/v1/prediction-markets/events`);
  if (!res.ok) throw new Error(`events request failed with HTTP ${res.status}`);
  return extractMarkets(await res.json());
}

export function extractMarkets(body: unknown): MarketInfo[] {
  const out: MarketInfo[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown, parentTitle: string | null, parentStatus: string | null) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, parentTitle, parentStatus);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const ownTitle = firstString(obj, TITLE_KEYS);
    const ownStatus = firstString(obj, STATUS_KEYS);
    const symbol = obj.instrumentSymbol;

    if (typeof symbol === "string" && !seen.has(symbol)) {
      seen.add(symbol);
      const title =
        [parentTitle, ownTitle].filter((x, i, arr) => x && arr.indexOf(x) === i).join(": ") || null;
      out.push({ symbol, title, status: ownStatus ?? parentStatus });
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        walk(value, ownTitle ?? parentTitle, ownStatus ?? parentStatus);
      }
    }
  };

  walk(body, null, null);
  return out;
}

export function isActive(m: MarketInfo): boolean {
  return m.status === null || ACTIVE.test(m.status);
}

/**
 * Choose which contract to stream. When the current contract ends, prefer the
 * next contract in the same recurring series: symbols like
 * GEMI-BTC05M2606011000-UP embed a YYMMDDHHMM stamp, so we look for the same
 * prefix and suffix with the next-later stamp.
 */
export function pickMarket(markets: MarketInfo[], current: string | null): string | null {
  const active = markets.filter(isActive);
  const pool = (active.length ? active : markets).filter((m) => m.symbol !== current);
  if (pool.length === 0) return null;

  const cur = current ? parseSeries(current) : null;
  if (cur) {
    const next = pool
      .map((m) => ({ m, s: parseSeries(m.symbol) }))
      .filter((x) => x.s && x.s.prefix === cur.prefix && x.s.suffix === cur.suffix && x.s.stamp > cur.stamp)
      .sort((a, b) => a.s!.stamp.localeCompare(b.s!.stamp))[0];
    if (next) return next.m.symbol;
  }

  // Heuristic default: short-dated BTC contracts tend to have the most activity.
  const btc = pool.find((m) => /BTC/i.test(m.symbol));
  return (btc ?? pool[0]).symbol;
}

function parseSeries(symbol: string) {
  const m = /^(.*?)(\d{10})(.*)$/.exec(symbol);
  return m ? { prefix: m[1].toUpperCase(), stamp: m[2], suffix: m[3].toUpperCase() } : null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}
