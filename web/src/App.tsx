import { FaultPanel } from "./components/FaultPanel";
import { HealthPanel } from "./components/HealthPanel";
import { IntegrityStrip } from "./components/IntegrityStrip";
import { EventLog } from "./components/EventLog";
import { Ladder } from "./components/Ladder";
import { MidChart } from "./components/MidChart";
import { TopBar } from "./components/TopBar";
import { TradeTape } from "./components/TradeTape";
import { useMarkets, useStream } from "./useStream";

export function App() {
  const { state, connected } = useStream();
  const markets = useMarkets();

  if (!state) {
    return (
      <div className="boot">
        <p>{connected ? "Waiting for the first update from the server" : "Connecting to the local server on port 8787"}</p>
        <p className="muted">Start it with npm run dev, or npm run dev:mock to use synthetic data.</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <TopBar state={state} markets={markets} connected={connected} />
      <IntegrityStrip state={state} />
      <main className="grid">
        <Ladder state={state} />
        <section className="center">
          <MidChart mids={state.mids} />
          <TradeTape trades={state.trades} />
        </section>
        <aside className="side">
          <FaultPanel state={state} />
          <HealthPanel state={state} />
          <EventLog log={state.log} />
        </aside>
      </main>
    </div>
  );
}
