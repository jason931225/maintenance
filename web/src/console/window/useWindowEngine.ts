// Carbon-copy window/pin engine — the React hook (charter §3 P0.2).
//
// Holds the four-state card engine and wires it to per-user server persistence
// (GET/PUT /api/v1/me/workspace). The engine's own state is namespaced under a
// `consoleWindow` key inside the opaque workspace blob and merged on write, so
// it never clobbers other workspace consumers (the legacy UI-M1b shell writes
// `panels` to the same blob during the two-shell period). Persistence borrows
// the legacy data-loss guard: a failed initial GET hydrates empty with saves
// DISABLED, so the next edit cannot overwrite the real server layout.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import {
  isHeaderGesture,
  NARROW_MAX,
  pinnedFloat,
  popoutFloatAtCursor,
  reanchorFloat,
  snapFloat,
  TRAY_GRAB,
} from "./geometry";
import { defaultWindowState, sanitizeWindowState } from "./sanitize";
import type { CardFloat, CardRegistry, Chrome, Viewport, WindowState } from "./types";
import { floatKey } from "./types";

const SAVE_DEBOUNCE_MS = 600;
const WINDOW_KEY = "consoleWindow";

export interface HoverTarget {
  scr: string;
  id: string;
}

export interface WindowEngine {
  state: WindowState;
  viewport: Viewport;
  hover: HoverTarget | null;
  /** Begin a header drag (popout on desktop, pin on narrow). */
  grab: (scr: string, id: string, e: React.MouseEvent) => void;
  /** Toggle pin-split (space-reserving). Also the dblclick target. */
  pinRight: (scr: string, id: string) => void;
  /** Toggle a centered free-floating popout. */
  popOut: (scr: string, id: string) => void;
  /** Return a card to its default zone position (the X / close action). */
  restoreDefault: (scr: string, id: string) => void;
  /** Toggle tray-minimize. */
  minToggle: (scr: string, id: string) => void;
  setHover: (t: HoverTarget | null) => void;
  /** True while the initial server load has not yet succeeded/failed. */
  loading: boolean;
  /** The chrome (sidebar/rail collapse) the engine resolves floats against. */
  chrome: Chrome;
}

/** Return a copy of `obj` without `key` (avoids the `delete` operator). */
function without<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const next = { ...obj };
  Reflect.deleteProperty(next, key);
  return next;
}

/** Presence-checked index read (the float map is a partial record at runtime). */
function floatAt(float: Record<string, CardFloat>, key: string): CardFloat | undefined {
  return Object.prototype.hasOwnProperty.call(float, key) ? float[key] : undefined;
}

function readViewport(): Viewport {
  return {
    vw: typeof window !== "undefined" ? window.innerWidth : 1400,
    vh: typeof window !== "undefined" ? window.innerHeight : 900,
  };
}

