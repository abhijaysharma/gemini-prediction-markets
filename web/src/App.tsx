import { LoaderCircle } from "lucide-react";
import { FaultPanel } from "./components/FaultPanel";
import { HealthPanel } from "./components/HealthPanel";
import { IntegrityStrip } from "./components/IntegrityStrip";
import { EventLog } from "./components/EventLog";
import { KpiRow } from "./components/KpiRow";
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
        <div className="glass boot-card">
          <LoaderCircle size={28} strokeWidth={1.5} className="spin" aria-hidden="true" />
          <p>{connected ? "Waiting for the first update from the server" : "Connecting to the local server on port 8787"}</p>
          <p className="muted">
            Start it with <code>npm run dev</code>, or <code>npm run dev:mock</code> to use synthetic data.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <TopBar state={state} markets={markets} connected={connected} />
      <IntegrityStrip state={state} />
      <KpiRow state={state} />
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
