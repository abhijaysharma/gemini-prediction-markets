import { useEffect, useState } from "react";
import type { MarketInfo, StatePayload } from "../../server/src/types";

/** Subscribes to the server's state stream and reconnects if it drops. */
export function useStream() {
  const [state, setState] = useState<StatePayload | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;

    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/stream`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => setState(JSON.parse(ev.data));
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = window.setTimeout(open, 1000);
      };
    };
    open();

    return () => {
      closed = true;
      window.clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { state, connected };
}

export function useMarkets() {
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/markets")
        .then((r) => r.json())
        .then((m) => alive && setMarkets(m))
        .catch(() => {});
    load();
    const t = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  return markets;
}

export async function post(path: string, body: unknown = {}) {
  await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
