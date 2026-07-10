// Dashboard config-doc model + the live-count computation. Pure functions —
// the editor holds the doc in state, serializes it for 저장/팀 배포, and every
// widget recomputes from (doc, rows), so an auto-refresh is just a rows swap.
import type {
  CountGroup,
  CountResult,
  DashboardDoc,
  DashboardSlot,
  DrillFilter,
  OntInstanceRow,
  OntObjectTypeDef,
  WidgetConfig,
} from "./types";

export const DASHBOARD_DOC_VERSION = 1;
export const DASHBOARD_SLOT_COUNT = 4;

const SLOT_IDS = ["slot-1", "slot-2", "slot-3", "slot-4"] as const;

export function emptyDashboardDoc(screen = "config-console"): DashboardDoc {
  return {
    version: DASHBOARD_DOC_VERSION,
    screen,
    slots: SLOT_IDS.map((id) => ({ id, widget: null })),
  };
}

/**
 * The shipped 4-slot preset — 기본값 복원 target. Keys are registry stable
 * keys; a widget over a type absent from the tenant registry honestly renders
 * a zero count (never fabricated rows). Slot 2 (trend) needs a concrete
 * instance to bind, so the default leaves it empty for the editor's
 * add-widget strip to fill from the loaded registry.
 */
export function defaultDashboardDoc(): DashboardDoc {
  return {
    version: DASHBOARD_DOC_VERSION,
    screen: "config-console",
    slots: [
      { id: "slot-1", widget: { kind: "count", bind: { objectType: "work_order", groupBy: "priority" } } },
      { id: "slot-2", widget: null },
      { id: "slot-3", widget: { kind: "dist", bind: { objectType: "approval" } } },
      { id: "slot-4", widget: null },
    ],
  };
}

/** Dedup guard (design delta 96): same kind + bind already occupies a slot. */
export function widgetKey(widget: WidgetConfig): string {
  return `${widget.kind}:${JSON.stringify(widget.bind)}`;
}

export function isDuplicateWidget(doc: DashboardDoc, widget: WidgetConfig): boolean {
  const key = widgetKey(widget);
  return doc.slots.some((slot) => slot.widget !== null && widgetKey(slot.widget) === key);
}

/** Immutable per-slot widget update. */
export function setSlotWidget(
  doc: DashboardDoc,
  slotId: string,
  widget: WidgetConfig | null,
): DashboardDoc {
  return {
    ...doc,
    slots: doc.slots.map((slot) => (slot.id === slotId ? { ...slot, widget } : slot)),
  };
}

export function serializeDashboardDoc(doc: DashboardDoc): string {
  return JSON.stringify(doc, null, 2);
}

/** Forward-compat widget reader: unknown `kind` or malformed config ⇒ null, never a crash (benchmark §3c). */
function parseWidget(value: unknown): WidgetConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const bind = typeof raw.bind === "object" && raw.bind !== null ? (raw.bind as Record<string, unknown>) : {};
  switch (raw.kind) {
    case "count":
      if (typeof bind.objectType !== "string") return null;
      return {
        kind: "count",
        bind: {
          objectType: bind.objectType,
          ...(typeof bind.groupBy === "string" ? { groupBy: bind.groupBy } : {}),
        },
      };
    case "trend":
      if (
        typeof bind.objectType !== "string" ||
        typeof bind.instanceId !== "string" ||
        typeof bind.field !== "string"
      ) {
        return null;
      }
      return { kind: "trend", bind: { objectType: bind.objectType, instanceId: bind.instanceId, field: bind.field } };
    case "dist":
      if (typeof bind.objectType !== "string") return null;
      return { kind: "dist", bind: { objectType: bind.objectType } };
    default:
      return null;
  }
}

/**
 * Parse a persisted doc. Degrades slot-by-slot (unknown widget → empty slot),
 * normalizes to exactly DASHBOARD_SLOT_COUNT slots, and returns null only when
 * the payload is not a doc at all.
 */
export function parseDashboardDoc(json: string): DashboardDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as Record<string, unknown>;
  if (typeof doc.version !== "number" || typeof doc.screen !== "string") return null;
  const rawSlots: unknown[] = Array.isArray(doc.slots) ? doc.slots : [];
  const slots: DashboardSlot[] = SLOT_IDS.map((fallbackId, index) => {
    const slot = rawSlots[index];
    if (typeof slot !== "object" || slot === null) return { id: fallbackId, widget: null };
    const entry = slot as Record<string, unknown>;
    return {
      id: typeof entry.id === "string" ? entry.id : fallbackId,
      widget: parseWidget(entry.widget),
    };
  });
  return { version: doc.version, screen: doc.screen, slots };
}

/**
 * REAL count computation over the instance rows. Groups follow the registry's
 * choice order; values whose choice id is unknown to the registry degrade to a
 * raw-id group (forward-compat, benchmark §3c) instead of being dropped.
 */
export function computeCounts(
  rows: readonly OntInstanceRow[],
  objectType: string,
  groupBy: string | undefined,
  registry: readonly OntObjectTypeDef[],
): CountResult {
  const typed = rows.filter((row) => row.objectType === objectType);
  if (!groupBy) return { total: typed.length, groups: [] };

  const def = registry
    .find((type) => type.key === objectType)
    ?.properties.find((prop) => prop.key === groupBy);
  const choices = def?.type === "choice" ? (def.config?.choices ?? []) : [];

  const counts = new Map<string, number>();
  for (const row of typed) {
    // == null also covers keys genuinely absent from the payload at runtime.
    const value = row.attributes[groupBy];
    if (value == null) continue;
    const id = typeof value === "string" ? value : String(value);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const groups: CountGroup[] = choices.map((choice) => {
    const count = counts.get(choice.id) ?? 0;
    counts.delete(choice.id);
    return { id: choice.id, label: choice.name, count };
  });
  for (const [id, count] of counts) groups.push({ id, label: id, count });

  return { total: typed.length, groups };
}

/** dist: instance count grouped by lifecycle_state (§3b), top-4 by count. */
export function computeDist(
  rows: readonly OntInstanceRow[],
  objectType: string,
): CountResult {
  const typed = rows.filter((row) => row.objectType === objectType);
  const counts = new Map<string, number>();
  for (const row of typed) {
    counts.set(row.lifecycleState, (counts.get(row.lifecycleState) ?? 0) + 1);
  }
  const groups: CountGroup[] = [...counts.entries()]
    .map(([id, count]) => ({ id, label: id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);
  return { total: typed.length, groups };
}

/** Rows matched by a widget drill click — the payload of the drill pin (§4.7-3). */
export function drillRows(
  rows: readonly OntInstanceRow[],
  filter: DrillFilter,
): OntInstanceRow[] {
  return rows.filter((row) => {
    if (row.objectType !== filter.objectType) return false;
    if (filter.lifecycleState !== undefined) return row.lifecycleState === filter.lifecycleState;
    if (filter.field === undefined || filter.choiceId === undefined) return true;
    return row.attributes[filter.field] === filter.choiceId;
  });
}
