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

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { sanitizeEnvelope } from "./sanitize";
import { useWorkspaceStore } from "./store";
import { WORKSPACE_SCHEMA_VERSION, type Panel } from "./types";

const SAVE_DEBOUNCE_MS = 600;

interface PendingSave {
  ownerKey: string;
  panels: Panel[];
}

// The endpoint stores an opaque JSON object under `layout`; our schema-versioned
// envelope lives inside it.
function toLayout(panels: Panel[]) {
  return {
    v: WORKSPACE_SCHEMA_VERSION,
    panels: panels.map((p) => ({
      screen: p.screen,
      area: p.area,
      mode: p.mode,
      object: {
        kind: p.object.kind,
        code: p.object.code,
      },
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
  ownerKey: string | undefined,
) {
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const resetForOwner = useWorkspaceStore((s) => s.resetForOwner);
  const saveTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(
    undefined,
  );
  const pendingSave = useRef<PendingSave | null>(null);
  const saveInFlightOwner = useRef<string | null>(null);
  const liveRef = useRef(false);
  const ownerKeyRef = useRef<string | undefined>(ownerKey);
  // `api` changes on token refresh (memoized on the access token); pin the
  // effects to a ref so a mid-session refresh does not re-run the load or
  // resubscribe — otherwise every refresh re-GETs and re-hydrates.
  const apiRef = useRef(api);
  useLayoutEffect(() => {
    apiRef.current = api;
  }, [api]);

  const flushRef = useRef<
    (retryOnFailure?: boolean, ownerOverride?: string) => void
  >(() => undefined);
  const scheduleSave = useCallback((panels?: Panel[]) => {
    const activeOwner = ownerKeyRef.current;
    if (!liveRef.current || !activeOwner) return;
    if (panels) pendingSave.current = { ownerKey: activeOwner, panels };
    if (saveTimer.current !== undefined) {
      globalThis.clearTimeout(saveTimer.current);
    }
    saveTimer.current = globalThis.setTimeout(() => {
      flushRef.current();
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const flush = useCallback((retryOnFailure = true, ownerOverride?: string) => {
    const pending = pendingSave.current;
    const activeOwner = ownerOverride ?? ownerKeyRef.current;
    if (
      pending === null ||
      saveInFlightOwner.current === activeOwner ||
      !activeOwner ||
      pending.ownerKey !== activeOwner
    ) {
      return;
    }
    const panels = pending.panels;
    const layout = toLayout(panels);
    pendingSave.current = null;
    if (saveTimer.current !== undefined) {
      globalThis.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    saveInFlightOwner.current = activeOwner;
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
        if (
          !retryOnFailure ||
          !liveRef.current ||
          ownerKeyRef.current !== activeOwner
        ) {
          return;
        }
        // Keep the dirty layout if the write fails. If the user edited again
        // while the PUT was in flight, that newer pending layout wins.
        if (pendingSave.current === null) {
          pendingSave.current = { ownerKey: activeOwner, panels };
        }
      })
      .finally(() => {
        if (saveInFlightOwner.current === activeOwner) {
          saveInFlightOwner.current = null;
        }
        if (
          retryOnFailure &&
          liveRef.current &&
          ownerKeyRef.current === activeOwner &&
          pendingSave.current !== null
        ) {
          scheduleSave();
        }
      });
  }, [scheduleSave]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  // Owner changes must reset the global workspace store before paint. Waiting
  // for a passive effect leaves a narrow window where newly rendered controls
  // can still mutate the previous owner's panels.
  useLayoutEffect(() => {
    if (!enabled || !ownerKey) {
      ownerKeyRef.current = ownerKey;
      liveRef.current = false;
      pendingSave.current = null;
      if (saveTimer.current !== undefined) {
        globalThis.clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
      }
      return undefined;
    }

    ownerKeyRef.current = ownerKey;
    liveRef.current = true;
    pendingSave.current = null;
    if (saveTimer.current !== undefined) {
      globalThis.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    resetForOwner(ownerKey);

    return () => {
      flush(false, ownerKey);
      liveRef.current = false;
      if (saveTimer.current !== undefined) {
        globalThis.clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
      }
    };
  }, [enabled, flush, ownerKey, resetForOwner]);

  // Initial load — once per mount. Success (even empty) enables saves; failure
  // hydrates empty with saves disabled so the next edit cannot clobber the server.
  useEffect(() => {
    if (!enabled || !ownerKey) return undefined;
    const live = { current: true };
    const startPanels = useWorkspaceStore.getState().panels;
    void (async () => {
      const res = (await apiRef.current
        .GET("/api/v1/me/workspace")
        .catch(() => undefined)) as
        | { data?: { layout?: unknown }; response?: { ok?: boolean } }
        | undefined;
      if (!live.current || ownerKeyRef.current !== ownerKey) return;
      const currentPanels = useWorkspaceStore.getState().panels;
      const editedDuringLoad = currentPanels !== startPanels;
      if (res?.response?.ok !== true) {
        hydrate(editedDuringLoad ? currentPanels : [], false, ownerKey);
        return;
      }
      const loadedPanels = sanitizeEnvelope(res.data?.layout).panels;
      const panels = editedDuringLoad
        ? mergeLoadedPanels(loadedPanels, currentPanels)
        : loadedPanels;
      hydrate(panels, true, ownerKey);
      if (editedDuringLoad) scheduleSave(panels);
    })();
    return () => {
      live.current = false;
    };
  }, [enabled, hydrate, ownerKey, scheduleSave]);

  // Debounced save on panel changes, after a successful load.
  useEffect(() => {
    if (!enabled || !ownerKey) return undefined;
    const unsubscribe = useWorkspaceStore.subscribe((state, prev) => {
      // Skip the hydrate transition (prev.hydrated=false) — that is a load, not
      // a user edit — and never save when the load failed (saveEnabled=false).
      if (
        state.ownerKey !== ownerKey ||
        !prev.hydrated ||
        !state.saveEnabled ||
        state.panels === prev.panels
      ) {
        return;
      }
      scheduleSave(state.panels);
    });
    return () => {
      unsubscribe();
      flush(false, ownerKey); // one best-effort flush on exit; never retry after teardown
    };
  }, [enabled, flush, ownerKey, scheduleSave]);
}
