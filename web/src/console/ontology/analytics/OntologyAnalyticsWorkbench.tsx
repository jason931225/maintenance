import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  getObjectType,
  listInstances,
  listObjectTypes,
  type InstanceStateWire,
  type ObjectTypeDetailWire,
  type ObjectTypeSummaryWire,
} from "../../../api/ontology";
import type { ConsoleApiClient } from "../../../api/client";
import { ApiCallError } from "../../../api/ontologyActions";

export interface OntologyAnalyticsDrill {
  objectType: ObjectTypeSummaryWire;
  dimension: string;
  value: string;
  instanceIds: string[];
  /** The backend has no cursor/total contract, so this is only the exact returned set. */
  source: "unpaginated_instance_collection";
}

export interface OntologyAnalyticsWorkbenchProps {
  api: ConsoleApiClient;
  /** Must change whenever the effective session, tenant, or view-as scope changes. */
  authorityKey: string | undefined;
  open: boolean;
  onClose: () => void;
  /** Opens the governed object set in the host explorer; no synthetic query URL is emitted. */
  onDrill: (drill: OntologyAnalyticsDrill) => void;
}

type ReadState = "loading" | "ready" | "denied" | "error";
type Dimension = string;

interface Group {
  key: string;
  label: string;
  instanceIds: string[];
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 70,
  display: "grid",
  placeItems: "center",
  padding: "var(--sp-4)",
  background: "color-mix(in srgb, var(--canvas) 82%, transparent)",
};
const panelStyle: CSSProperties = {
  width: "min(100%, 1024px)",
  maxHeight: "min(820px, calc(100dvh - var(--sp-8)))",
  overflow: "auto",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow-pop)",
  color: "var(--ink)",
};
const buttonStyle: CSSProperties = {
  minHeight: 36,
  padding: "0 var(--sp-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--surface)",
  color: "var(--ink)",
  cursor: "pointer",
};
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--signal-deep)",
  borderColor: "var(--signal-deep)",
  color: "white",
};
const fieldStyle: CSSProperties = {
  minHeight: 38,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-2)",
};

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorState(error: unknown): Exclude<ReadState, "loading" | "ready"> {
  return error instanceof ApiCallError &&
    (error.status === 401 || error.status === 403)
    ? "denied"
    : "error";
}

function dimensionsFor(
  detail: ObjectTypeDetailWire | undefined,
): Array<{ value: Dimension; label: string }> {
  if (!detail) return [{ value: "lifecycle", label: "Lifecycle state" }];
  // Only values returned in the governed revision payload are candidates. Properties
  // with a property policy are intentionally excluded: the client must not turn a
  // partial/redacted field into a misleading aggregate dimension.
  const scalar = detail.properties.filter(
    (property) =>
      !property.in_property_policy &&
      [
        "text",
        "choice",
        "boolean",
        "date",
        "datetime",
        "number",
        "integer",
        "decimal",
      ].includes(property.field_type),
  );
  return [
    { value: "lifecycle", label: "Lifecycle state" },
    ...scalar.map((property) => ({
      value: property.key,
      label: property.title,
    })),
  ];
}

function scalarLabel(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "No value";
}

function groupsFor(
  instances: readonly InstanceStateWire[],
  dimension: Dimension,
): Group[] {
  const groups = new Map<string, Group>();
  for (const state of instances) {
    const raw =
      dimension === "lifecycle"
        ? state.instance.lifecycle_state
        : typeof state.revision.attributes === "object" &&
            !Array.isArray(state.revision.attributes)
          ? (state.revision.attributes as Record<string, unknown>)[dimension]
          : undefined;
    const label = scalarLabel(raw);
    const key = `${dimension}:${label}`;
    const group = groups.get(key) ?? { key, label, instanceIds: [] };
    group.instanceIds.push(state.instance.id);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.instanceIds.length - a.instanceIds.length ||
      a.label.localeCompare(b.label, "ko-KR"),
  );
}

function focusable(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => !element.hasAttribute("hidden"));
}

