import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Dev-only: proxy API/WS/OpenAPI to the local backend so the console runs
// same-origin (the backend sets no CORS headers). Override the target with
// VITE_PROXY_TARGET. Has no effect on `vite build` / production.
const proxyTarget = process.env.VITE_PROXY_TARGET ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: proxyTarget, changeOrigin: true, ws: true },
      "/openapi": { target: proxyTarget, changeOrigin: true },
      "/healthz": { target: proxyTarget, changeOrigin: true },
      "/readyz": { target: proxyTarget, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
