import { describe, expect, it } from "vitest";
import { extractMarkets, pickMarket } from "../server/src/markets";

describe("extractMarkets", () => {
  it("finds instrument symbols anywhere in the response with titles and status", () => {
    const body = {
      data: [
        {
          title: "BTC up or down",
          contracts: [
            { instrumentSymbol: "GEMI-BTC05M2606011000-UP", name: "Up", status: "Active" },
            { instrumentSymbol: "GEMI-BTC05M2606011000-DOWN", name: "Down", status: "Settled" },
          ],
        },
      ],
    };
    expect(extractMarkets(body)).toEqual([
      { symbol: "GEMI-BTC05M2606011000-UP", title: "BTC up or down: Up", status: "Active" },
      { symbol: "GEMI-BTC05M2606011000-DOWN", title: "BTC up or down: Down", status: "Settled" },
    ]);
  });
});

describe("pickMarket", () => {
  const m = (symbol: string, status: string | null = "Active") => ({ symbol, title: null, status });

  it("rolls over to the next contract in the same series", () => {
    const markets = [
      m("GEMI-BTC05M2606011010-UP"),
      m("GEMI-BTC05M2606011005-UP"),
      m("GEMI-BTC05M2606011005-DOWN"),
      m("GEMI-ETH15M2606011000-UP"),
    ];
    expect(pickMarket(markets, "GEMI-BTC05M2606011000-UP")).toBe("GEMI-BTC05M2606011005-UP");
  });

  it("skips contracts that are no longer active", () => {
    const markets = [m("GEMI-BTC05M2606011005-UP", "Settled"), m("GEMI-ETH15M2606011000-UP")];
    expect(pickMarket(markets, null)).toBe("GEMI-ETH15M2606011000-UP");
  });

  it("returns null when nothing else is available", () => {
    expect(pickMarket([m("A")], "A")).toBeNull();
  });
});
