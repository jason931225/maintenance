// Server-owned workspace persistence (UI-M1b, AD-4).
//
// The layout is a per-person JSON blob behind GET/PUT /api/v1/me/workspace. We
// load once on shell mount (sanitizing the untrusted blob), then debounce-save
// on panel changes. localStorage is intentionally NOT used — the server profile
// is the single source of truth so the layout follows the person across devices.
//
// Data-loss guard: a transient GET failure must NOT overwrite the real server
// layout. On failure we hydrate an empty in-memory layout with saves DISABLED
// (store.saveEnabled=false); saves turn on only after a successful load.

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
  const pendingSave = useRef<Panel[] | null>(null);
  // `api` changes on token refresh (memoized on the access token); pin the
  // effects to a ref so a mid-session refresh does not re-run the load or
  // resubscribe — otherwise every refresh re-GETs and re-hydrates.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  // Initial load — once per mount. Success (even empty) enables saves; failure
  // hydrates empty with saves disabled so the next edit cannot clobber the server.
  useEffect(() => {
    if (!enabled) return undefined;
    const live = { current: true };
    void (async () => {
      const res = (await apiRef.current
        .GET("/api/v1/me/workspace")
        .catch(() => undefined)) as
        | { data?: { layout?: unknown }; response?: { ok?: boolean } }
        | undefined;
      if (!live.current) return;
      if (res?.response?.ok !== true) {
        hydrate([], false);
        return;
      }
      hydrate(sanitizeEnvelope(res.data?.layout).panels, true);
    })();
    return () => {
      live.current = false;
    };
  }, [enabled, hydrate]);

  // Debounced save on panel changes, after a successful load.
  useEffect(() => {
    if (!enabled) return undefined;
    const flush = () => {
      if (pendingSave.current === null) return;
      const layout = toLayout(pendingSave.current);
      pendingSave.current = null;
      window.clearTimeout(saveTimer.current);
      void apiRef.current
        .PUT("/api/v1/me/workspace", { body: { layout } })
        .catch(() => undefined);
    };
    const unsubscribe = useWorkspaceStore.subscribe((state, prev) => {
      // Skip the hydrate transition (prev.hydrated=false) — that is a load, not
      // a user edit — and never save when the load failed (saveEnabled=false).
      if (!prev.hydrated || !state.saveEnabled || state.panels === prev.panels) return;
      pendingSave.current = state.panels;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      flush(); // flush a pending debounced save on exit rather than dropping it
    };
  }, [enabled]);
}
