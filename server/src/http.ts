import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { App } from "./app";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

/**
 * HTTP + WebSocket server for the dashboard.
 *   GET  /api/state            current state (for debugging)
 *   GET  /api/markets          discovered contracts
 *   POST /api/symbol           { symbol }  switch markets
 *   POST /api/faults/drop      { count }   drop the next N book updates
 *   POST /api/faults/corrupt              silently change a size in the local book
 *   POST /api/faults/disconnect           cut the exchange connection
 *   WS   /stream               state pushed every broadcastMs
 */
export function createServer(app: App, opts: { staticDir: string; broadcastMs?: number }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname.startsWith("/api/")) return await handleApi(app, req, res, url.pathname);
      return serveStatic(opts.staticDir, url.pathname, res);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ server, path: "/stream" });
  const push = () => {
    if (wss.clients.size === 0) return;
    const data = JSON.stringify(app.buildState());
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  };
  wss.on("connection", (ws) => ws.send(JSON.stringify(app.buildState())));
  const timer = setInterval(push, opts.broadcastMs ?? 100);
  server.on("close", () => clearInterval(timer));

  return server;
}

async function handleApi(app: App, req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  if (req.method === "GET" && pathname === "/api/state") return json(res, 200, app.buildState());
  if (req.method === "GET" && pathname === "/api/markets") return json(res, 200, app.markets);

  if (req.method === "POST" && pathname === "/api/symbol") {
    const body = await readJson(req);
    if (typeof body.symbol !== "string" || !body.symbol.trim()) return json(res, 400, { error: "symbol is required" });
    app.selectSymbol(body.symbol.trim());
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && pathname === "/api/faults/drop") {
    const body = await readJson(req);
    const count = Math.max(1, Math.min(500, Math.floor(Number(body.count ?? 3))));
    app.feed.dropNext(count);
    return json(res, 200, { ok: true, count });
  }
  if (req.method === "POST" && pathname === "/api/faults/corrupt") {
    app.feed.corruptBook();
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && pathname === "/api/faults/disconnect") {
    app.feed.killConnection();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "not found" });
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse) {
  if (!existsSync(root)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Dashboard not built. Run `npm run build`, or use `npm run dev` for the dev server.");
    return;
  }
  const resolvedRoot = path.resolve(root);
  let file = path.resolve(resolvedRoot, "." + decodeURIComponent(pathname));
  // Block path traversal outside the build folder.
  if (!file.startsWith(resolvedRoot)) return json(res, 403, { error: "forbidden" });
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(resolvedRoot, "index.html");
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("request body too large");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
