import type { Trade } from "../../../server/src/types";
import { fmtClock, fmtQty } from "../format";

export function TradeTape({ trades }: { trades: Trade[] }) {
  return (
    <section className="panel trades">
      <header className="panel-head">
        <h2>Trades</h2>
        <span className="muted">Side shown is the taker</span>
      </header>
      {trades.length === 0 ? (
        <p className="muted empty">No trades yet on this contract.</p>
      ) : (
        <div className="tape-table" role="table">
          {trades.map((t) => (
            <div key={t.id} className={`trade trade-${t.side}`} role="row">
              <span className="muted">{fmtClock(t.timeMs)}</span>
              <span className="side">{t.side === "buy" ? "Buy" : "Sell"}</span>
              <span className="num">{t.price}</span>
              <span className="num">{fmtQty(t.qty)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
