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
  // Includes the vendor platform-admin data API at `/api/platform/*`: it lives
  // under `/api` precisely so a single proxy rule reaches it with NO collision
  // with the SPA's own `/platform/*` browser routes (which the client-side router
  // owns and serves from the static build, falling through this proxy untouched).
  "/api": { target: proxyTarget, changeOrigin: true, ws: true },
  "/openapi": { target: proxyTarget, changeOrigin: true },
  "/healthz": { target: proxyTarget, changeOrigin: true },
  "/readyz": { target: proxyTarget, changeOrigin: true },
};

const plugins = [react(), tailwindcss()].flat() as never[];

export default defineConfig({
  plugins,
  server: {
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost/",
      },
    },
    setupFiles: ["./src/test/setup.ts"],
    // Browser/unit tests live under src/. Node's built-in test runner owns the
    // production dev-auth artifact guards in scripts/; including those files in
    // Vitest yields zero-suite failures and bypasses their intended runner.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // AppRouter/full-suite jsdom workers lazily transform large route modules;
    // the default 5s test timeout races that cold path on CI/local Macs even
    // when the page eventually renders correctly.
    testTimeout: 60_000,
    // Workers rendering <AppRouter /> with lazy routes can keep the jsdom event
    // loop alive after tests complete, causing the fork to hang until OOM (seen
    // as a ~80min CI run). Cap the teardown window so the fork is forcibly
    // terminated rather than leaking into an OOM crash.
    teardownTimeout: 10_000,
  },
});
