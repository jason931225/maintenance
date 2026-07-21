import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { TrayDock, WindowFrame } from "./WindowFrame";
import { WindowManagerContext, type WindowManagerContextValue } from "./windowManagerContext";
import {
  clampPanelWidth,
  NARROW_BREAKPOINT,
  NARROW_PANEL_VH,
  PANEL_DEFAULT_WIDTH,
  QUADRANT_GAP,
  type WindowEntry,
  type WindowState,
} from "./windowModel";

interface Arrangement {
  pinnedId: string | null;
  minimizedIds: string[];
}

type SavedState = "pinned" | "minimized";

interface SavedLayout {
  states: Record<string, SavedState>;
  panelWidth: number;
}

const PARTITIONED_STORAGE_PREFIX = "oyatie.console.window.layout.v2";

function layoutStorageKey(
  authorityPartition: string | undefined,
): string | undefined {
  const normalized = authorityPartition?.trim();
  return normalized
    ? `${PARTITIONED_STORAGE_PREFIX}.${encodeURIComponent(normalized)}`
    : undefined;
}

function readSavedLayout(storageKey: string | undefined): SavedLayout {
  if (!storageKey) {
    return { states: {}, panelWidth: PANEL_DEFAULT_WIDTH };
  }
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (!raw) return { states: {}, panelWidth: PANEL_DEFAULT_WIDTH };
    const parsed = JSON.parse(raw) as Partial<SavedLayout> | null;
    return {
      states: parsed?.states ?? {},
      panelWidth: clampPanelWidth(parsed?.panelWidth ?? PANEL_DEFAULT_WIDTH),
    };
  } catch {
    return { states: {}, panelWidth: PANEL_DEFAULT_WIDTH };
  }
}

function writeSavedLayout(
  storageKey: string | undefined,
  layout: SavedLayout,
): void {
  if (!storageKey) return;
  try {
    globalThis.localStorage.setItem(storageKey, JSON.stringify(layout));
  } catch {
    // storage unavailable/quota — layout stays in-memory only
  }
}

function clearSavedLayout(storageKey: string | undefined): void {
  if (!storageKey) return;
  try {
    globalThis.localStorage.removeItem(storageKey);
  } catch {
    // ignore
  }
}

function isNarrow(): boolean {
  return typeof window !== "undefined" && window.innerWidth < NARROW_BREAKPOINT;
}

function savedStateFor(states: Record<string, SavedState>, id: string): SavedState | undefined {
  return Object.prototype.hasOwnProperty.call(states, id) ? states[id] : undefined;
}

interface WindowManagerProviderProps {
  /** Exact non-secret provider/session authority partition for saved layout. */
  authorityPartition?: string;
  children: ReactNode;
  /** Disable persistence, but keep all window interaction in memory. */
  retentionEnabled?: boolean;
  /** Set false when the host mounts TrayDock itself (e.g. the shell bottom dock). */
  renderTray?: boolean;
}

export function WindowManagerProvider({
  authorityPartition,
  children,
  retentionEnabled = true,
  renderTray = true,
}: WindowManagerProviderProps) {
  const partitionKey = layoutStorageKey(authorityPartition);
  const storageKey = retentionEnabled ? partitionKey : undefined;
  // The shell hosts its tray outside this provider and requires an owned
  // partition before exposing cross-navigation windows. Standalone providers
  // keep their ordinary in-memory interaction even without persistence.
  const interactionEnabled = renderTray || partitionKey !== undefined;
  return (
    <WindowManagerPartitionProvider
      key={storageKey}
      interactionEnabled={interactionEnabled}
      storageKey={storageKey}
      renderTray={renderTray}
    >
      {children}
    </WindowManagerPartitionProvider>
  );
}

