import { useEffect, useState } from "react";
import type { MarketInfo, RewardsState, StatePayload } from "../../server/src/types";

/**
 * Subscribes to the server's state stream and reconnects if it drops. A tab
 * in the background disconnects, since nobody is watching it, and reconnects
 * when it's visible again.
 */
export function useStream() {
  const [state, setState] = useState<StatePayload | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;

    const open = () => {
      if (ws || document.hidden) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${location.host}/stream`);
      ws = socket;
      socket.onopen = () => setConnected(true);
      socket.onmessage = (ev) => setState(JSON.parse(ev.data));
      socket.onclose = () => {
        if (ws === socket) ws = null;
        setConnected(false);
        if (!closed) retry = window.setTimeout(open, 1000);
      };
    };
    const onVisibility = () => {
      if (document.hidden) {
        window.clearTimeout(retry);
        const socket = ws;
        ws = null;
        socket?.close();
      } else {
        open();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    open();

    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisibility);
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

/**
 * Polls the server's reward estimates while the Rewards tab is open and
 * visible. The first call starts the tracker; a public deployment stops it
 * again once nobody has polled for a while, so a hidden tab mustn't poll.
 */
export function useRewards(active: boolean) {
  const [rewards, setRewards] = useState<RewardsState | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      fetch("/api/rewards")
        .then((r) => r.json())
        .then((s) => alive && setRewards(s))
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, 5_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", load);
    };
  }, [active]);
  return rewards;
}

export type View = "book" | "rewards";

/** The current tab, kept in the URL hash so it survives a reload and can be linked. */
export function useView(): [View, (v: View) => void] {
  const read = (): View => (location.hash === "#rewards" ? "rewards" : "book");
  const [view, setView] = useState<View>(read);
  useEffect(() => {
    const onHash = () => setView(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return [view, (v) => (location.hash = v === "rewards" ? "rewards" : "")];
}
