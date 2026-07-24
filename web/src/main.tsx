import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import pretendard400Url from "@fontsource/pretendard/files/pretendard-latin-400-normal.woff2?url";
import { AuthProvider } from "./context/auth";
import { AppRouter } from "./AppRouter";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RouteTelemetry } from "./telemetry/routeTelemetry";
import "./styles.css";

// Preload the default body weight so first paint isn't blocked on its request.
// Vite content-hashes the font, so we inject the <link> with the resolved
// same-origin URL — this keeps the strict `font-src 'self'` CSP valid and
// avoids hardcoding a per-build hash into index.html.
const fontPreload = document.createElement("link");
fontPreload.rel = "preload";
fontPreload.as = "font";
fontPreload.type = "font/woff2";
fontPreload.crossOrigin = "anonymous";
fontPreload.href = pretendard400Url;
document.head.appendChild(fontPreload);

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <RouteTelemetry />
          <AppRouter />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