function WindowManagerPartitionProvider({
  children,
  interactionEnabled,
  renderTray,
  storageKey,
}: {
  children: ReactNode;
  interactionEnabled: boolean;
  renderTray: boolean;
  storageKey: string | undefined;
}) {
  const persistenceScope = useMemo<object>(() => ({ storageKey }), [storageKey]);
  const activePersistenceScopeRef = useRef<object | null>(null);
  const [initialLayout] = useState<SavedLayout>(() => readSavedLayout(storageKey));
  const savedStatesRef = useRef<Record<string, SavedState>>(initialLayout.states);
  const knownIdsRef = useRef<Set<string>>(new Set());

  const [entries, setEntries] = useState<Map<string, WindowEntry>>(() => new Map());
  const [arrangement, setArrangement] = useState<Arrangement>({ pinnedId: null, minimizedIds: [] });
  const [panelWidth, setPanelWidthState] = useState<number>(initialLayout.panelWidth);
  const [narrow, setNarrow] = useState<boolean>(isNarrow);

  useInsertionEffect(() => {
    activePersistenceScopeRef.current = persistenceScope;
    return () => {
      if (activePersistenceScopeRef.current === persistenceScope) {
        activePersistenceScopeRef.current = null;
      }
    };
  }, [persistenceScope]);

  useEffect(() => {
    const onResize = () => {
      setNarrow(isNarrow());
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const pin = useCallback((id: string) => {
    if (!interactionEnabled) return;
    setArrangement((prev) => {
      const withoutTarget = prev.minimizedIds.filter((entryId) => entryId !== id);
      const demoted =
        prev.pinnedId && prev.pinnedId !== id
          ? [prev.pinnedId, ...withoutTarget]
          : withoutTarget;
      return { pinnedId: id, minimizedIds: [...new Set(demoted)] };
    });
  }, [interactionEnabled]);

  const minimize = useCallback((id: string) => {
    if (!interactionEnabled) return;
    setArrangement((prev) => ({
      pinnedId: prev.pinnedId === id ? null : prev.pinnedId,
      minimizedIds: [id, ...prev.minimizedIds.filter((entryId) => entryId !== id)],
    }));
  }, [interactionEnabled]);

  const register = useCallback(
    (entry: WindowEntry) => {
      if (!interactionEnabled) return;
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(entry.id, entry);
        return next;
      });
      if (!knownIdsRef.current.has(entry.id)) {
        knownIdsRef.current.add(entry.id);
        const saved = savedStateFor(savedStatesRef.current, entry.id);
        if (saved === "pinned") pin(entry.id);
        else if (saved === "minimized") minimize(entry.id);
      }
    },
    [interactionEnabled, minimize, pin],
  );

  const open = useCallback(
    (entry: WindowEntry) => {
      if (!interactionEnabled) return;
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(entry.id, entry);
        return next;
      });
      knownIdsRef.current.add(entry.id);
      pin(entry.id);
    },
    [interactionEnabled, pin],
  );

  const restore = useCallback(
    (id: string) => {
      pin(id);
    },
    [pin],
  );

  const close = useCallback((id: string) => {
    if (!interactionEnabled) return;
    knownIdsRef.current.delete(id);
    setEntries((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setArrangement((prev) => ({
      pinnedId: prev.pinnedId === id ? null : prev.pinnedId,
      minimizedIds: prev.minimizedIds.filter((entryId) => entryId !== id),
    }));
  }, [interactionEnabled]);

  const togglePin = useCallback(
    (entry: WindowEntry) => {
      if (arrangement.pinnedId === entry.id) close(entry.id);
      else open(entry);
    },
    [arrangement.pinnedId, close, open],
  );

  const setPanelWidth = useCallback((width: number) => {
    if (!interactionEnabled) return;
    setPanelWidthState(clampPanelWidth(width));
  }, [interactionEnabled]);

  const saveLayout = useCallback(() => {
    if (!interactionEnabled) return;
    const states: Record<string, SavedState> = {};
    if (arrangement.pinnedId) states[arrangement.pinnedId] = "pinned";
    for (const id of arrangement.minimizedIds) states[id] = "minimized";
    savedStatesRef.current = states;
    if (activePersistenceScopeRef.current === persistenceScope) {
      writeSavedLayout(storageKey, { states, panelWidth });
    }
  }, [arrangement, interactionEnabled, panelWidth, persistenceScope, storageKey]);

  const restoreDefault = useCallback(() => {
    savedStatesRef.current = {};
    if (activePersistenceScopeRef.current === persistenceScope) {
      clearSavedLayout(storageKey);
    }
    setArrangement({ pinnedId: null, minimizedIds: [] });
    setPanelWidthState(PANEL_DEFAULT_WIDTH);
  }, [persistenceScope, storageKey]);

  const stateOf = useCallback(
    (id: string): WindowState => {
      if (!interactionEnabled) return "default";
      if (arrangement.pinnedId === id) return "pinned";
      if (arrangement.minimizedIds.includes(id)) return "minimized";
      return "default";
    },
    [arrangement, interactionEnabled],
  );

  const value = useMemo<WindowManagerContextValue>(
    () => ({
      pinnedId: arrangement.pinnedId,
      minimizedIds: arrangement.minimizedIds,
      entries,
      panelWidth,
      narrow,
      stateOf,
      register,
      open,
      minimize,
      restore,
      close,
      togglePin,
      setPanelWidth,
      saveLayout,
      restoreDefault,
    }),
    [
      arrangement,
      entries,
      panelWidth,
      narrow,
      stateOf,
      register,
      open,
      minimize,
      restore,
      close,
      togglePin,
      setPanelWidth,
      saveLayout,
      restoreDefault,
    ],
  );

  const pinnedEntry = arrangement.pinnedId ? entries.get(arrangement.pinnedId) : undefined;
  const labelId = pinnedEntry ? `window-panel-${pinnedEntry.id}` : undefined;

  const hostStyle: CSSProperties = {
    minHeight: "100%",
    boxSizing: "border-box",
    transition: "padding 0.18s ease",
    paddingRight: pinnedEntry && !narrow ? panelWidth + QUADRANT_GAP : undefined,
    paddingBottom: pinnedEntry && narrow ? `calc(${String(NARROW_PANEL_VH)}vh + ${String(QUADRANT_GAP)}px)` : undefined,
  };

  const panelWrapStyle: CSSProperties = narrow
    ? {
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        height: `${String(NARROW_PANEL_VH)}vh`,
        zIndex: 1100,
      }
    : {
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: panelWidth,
        zIndex: 1100,
      };

  const trayItems = useMemo(
    () =>
      arrangement.minimizedIds.flatMap((id) => {
        const entry = entries.get(id);
        return entry ? [{ id: entry.id, title: entry.title }] : [];
      }),
    [arrangement.minimizedIds, entries],
  );

  return (
    <WindowManagerContext.Provider value={value}>
      <div style={hostStyle}>{children}</div>
      {pinnedEntry && labelId ? (
        <div className="console" role="region" aria-labelledby={labelId} style={panelWrapStyle}>
          <WindowFrame
            title={pinnedEntry.title}
            labelId={labelId}
            onMinimize={() => {
              minimize(pinnedEntry.id);
            }}
            onClose={() => {
              close(pinnedEntry.id);
            }}
          >
            {pinnedEntry.render()}
          </WindowFrame>
        </div>
      ) : null}
      {renderTray ? <TrayDock items={trayItems} onRestore={restore} /> : null}
    </WindowManagerContext.Provider>
  );
}
