import { ChartCandlestick, ChevronDown, Layers } from "lucide-react";
import type { MarketInfo, StatePayload } from "../../../server/src/types";
import { post } from "../useStream";

export function TopBar({ state, markets, connected }: { state: StatePayload; markets: MarketInfo[]; connected: boolean }) {
  const options = [...markets];
  if (state.symbol && !options.some((m) => m.symbol === state.symbol)) {
    options.unshift({ symbol: state.symbol, title: null, status: null });
  }

  return (
    <header className="glass topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Layers size={17} strokeWidth={1.5} />
        </span>
        <div>
          <h1>Book integrity monitor</h1>
          <p>Self-healing local order book for Gemini prediction markets</p>
        </div>
      </div>
      <label className="picker">
        <ChartCandlestick size={15} strokeWidth={1.5} className="picker-icon" aria-hidden="true" />
        <select
          aria-label="Market"
          value={state.symbol ?? ""}
          onChange={(e) => void post("/api/symbol", { symbol: e.target.value })}
          disabled={options.length === 0}
        >
          {options.length === 0 && <option value="">Discovering markets</option>}
          {options.map((m) => (
            <option key={m.symbol} value={m.symbol}>
              {m.title ? `${m.title} (${m.symbol})` : m.symbol}
            </option>
          ))}
        </select>
        <ChevronDown size={15} strokeWidth={1.5} className="picker-chevron" aria-hidden="true" />
      </label>
      <div className="source">
        {state.mode === "mock" ? (
          <span className="chip chip-warn" title="Synthetic data from the local mock exchange">
            Mock data
          </span>
        ) : (
          <span className="chip chip-pos chip-live">Live · ws.gemini.com</span>
        )}
        {!connected && <span className="chip chip-neg">Dashboard disconnected</span>}
      </div>
    </header>
  );
}
