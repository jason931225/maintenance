// Server-owned workspace persistence (UI-M1b, AD-4).
//
// The layout is a per-person JSON blob behind GET/PUT /api/v1/me/workspace. We
// load once on shell mount (sanitizing the untrusted blob), then debounce-save
// on every panel change. localStorage is intentionally NOT used — the server
// profile is the single source of truth so the layout follows the person across
// devices.

import { useEffect, useRef } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { sanitizeEnvelope } from "./sanitize";
import { useWorkspaceStore } from "./store";
import { WORKSPACE_SCHEMA_VERSION, type Panel } from "./types";

const SAVE_DEBOUNCE_MS = 600;

// The endpoint stores an opaque JSON object under `layout`; our schema-versioned
// envelope lives inside it.
function toLayout(panels: Panel[]) {
  return {
    v: WORKSPACE_SCHEMA_VERSION,
    panels: panels.map((p) => ({
      screen: p.screen,
      area: p.area,
      mode: p.mode,
      object: p.object,
      float: p.mode === "float" ? p.float : undefined,
    })),
  };
}

export function useWorkspacePersistence(api: ConsoleApiClient, enabled: boolean) {
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const saveTimer = useRef<number | undefined>(undefined);

  // Initial load. Always marks the store hydrated (even on failure / first-ever
  // empty profile) so subsequent edits are allowed to save.
  useEffect(() => {
    if (!enabled) return undefined;
    // Property access (not a narrowable `let`) so the async cancel check reads
    // as a real runtime condition to the type-aware lint.
    const live = { current: true };
    void (async () => {
      const res = (await api
        .GET("/api/v1/me/workspace")
        .catch(() => undefined)) as { data?: { layout?: unknown } } | undefined;
      if (!live.current) return;
      hydrate(sanitizeEnvelope(res?.data?.layout).panels);
    })();
    return () => {
      live.current = false;
    };
  }, [api, enabled, hydrate]);

  // Debounced save on panel changes, after hydration.
  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = useWorkspaceStore.subscribe((state, prev) => {
      if (!state.hydrated || state.panels === prev.panels) return;
      window.clearTimeout(saveTimer.current);
      const snapshot = state.panels;
      saveTimer.current = window.setTimeout(() => {
        void api
          .PUT("/api/v1/me/workspace", { body: { layout: toLayout(snapshot) } })
          .catch(() => undefined);
      }, SAVE_DEBOUNCE_MS);
    });
    return () => {
      window.clearTimeout(saveTimer.current);
      unsubscribe();
    };
  }, [api, enabled]);
}
