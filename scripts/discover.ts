// Lists live prediction-market symbols. The app does this automatically;
// this script is for inspecting the raw events response.
// Public endpoint, no API key needed.
// We don't hardcode the response schema yet. We walk the JSON and pull out
// every `instrumentSymbol`, then save the raw response so we can study its shape.

import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://api.gemini.com";

type Found = { symbol: string; path: string; context: Record<string, unknown> };

function findSymbols(node: unknown, path = "$", out: Found[] = []): Found[] {
  if (Array.isArray(node)) {
    node.forEach((child, i) => findSymbols(child, `${path}[${i}]`, out));
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key === "instrumentSymbol" && typeof value === "string") {
        out.push({ symbol: value, path, context: obj });
      } else {
        findSymbols(value, `${path}.${key}`, out);
      }
    }
  }
  return out;
}

async function main() {
  const res = await fetch(`${BASE}/v1/prediction-markets/events`);
  console.log(`GET /v1/prediction-markets/events -> HTTP ${res.status}`);
  if (!res.ok) {
    console.error(await res.text());
    process.exit(1);
  }

  const body = await res.json();
  mkdirSync("recordings", { recursive: true });
  writeFileSync("recordings/events.json", JSON.stringify(body, null, 2));
  console.log("Saved raw response to recordings/events.json\n");

  const found = findSymbols(body);
  console.log(`Found ${found.length} instrument symbols.`);
  if (found.length === 0) {
    console.log("No instrumentSymbol keys found. Open recordings/events.json and check the shape.");
    return;
  }

  // Show the fields available on a contract so we learn the schema.
  console.log(`\nFields on a contract object: ${Object.keys(found[0].context).join(", ")}\n`);

  for (const f of found.slice(0, 30)) {
    console.log(f.symbol);
  }
  if (found.length > 30) console.log(`...and ${found.length - 30} more`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
