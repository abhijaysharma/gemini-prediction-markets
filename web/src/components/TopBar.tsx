import type { MarketInfo, StatePayload } from "../../../server/src/types";
import { post } from "../useStream";

export function TopBar({ state, markets, connected }: { state: StatePayload; markets: MarketInfo[]; connected: boolean }) {
  const options = [...markets];
  if (state.symbol && !options.some((m) => m.symbol === state.symbol)) {
    options.unshift({ symbol: state.symbol, title: null, status: null });
  }

  return (
    <header className="topbar">
      <div className="brand">
        <h1>Book integrity monitor</h1>
        <span className="muted">A self-healing local order book for Gemini prediction markets</span>
      </div>
      <label className="picker">
        <span className="muted">Market</span>
        <select
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
      </label>
      <div className="source">
        {state.mode === "mock" ? (
          <span className="tag tag-mock" title="Synthetic data from the local mock exchange">
            Mock data
          </span>
        ) : (
          <span className="tag tag-live">Live from ws.gemini.com</span>
        )}
        {!connected && <span className="tag tag-fault">Dashboard disconnected</span>}
      </div>
    </header>
  );
}
