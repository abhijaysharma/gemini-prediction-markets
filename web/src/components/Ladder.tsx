import type { Level, StatePayload } from "../../../server/src/types";
import { fmtQty } from "../format";

const ROWS = 14;

export function Ladder({ state }: { state: StatePayload }) {
  const { book, symbol } = state;
  const asks = [...book.asks].slice(0, ROWS);
  const bids = book.bids.slice(0, ROWS);
  const maxQty = Math.max(1, ...asks.map(([, q]) => Number(q)), ...bids.map(([, q]) => Number(q)));
  const isEventContract = symbol?.toUpperCase().startsWith("GEMI-") ?? false;

  // Asks render top-down from worst to best so the best ask sits on the spread.
  const askRows: (Level | null)[] = [...Array(ROWS - asks.length).fill(null), ...asks.reverse()];
  const bidRows: (Level | null)[] = [...bids, ...Array(ROWS - bids.length).fill(null)];

  return (
    <section className="glass panel ladder">
      <header className="panel-head">
        <h2>Order book</h2>
        {isEventContract && <span className="meta">YES side</span>}
      </header>
      <div className="ladder-cols">
        <span>Price</span>
        <span>Size</span>
      </div>
      <div className="ladder-body">
        {askRows.map((l, i) => (
          <Row key={`a${i}`} level={l} side="ask" maxQty={maxQty} />
        ))}
        <div className="spread">
          {book.spread !== null ? (
            <>
              <span>
                Spread<strong>{trim(book.spread)}</strong>
              </span>
              <span>
                Mid<strong>{trim(book.mid!)}</strong>
              </span>
            </>
          ) : (
            <span>No two-sided market</span>
          )}
        </div>
        {bidRows.map((l, i) => (
          <Row key={`b${i}`} level={l} side="bid" maxQty={maxQty} />
        ))}
      </div>
      <footer className="panel-foot">
        {book.bidLevels} bid and {book.askLevels} ask levels held locally
      </footer>
    </section>
  );
}

function Row({ level, side, maxQty }: { level: Level | null; side: "bid" | "ask"; maxQty: number }) {
  if (!level) return <div className="row row-empty" />;
  const [price, qty] = level;
  const width = `${Math.max(2, (Number(qty) / maxQty) * 100)}%`;
  return (
    <div className={`row row-${side}`}>
      <span className="depth" style={{ width }} />
      <span className="price">{price}</span>
      <span className="qty">{fmtQty(qty)}</span>
    </div>
  );
}

function trim(n: number) {
  return Number(n.toFixed(6)).toString();
}