/**
 * A governed, in-memory aggregate over the exact instance collection returned by
 * GET /ontology/instances?type=. This is deliberately not called a total or an
 * analysis object: the current backend has neither pagination totals nor an
 * analysis persistence contract. Drill receives the exact returned IDs only.
 */
export function OntologyAnalyticsWorkbench({
  api,
  authorityKey,
  open,
  onClose,
  onDrill,
}: OntologyAnalyticsWorkbenchProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const requestRef = useRef(0);
  const [types, setTypes] = useState<ObjectTypeSummaryWire[]>([]);
  const [selectedTypeId, setSelectedTypeId] = useState<string>("");
  const [detail, setDetail] = useState<ObjectTypeDetailWire>();
  const [instances, setInstances] = useState<InstanceStateWire[]>([]);
  const [dimension, setDimension] = useState<Dimension>("lifecycle");
  const [state, setState] = useState<ReadState>("loading");

  const selectedType = types.find(
    (candidate) => candidate.id === selectedTypeId,
  );
  const dimensions = useMemo(() => dimensionsFor(detail), [detail]);
  const groups = useMemo(
    () => groupsFor(instances, dimension),
    [instances, dimension],
  );
  const max = Math.max(1, ...groups.map((group) => group.instanceIds.length));

  const loadTypes = useCallback(
    async (signal: AbortSignal, token: number) => {
      setState("loading");
      try {
        const next = await listObjectTypes(api);
        if (signal.aborted || requestRef.current !== token) return;
        setTypes(next);
        setSelectedTypeId((current) =>
          next.some((item) => item.id === current)
            ? current
            : (next[0]?.id ?? ""),
        );
        setDetail(undefined);
        setInstances([]);
        setDimension("lifecycle");
        setState("ready");
      } catch (error) {
        if (!signal.aborted && requestRef.current === token && !isAbort(error))
          setState(errorState(error));
      }
    },
    [api],
  );

  const loadSelectedType = useCallback(
    async (type: ObjectTypeSummaryWire, signal: AbortSignal, token: number) => {
      setState("loading");
      setDetail(undefined);
      setInstances([]);
      setDimension("lifecycle");
      try {
        const [nextDetail, nextInstances] = await Promise.all([
          getObjectType(api, type.stable_key),
          listInstances(api, type.id),
        ]);
        if (signal.aborted || requestRef.current !== token) return;
        setDetail(nextDetail);
        setInstances(nextInstances);
        setState("ready");
      } catch (error) {
        if (!signal.aborted && requestRef.current === token && !isAbort(error))
          setState(errorState(error));
      }
    },
    [api],
  );

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeRef.current?.focus();
    const controller = new AbortController();
    const token = ++requestRef.current;
    void loadTypes(controller.signal, token);
    return () => {
      controller.abort();
      requestRef.current += 1;
      restoreFocusRef.current?.focus();
    };
  }, [authorityKey, loadTypes, open]);

  useEffect(() => {
    if (!open || !selectedType) return;
    const controller = new AbortController();
    const token = ++requestRef.current;
    void loadSelectedType(selectedType, controller.signal, token);
    return () => {
      controller.abort();
    };
  }, [loadSelectedType, open, selectedType]);

  function retry(): void {
    const controller = new AbortController();
    const token = ++requestRef.current;
    if (selectedType)
      void loadSelectedType(selectedType, controller.signal, token);
    else void loadTypes(controller.signal, token);
  }

  if (!open) return null;
  return (
    <div
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="console"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ontology-analytics-title"
        style={panelStyle}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const items = panelRef.current ? focusable(panelRef.current) : [];
          if (!items.length) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "start",
            justifyContent: "space-between",
            gap: "var(--sp-3)",
            padding: "var(--sp-5)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div>
            <h2
              id="ontology-analytics-title"
              style={{ margin: 0, fontSize: "var(--text-lg)" }}
            >
              Object analysis
            </h2>
            <p
              style={{
                margin: "var(--sp-1) 0 0",
                color: "var(--steel)",
                fontSize: "var(--text-sm)",
              }}
            >
              Aggregate the authorized object set and drill into the exact
              returned records.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            style={buttonStyle}
          >
            Close
          </button>
        </header>
        <div
          style={{
            display: "grid",
            gap: "var(--sp-4)",
            padding: "var(--sp-5)",
          }}
        >
          {state === "denied" ? (
            <section role="alert">
              <strong>
                Analysis access is not available for this session.
              </strong>
              <p>
                Object types and counts are hidden until authorization succeeds.
              </p>
              <button type="button" onClick={retry} style={buttonStyle}>
                Retry
              </button>
            </section>
          ) : null}
          {state === "error" ? (
            <section role="alert">
              <strong>Object analysis could not be loaded.</strong>
              <p>No prior result is shown after a failed request.</p>
              <button type="button" onClick={retry} style={buttonStyle}>
                Retry
              </button>
            </section>
          ) : null}
          {state === "loading" ? (
            <p role="status" aria-live="polite">
              Loading authorized object data…
            </p>
          ) : null}
          {state === "ready" ? (
            <>
              {types.length === 0 ? (
                <section role="status">
                  <strong>No authorized object types are available.</strong>
                  <p>
                    Create or obtain access to an object type before building an
                    analysis.
                  </p>
                </section>
              ) : (
                <>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(220px, 1fr))",
                      gap: "var(--sp-3)",
                    }}
                  >
                    <label
                      style={{
                        display: "grid",
                        gap: "var(--sp-1)",
                        fontWeight: "var(--fw-strong)",
                      }}
                    >
                      Object type
                      <select
                        aria-label="Object type"
                        value={selectedTypeId}
                        onChange={(event) => {
                          setSelectedTypeId(event.target.value);
                        }}
                        style={fieldStyle}
                      >
                        {types.map((type) => (
                          <option key={type.id} value={type.id}>
                            {type.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label
                      style={{
                        display: "grid",
                        gap: "var(--sp-1)",
                        fontWeight: "var(--fw-strong)",
                      }}
                    >
                      Group by
                      <select
                        aria-label="Group dimension"
                        value={dimension}
                        onChange={(event) => {
                          setDimension(event.target.value);
                        }}
                        style={fieldStyle}
                      >
                        {dimensions.map((candidate) => (
                          <option key={candidate.value} value={candidate.value}>
                            {candidate.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p
                    style={{
                      margin: 0,
                      color: "var(--steel)",
                      fontSize: "var(--text-sm)",
                    }}
                  >
                    Showing {instances.length} records returned by the governed
                    instance read. The current API has no pagination-total or
                    saved-analysis contract.
                  </p>
                  {instances.length === 0 ? (
                    <section role="status">
                      <strong>
                        No current instances match this object type.
                      </strong>
                      <p>There is no aggregate to display.</p>
                    </section>
                  ) : (
                    <section
                      aria-label="Aggregate bars"
                      style={{ display: "grid", gap: "var(--sp-3)" }}
                    >
                      {groups.map((group) => (
                        <div
                          key={group.key}
                          style={{
                            display: "grid",
                            gridTemplateColumns:
                              "minmax(100px, 180px) minmax(0, 1fr) auto",
                            alignItems: "center",
                            gap: "var(--sp-3)",
                          }}
                        >
                          <span style={{ overflowWrap: "anywhere" }}>
                            {group.label}
                          </span>
                          <div
                            aria-hidden="true"
                            style={{
                              height: 18,
                              background: "var(--canvas)",
                              borderRadius: "var(--radius-control)",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                height: "100%",
                                width: `${String((group.instanceIds.length / max) * 100)}%`,
                                minWidth: 4,
                                background: "var(--signal-deep)",
                              }}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              if (!selectedType) return;
                              onDrill({
                                objectType: selectedType,
                                dimension,
                                value: group.label,
                                instanceIds: group.instanceIds,
                                source: "unpaginated_instance_collection",
                              });
                            }}
                            style={primaryButtonStyle}
                            aria-label={`Open ${group.label}, ${String(group.instanceIds.length)} records`}
                          >
                            {group.instanceIds.length} records
                          </button>
                        </div>
                      ))}
                    </section>
                  )}
                </>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
