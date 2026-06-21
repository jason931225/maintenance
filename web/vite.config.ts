import type { IncomingMessage } from "node:http";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Dev-only: proxy API/WS/OpenAPI to the local backend so the console runs
// same-origin (the backend sets no CORS headers). Override the target with
// VITE_PROXY_TARGET. Has no effect on `vite build` / production.
const proxyTarget = process.env.VITE_PROXY_TARGET ?? "http://127.0.0.1:8080";

// Shared by the dev server and `vite preview`. The preview server serves the
// production build but, unlike the dev server, does not proxy by default — the
// browser-E2E harness runs against `vite preview` and needs the same same-origin
// /api proxy so WebAuthn ceremonies stay on the Vite origin (no CORS).
const apiProxy = {
  "/api": { target: proxyTarget, changeOrigin: true, ws: true },
  // The vendor platform-admin console calls the `/platform/*` data API (an
  // internal API intentionally not under `/api`). These collide in path space
  // with the client-side SPA routes (/platform/tenants, /platform/ops, …), so we
  // forward ONLY the data endpoints to the backend and let the SPA navigations
  // (HTML document loads) fall through to the static build. `/platform/orgs` is
  // backend-only; `/platform/ops` is shared, so route it by Accept: a JSON fetch
  // (the ops API) proxies to the backend, an HTML navigation serves the SPA.
  "/platform/orgs": { target: proxyTarget, changeOrigin: true },
  "/platform/ops": {
    target: proxyTarget,
    changeOrigin: true,
    // An HTML document navigation to the SPA route `/platform/ops` must be served
    // locally, while a JSON `fetch` to the ops data API must be proxied to the
    // backend. `bypass` returning a path serves it locally (skips the proxy);
    // returning undefined proxies it to the backend.
    bypass: (req: IncomingMessage) => {
      const accept = req.headers["accept"];
      const acceptsHtml =
        typeof accept === "string" && accept.includes("text/html");
      return acceptsHtml ? "/index.html" : undefined;
    },
  },
  "/openapi": { target: proxyTarget, changeOrigin: true },
  "/healthz": { target: proxyTarget, changeOrigin: true },
  "/readyz": { target: proxyTarget, changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
