// Ranks Gemini's liquidity reward pools by what a quote would earn per day,
// per $1,000 of capital, from public data only. No API key needed.
//
// Usage: npm run rewards -- [--size 100] [--seconds 60]
//
// How the estimate works, and its limits: docs/findings/0002-liquidity-rewards.md

import { estimateRewards } from "../server/src/rewards/run";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

const size = arg("size", 100);
const seconds = arg("seconds", 60);

const result = await estimateRewards({
  restUrl: process.env.GEMINI_REST_URL ?? "https://api.gemini.com",
  wsUrl: process.env.GEMINI_WS_URL ?? "wss://ws.gemini.com",
  size,
  seconds,
  log: (m) => console.log(m),
});

const money = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;
console.log(`\nQuoting ${size} contracts at the best bid and ask of every two-sided contract in each pool:\n`);
console.log(
  ["Pool".padEnd(44), "Pool/day".padStart(9), "Makers".padStart(6), "Quoted".padStart(9), "Share".padStart(7), "Est/day".padStart(8), "Capital".padStart(8), "Per $1k".padStart(8)].join("  "),
);
for (const e of result.estimates) {
  const name = e.pool.name.slice(0, 44);
  console.log(
    [
      name.padEnd(44),
      money(e.pool.dailyUsd).padStart(9),
      String(e.maxMakers).padStart(6),
      `${e.contractsQuoted}/${e.contractsTotal}`.padStart(9),
      `${(e.share * 100).toFixed(1)}%`.padStart(7),
      money(e.estUsdPerDay).padStart(8),
      money(e.capital).padStart(8),
      money(e.usdPerDayPer1k).padStart(8),
    ].join("  "),
  );
}
console.log(`
${result.idlePools} pools had no event trading right now and are not shown.${result.subscribeFailures.length ? ` ${result.subscribeFailures.length} subscriptions failed.` : ""}

Read these as estimates, not promises:
- The spread weight is fitted (1/d^2) to the docs' worked example, not published.
- The public book merges makers, so competition is overstated (no per-maker size cap, everyone assumed two-sided).
- "Est/day" assumes the book looks like this all day and that you keep the 50% uptime the program requires.
- Rewards are not profit. Resting quotes get filled, and on short-dated contracts mostly when the price is about to move against you.`);
