import type { Trade } from "../../../server/src/types";
import { fmtClock, fmtQty } from "../format";

export function TradeTape({ trades }: { trades: Trade[] }) {
  return (
    <section className="glass panel trades">
      <header className="panel-head">
        <h2>Trades</h2>
        <span className="meta">Side is the taker</span>
      </header>
      {trades.length === 0 ? (
        <p className="empty">No trades yet on this contract.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Side</th>
                <th className="r">Price</th>
                <th className="r">Size</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td className="time">{fmtClock(t.timeMs)}</td>
                  <td>
                    <span className={`chip ${t.side === "buy" ? "chip-pos" : "chip-neg"}`}>
                      {t.side === "buy" ? "Buy" : "Sell"}
                    </span>
                  </td>
                  <td className="r">{t.price}</td>
                  <td className="r">{fmtQty(t.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
