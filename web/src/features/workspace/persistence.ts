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

import { useCallback, useEffect, useRef } from "react";

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

function mergeLoadedPanels(loaded: Panel[], live: Panel[]): Panel[] {
  const byId = new Map(loaded.map((panel) => [panel.id, panel]));
  for (const panel of live) byId.set(panel.id, panel);
  return Array.from(byId.values());
}

export function useWorkspacePersistence(
  api: ConsoleApiClient,
  enabled: boolean,
) {
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingSave = useRef<Panel[] | null>(null);
  const saveInFlight = useRef(false);
  // `api` changes on token refresh (memoized on the access token); pin the
  // effects to a ref so a mid-session refresh does not re-run the load or
  // resubscribe — otherwise every refresh re-GETs and re-hydrates.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const flushRef = useRef<() => void>(() => undefined);
  const scheduleSave = useCallback((panels?: Panel[]) => {
    if (panels) pendingSave.current = panels;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      flushRef.current();
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const flush = useCallback(() => {
    if (pendingSave.current === null || saveInFlight.current) return;
    const panels = pendingSave.current;
    const layout = toLayout(panels);
    pendingSave.current = null;
    window.clearTimeout(saveTimer.current);
    saveInFlight.current = true;
    void apiRef.current
      .PUT("/api/v1/me/workspace", { body: { layout } })
      .then((res) => {
        if (
          (res as { response?: { ok?: boolean } } | undefined)?.response
            ?.ok === false
        ) {
          throw new Error("workspace save failed");
        }
      })
      .catch(() => {
        // Keep the dirty layout if the write fails. If the user edited again
        // while the PUT was in flight, that newer pending layout wins.
        if (pendingSave.current === null) pendingSave.current = panels;
      })
      .finally(() => {
        saveInFlight.current = false;
        if (pendingSave.current !== null) scheduleSave();
      });
  }, [scheduleSave]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  // Initial load — once per mount. Success (even empty) enables saves; failure
  // hydrates empty with saves disabled so the next edit cannot clobber the server.
  useEffect(() => {
    if (!enabled) return undefined;
    const live = { current: true };
    const startPanels = useWorkspaceStore.getState().panels;
    void (async () => {
      const res = (await apiRef.current
        .GET("/api/v1/me/workspace")
        .catch(() => undefined)) as
        | { data?: { layout?: unknown }; response?: { ok?: boolean } }
        | undefined;
      if (!live.current) return;
      const currentPanels = useWorkspaceStore.getState().panels;
      const editedDuringLoad = currentPanels !== startPanels;
      if (res?.response?.ok !== true) {
        hydrate(editedDuringLoad ? currentPanels : [], false);
        return;
      }
      const loadedPanels = sanitizeEnvelope(res.data?.layout).panels;
      const panels = editedDuringLoad
        ? mergeLoadedPanels(loadedPanels, currentPanels)
        : loadedPanels;
      hydrate(panels, true);
      if (editedDuringLoad) scheduleSave(panels);
    })();
    return () => {
      live.current = false;
    };
  }, [enabled, hydrate, scheduleSave]);

  // Debounced save on panel changes, after a successful load.
  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = useWorkspaceStore.subscribe((state, prev) => {
      // Skip the hydrate transition (prev.hydrated=false) — that is a load, not
      // a user edit — and never save when the load failed (saveEnabled=false).
      if (!prev.hydrated || !state.saveEnabled || state.panels === prev.panels)
        return;
      scheduleSave(state.panels);
    });
    return () => {
      unsubscribe();
      flush(); // flush a pending debounced save on exit rather than dropping it
    };
  }, [enabled, flush, scheduleSave]);
}
