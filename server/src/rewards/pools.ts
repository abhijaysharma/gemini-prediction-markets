// Public reward-pool data. All three endpoints need no API key:
//   /v1/prediction-markets/liquidity-rewards/config   program parameters
//   /v1/prediction-markets/liquidity-rewards/events   every event in the program
//   /v1/prediction-markets/events                     which contracts each event has

export interface RewardsConfig {
  enabled: boolean;
  maxSpreadCents: number;
}

export interface RewardEvent {
  ticker: string;
  title: string;
  qualifyingMakers: number;
  endsAt: string;
}

/**
 * A pool is not per event: one daily budget is shared by every event in it
 * (all of a day's 5-minute BTC events, say, or 207 political races).
 */
export interface Pool {
  id: string;
  /** The category for a shared pool, the event's title for a single-event override. */
  name: string;
  dailyUsd: number;
  category: string | null;
  source: string;
  events: RewardEvent[];
}

/** Documented qualification rules the config endpoint doesn't return. */
export const SIZE_CAP = 250;
export const MIN_SIZE = 10;

const PAGE = 100;

export async function fetchRewardsConfig(restUrl: string): Promise<RewardsConfig> {
  const body = await getJson(`${restUrl}/v1/prediction-markets/liquidity-rewards/config`);
  return { enabled: body.enabled === true, maxSpreadCents: Number(body.max_spread_cents ?? 10) };
}

export async function fetchPools(restUrl: string): Promise<Pool[]> {
  const rows: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const body = await getJson(
      `${restUrl}/v1/prediction-markets/liquidity-rewards/events?sort=daily_pool_desc&limit=${PAGE}&offset=${offset}`,
    );
    const page: any[] = body.events ?? [];
    rows.push(...page);
    if (page.length < PAGE || rows.length >= Number(body.pagination?.total ?? 0)) break;
  }
  return groupPools(rows);
}

export function groupPools(rows: any[]): Pool[] {
  const pools = new Map<string, Pool>();
  for (const r of rows) {
    // pool_id is a number on the live API. Event-level overrides carry none;
    // each is a pool of one.
    const shared = r.pool_id !== undefined && r.pool_id !== null;
    const id = shared ? `pool:${r.pool_id}` : `event:${r.event_ticker}`;
    let pool = pools.get(id);
    if (!pool) {
      pool = {
        id,
        name: String((shared ? r.pool_category_name : null) ?? r.title),
        dailyUsd: Number(r.daily_pool_usd),
        category: r.pool_category_name ?? r.category ?? null,
        source: String(r.pool_source ?? "unknown"),
        events: [],
      };
      pools.set(id, pool);
    }
    pool.events.push({
      ticker: String(r.event_ticker),
      title: String(r.title),
      qualifyingMakers: Number(r.qualifying_maker_count ?? 0),
      endsAt: String(r.ends_at),
    });
  }
  return [...pools.values()].sort((a, b) => b.dailyUsd - a.dailyUsd);
}

/**
 * Map each event ticker to its tradable contract symbols, reading every page
 * of the events listing. Events nest (a game holds its spread and totals
 * events), so walk the whole response.
 */
export async function fetchContractsByEvent(restUrl: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let offset = 0; ; offset += PAGE) {
    const body = await getJson(`${restUrl}/v1/prediction-markets/events?status=active&limit=${PAGE}&offset=${offset}`);
    collectContracts(body.data ?? [], out);
    const page = (body.data ?? []).length;
    if (page < PAGE || offset + page >= Number(body.pagination?.total ?? 0)) break;
    // Public REST allows 120 requests a minute; stay well under it.
    await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
}

/**
 * Open contracts of one event. Used for events that appear after start-up,
 * like each new 5-minute window, instead of re-reading every listing page.
 * Empty when the event is unknown or nothing in it is open yet.
 */
export async function fetchEventContracts(restUrl: string, ticker: string): Promise<string[]> {
  const res = await fetch(`${restUrl}/v1/prediction-markets/events/${encodeURIComponent(ticker)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GET event ${ticker} failed with HTTP ${res.status}`);
  const out = new Map<string, string[]>();
  collectContracts(await res.json(), out);
  return out.get(ticker) ?? [];
}

export function collectContracts(node: unknown, out: Map<string, string[]>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectContracts(child, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.ticker === "string" && Array.isArray(obj.contracts)) {
    const open = (obj.contracts as any[])
      .filter((c) => typeof c?.instrumentSymbol === "string" && (c.marketState ?? "open") === "open")
      .map((c) => c.instrumentSymbol as string);
    if (open.length) out.set(obj.ticker, open);
  }
  for (const value of Object.values(obj)) if (value && typeof value === "object") collectContracts(value, out);
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed with HTTP ${res.status}`);
  return res.json();
}