export function useWindowEngine(opts: {
  registry: CardRegistry;
  api: ConsoleApiClient;
  ownerKey: string | undefined;
  chrome?: Chrome;
  /** Skip server persistence (unit tests / SSR). Defaults to true. */
  persist?: boolean;
}): WindowEngine {
  const { registry, api, ownerKey } = opts;
  const persist = opts.persist ?? true;
  const chrome = useMemo<Chrome>(
    () => opts.chrome ?? { sidebarCollapsed: false, railCollapsed: false },
    [opts.chrome],
  );

  const [state, setState] = useState<WindowState>(() => defaultWindowState(registry));
  const [viewport, setViewport] = useState<Viewport>(readViewport);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [loading, setLoading] = useState<boolean>(persist);

  // Refs the window-level drag listeners read so they never see a stale close.
  const stateRef = useRef(state);
  const vpRef = useRef(viewport);
  const chromeRef = useRef(chrome);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  useLayoutEffect(() => {
    vpRef.current = viewport;
  }, [viewport]);
  useLayoutEffect(() => {
    chromeRef.current = chrome;
  }, [chrome]);

  // --- viewport tracking + anchored-float re-flow ---------------------------
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => {
      setViewport(readViewport());
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // Re-resolve anchored floats when the viewport or chrome changes (prototype
  // componentDidUpdate). Anchored pins/floats follow their edge; free floats
  // keep their pixel position (clamped). A re-flow is not a user edit, so it
  // never schedules a save.
  useEffect(() => {
    setState((s) => {
      let changed = false;
      const float: Record<string, CardFloat> = {};
      for (const [key, f] of Object.entries(s.float)) {
        const { x, y } = reanchorFloat(f, viewport, chrome);
        if (x !== f.x || y !== f.y) {
          changed = true;
          float[key] = { ...f, x, y };
        } else {
          float[key] = f;
        }
      }
      return changed ? { ...s, float } : s;
    });
  }, [viewport, chrome]);

  // --- persistence: full workspace blob minus our key, preserved on write ----
  const apiRef = useRef(api);
  useLayoutEffect(() => {
    apiRef.current = api;
  }, [api]);
  const otherKeysRef = useRef<Record<string, unknown>>({});
  const saveEnabledRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ownerRef = useRef(ownerKey);
  useLayoutEffect(() => {
    ownerRef.current = ownerKey;
  }, [ownerKey]);

  const flush = useCallback(() => {
    if (!saveEnabledRef.current) return;
    saveTimer.current = undefined;
    const s = stateRef.current;
    const layout = { ...otherKeysRef.current, [WINDOW_KEY]: s };
    void apiRef.current.PUT("/api/v1/me/workspace", { body: { layout } }).catch(() => {
      // Keep local state; a later edit reschedules. Never wipe on failure.
    });
  }, []);

  const scheduleSave = useCallback(() => {
    if (!saveEnabledRef.current) return;
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [flush]);

  // Initial load — once per owner. Success (even empty) enables saves; failure
  // leaves saves disabled so no edit can clobber the server layout.
  useEffect(() => {
    if (!persist || !ownerKey) {
      setLoading(false);
      return undefined;
    }
    const live = { current: true };
    setLoading(true);
    saveEnabledRef.current = false;
    void (async () => {
      const res = (await apiRef.current
        .GET("/api/v1/me/workspace")
        .catch(() => undefined)) as
        | { data?: { layout?: unknown }; response?: { ok?: boolean } }
        | undefined;
      if (!live.current || ownerRef.current !== ownerKey) return;
      if (res?.response?.ok !== true || !res.data) {
        setLoading(false);
        return; // saves stay disabled — data-loss guard
      }
      const blob =
        typeof res.data.layout === "object" && res.data.layout !== null
          ? (res.data.layout as Record<string, unknown>)
          : {};
      const { [WINDOW_KEY]: mine, ...others } = blob;
      otherKeysRef.current = others;
      setState(sanitizeWindowState(mine, registry));
      saveEnabledRef.current = true;
      setLoading(false);
    })();
    return () => {
      live.current = false;
      if (saveTimer.current !== undefined) {
        clearTimeout(saveTimer.current);
        flush(); // best-effort flush on unmount
      }
    };
    // registry is a stable per-mount config; ownerKey drives reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persist, ownerKey, flush]);

  /** Apply a state change and schedule a persist. */
  const commit = useCallback(
    (fn: (s: WindowState) => WindowState) => {
      setState((s) => fn(s));
      scheduleSave();
    },
    [scheduleSave],
  );

  // --- drag lifecycle (prototype startFloatDrag) ----------------------------
  const drag = useRef<{
    key: string;
    x0: number;
    y0: number;
    ox: number;
    oy: number;
    lastY: number;
    hitAx: CardFloat["ax"];
    hitAy: CardFloat["ay"];
    move: (e: MouseEvent) => void;
    up: () => void;
  } | null>(null);

  const startFloatDrag = useCallback(
    (key: string, cx: number, cy: number, ox: number, oy: number) => {
      const move = (e: MouseEvent) => {
        const d = drag.current;
        if (!d) return;
        const cur = floatAt(stateRef.current.float, key);
        if (!cur) return;
        d.lastY = e.clientY;
        const nx = d.ox + e.clientX - d.x0;
        const ny = d.oy + e.clientY - d.y0;
        const snap = snapFloat(nx, ny, cur, vpRef.current, chromeRef.current);
        d.hitAx = snap.ax;
        d.hitAy = snap.ay;
        setState((s) => ({
          ...s,
          float: { ...s.float, [key]: { ...s.float[key], x: snap.x, y: snap.y } },
        }));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const vh = vpRef.current.vh || 900;
        const [scr, id] = key.split(":");
        // Drop below the tray band → minimize (drag-to-tray gesture).
        if (d.lastY > vh - TRAY_GRAB) {
          minToggleRef.current(scr, id);
          return;
        }
        commit((s) => {
          const f = floatAt(s.float, key);
          if (!f) return s;
          return { ...s, float: { ...s.float, [key]: { ...f, ax: d.hitAx, ay: d.hitAy } } };
        });
      };
      drag.current = { key, x0: cx, y0: cy, ox, oy, lastY: cy, hitAx: null, hitAy: null, move, up };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [commit],
  );

  useEffect(() => {
    return () => {
      const d = drag.current;
      if (d) {
        window.removeEventListener("mousemove", d.move);
        window.removeEventListener("mouseup", d.up);
        drag.current = null;
      }
    };
  }, []);

  // --- actions --------------------------------------------------------------
  const minToggle = useCallback(
    (scr: string, id: string) => {
      const key = floatKey(scr, id);
      commit((s) => {
        const isMin = s.min.some((q) => q.scr === scr && q.id === id);
        // minimize drops any float — restore returns to the default zone
        return {
          ...s,
          float: without(s.float, key),
          min: isMin ? s.min.filter((q) => !(q.scr === scr && q.id === id)) : [...s.min, { scr, id }],
        };
      });
      setHover(null);
    },
    [commit],
  );
  const minToggleRef = useRef(minToggle);
  useLayoutEffect(() => {
    minToggleRef.current = minToggle;
  }, [minToggle]);

  const pinRight = useCallback(
    (scr: string, id: string) => {
      const key = floatKey(scr, id);
      commit((s) => {
        const cur = floatAt(s.float, key);
        const float = cur?.pinned
          ? without(s.float, key)
          : { ...s.float, [key]: pinnedFloat(vpRef.current, chromeRef.current) };
        return { ...s, float, min: s.min.filter((q) => !(q.scr === scr && q.id === id)) };
      });
      setHover(null);
    },
    [commit],
  );

  const popOut = useCallback(
    (scr: string, id: string) => {
      const key = floatKey(scr, id);
      commit((s) => {
        const cur = floatAt(s.float, key);
        // Already an unpinned popout → toggle back to the zone.
        if (cur && !cur.pinned) {
          return { ...s, float: without(s.float, key) };
        }
        const area = vpRef.current;
        const w = 468;
        const h = 412;
        const float = {
          ...s.float,
          [key]: {
            x: Math.max(8, Math.round((area.vw - w) / 2)),
            y: 96,
            w,
            h,
            ax: "cx" as const,
            ay: null,
            pinned: false,
          },
        };
        return { ...s, float, min: s.min.filter((q) => !(q.scr === scr && q.id === id)) };
      });
      setHover(null);
    },
    [commit],
  );

  const restoreDefault = useCallback(
    (scr: string, id: string) => {
      const key = floatKey(scr, id);
      commit((s) => ({
        ...s,
        float: without(s.float, key),
        min: s.min.filter((q) => !(q.scr === scr && q.id === id)),
      }));
      setHover(null);
    },
    [commit],
  );

  const grab = useCallback(
    (scr: string, id: string, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (!isHeaderGesture(e.target, e.clientY, box.top)) return;
      e.preventDefault();
      const key = floatKey(scr, id);
      const existing = floatAt(stateRef.current.float, key);
      if (existing) {
        // Continue dragging an existing float; unpin first if it was pinned.
        if (existing.pinned) {
          setState((s) => ({
            ...s,
            float: { ...s.float, [key]: { ...s.float[key], pinned: false, dock: undefined } },
          }));
        }
        startFloatDrag(key, e.clientX, e.clientY, existing.x, existing.y);
        return;
      }
      if ((vpRef.current.vw || 1400) < NARROW_MAX) {
        pinRight(scr, id);
        return;
      }
      const fresh = popoutFloatAtCursor(e.clientX, e.clientY, vpRef.current);
      setState((s) => ({
        ...s,
        float: { ...s.float, [key]: fresh },
        min: s.min.filter((q) => !(q.scr === scr && q.id === id)),
      }));
      setHover(null);
      startFloatDrag(key, e.clientX, e.clientY, fresh.x, fresh.y);
    },
    [pinRight, startFloatDrag],
  );

  return {
    state,
    viewport,
    hover,
    grab,
    pinRight,
    popOut,
    restoreDefault,
    minToggle,
    setHover,
    loading,
    chrome,
  };
}
