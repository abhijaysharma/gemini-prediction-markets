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
      { symbol: "GEMI-BTC05M2606011000-UP", title: "BTC up or down: Up", status: "Active", live: false, volume24h: 0 },
      { symbol: "GEMI-BTC05M2606011000-DOWN", title: "BTC up or down: Down", status: "Settled", live: false, volume24h: 0 },
    ]);
  });
});

describe("pickMarket", () => {
  const m = (symbol: string, status: string | null = "Active", live = false, volume24h = 0) => ({
    symbol,
    title: null,
    status,
    live,
    volume24h,
  });

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

  it("starts on the busiest market: live events first, then 24h volume", () => {
    const markets = [
      m("GEMI-BTC05M2606011000-UP", "Active", false, 5),
      m("GEMI-MLB-2606011800-PHI-ATL-M-PHI", "Active", true, 33_000),
      m("GEMI-BTC2606012100-HI92500", "Active", false, 90_000),
      m("GEMI-MLB-2606012100-CHW-HOU-M-HOU", "Active", true, 4_000),
    ];
    expect(pickMarket(markets, null)).toBe("GEMI-MLB-2606011800-PHI-ATL-M-PHI");
  });

  it("returns null when nothing else is available", () => {
    expect(pickMarket([m("A")], "A")).toBeNull();
  });
});

describe("extractMarkets activity", () => {
  it("gives each contract its event's live flag and 24h volume", () => {
    // Trimmed from a live /v1/prediction-markets/events response.
    const body = {
      data: [
        {
          title: "Philadelphia vs Atlanta",
          status: "active",
          isLive: true,
          volume24h: 33370,
          contracts: [{ label: "Atlanta", status: "active", instrumentSymbol: "GEMI-MLB-2609301800-PHI-ATL-M-ATL" }],
        },
        {
          title: "BTC price on September 30",
          status: "active",
          isLive: false,
          volume24h: "15275.5",
          contracts: [{ label: "Above 92500", status: "active", instrumentSymbol: "GEMI-BTC2609302100-HI92500" }],
        },
      ],
      pagination: { limit: 50, offset: 0, total: 992 },
    };
    const [game, btc] = extractMarkets(body);
    expect(game).toMatchObject({ symbol: "GEMI-MLB-2609301800-PHI-ATL-M-ATL", live: true, volume24h: 33370 });
    expect(btc).toMatchObject({ symbol: "GEMI-BTC2609302100-HI92500", live: false, volume24h: 15275.5 });
  });
});
