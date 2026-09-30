import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard lives in web/. In dev, Vite proxies API calls and the
// state stream to the Node server on :8787.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/stream": { target: "ws://localhost:8787", ws: true },
    },
  },
});
