// 증거 records surface — EV- rows with a compact stat bar, admissibility/hold
// filters, objDrag row sources, and detail opening as the right pin (§4.7-3;
// inline aside fallback when no window shell is mounted, e.g. legacy pages).
// Real-wired: GET /api/v1/evidence/objects (list) + GET .../{id} (detail on
// open) + verify/hold via evidenceApi. After every mutation the full detail is
// refetched — never client-synthesized (§4-25-⑥).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { safeLabel } from "../../lib/utils";
import { StatusChip } from "../components";
import { objDrag, useOptionalWindowManager } from "../window";
import { EvidenceCard, evidenceWindowEntry, type EvidenceCardProps } from "./EvidenceCard";
import {
  applyLegalHold,
  decideHoldReleaseApproval,
  getEvidenceObjectDetail,
  listEvidenceObjectPage,
  releaseLegalHold,
  requestHoldReleaseApproval,
  verifyEvidenceObject,
} from "./evidenceApi";
import {
  admissibilityLabel,
  admissibilityTone,
  custodyStageLabel,
  holdActive,
  originalOf,
  shortDigest,
} from "./evidenceModel";
import type { AdmissibilityStatus, EvidenceObjectDetail } from "./types";
import "../tokens.css";

const T = ko.console.evidence;
const TA = ko.console.audit;

type RecordsFilter = "ALL" | AdmissibilityStatus | "HOLD";
type ListState = "loading" | "ready" | "error";

const ADMISSIBILITY_ORDER: readonly AdmissibilityStatus[] = [
  "ADMISSIBLE",
  "REVIEW_NEEDED",
  "BLOCKED",
  "INADMISSIBLE",
];

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const splitStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  alignItems: "start",
};

const statBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const statButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const statButtonActiveStyle: CSSProperties = {
  ...statButtonStyle,
  border: "1px solid var(--accent-bd)",
  background: "var(--accent-bg)",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "var(--sp-3)",
  padding: "var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const codeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  border: 0,
  background: "transparent",
  padding: 0,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  color: "var(--steel)",
  cursor: "grab",
};

const rowBodyStyle: CSSProperties = { display: "grid", gap: "var(--sp-1)", minWidth: 0 };

const rowTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  overflowWrap: "anywhere",
};

const rowMetaStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
};

const monoStyle: CSSProperties = { fontFamily: "var(--font-mono)" };

const openButtonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const asideStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
  overflow: "hidden",
};

const asideBarStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  padding: "var(--sp-3) var(--sp-3) 0",
};

const errorPaneStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  padding: "var(--sp-4)",
  border: "1px solid var(--danger-bd)",
  borderRadius: "var(--radius-card)",
  background: "var(--danger-bg)",
  color: "var(--danger-tx)",
};

function timestampLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : TA.datetime(date);
}

export interface EvidenceRecordsProps {
  api: ConsoleApiClient;
  /** The signed-in user — blocks a self-decide in the hold-release UI. */
  currentUserId?: string;
}

export function EvidenceRecords({ api, currentUserId }: EvidenceRecordsProps) {
  const [rows, setRows] = useState<EvidenceObjectDetail[]>([]);
  const [listState, setListState] = useState<ListState>("loading");
  const [users, setUsers] = useState<Map<string, string>>(new Map());
  const [filter, setFilter] = useState<RecordsFilter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const listRequest = useRef(0);
  const listController = useRef<AbortController | null>(null);
  const windowManager = useOptionalWindowManager();

  const resolveName = useCallback(
    (id: string | null | undefined): string => safeLabel(id ? users.get(id) : undefined),
    [users],
  );

  const resolveNames = useCallback(
    (detail: EvidenceObjectDetail): EvidenceObjectDetail => ({
      ...detail,
      custodian: resolveName(detail.custodian),
      custody: detail.custody.map((event) => ({
        ...event,
        actor: event.actor ? resolveName(event.actor) : event.actor,
      })),
    }),
    [resolveName],
  );

  const loadList = useCallback(async () => {
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    const request = ++listRequest.current;
    setListState("loading");
    try {
      const page = await listEvidenceObjectPage(api, 200, 0, controller.signal);
      if (controller.signal.aborted || request !== listRequest.current) return;
      setRows(page.items.map(resolveNames));
      setListState("ready");
    } catch {
      if (controller.signal.aborted || request !== listRequest.current) return;
      setListState("error");
    }
  }, [api, resolveNames]);

  useEffect(() => {
    void loadList();
    return () => {
      listController.current?.abort();
    };
  }, [loadList]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    void api
      .GET("/api/v1/users", { signal: controller.signal })
      .then((res) => {
        if (!current || controller.signal.aborted || !res.data) return;
        setUsers(new Map(res.data.items.map((u) => [u.id, u.display_name])));
      })
      .catch(() => undefined);
    return () => {
      current = false;
      controller.abort();
    };
  }, [api]);

  const counts = useMemo(() => {
    const byStatus = new Map<AdmissibilityStatus, number>();
    let hold = 0;
    for (const row of rows) {
      byStatus.set(row.admissibility, (byStatus.get(row.admissibility) ?? 0) + 1);
      if (holdActive(row.holds)) hold += 1;
    }
    return { byStatus, hold };
  }, [rows]);

  const visible = useMemo(() => {
    if (filter === "ALL") return rows;
    if (filter === "HOLD") return rows.filter((row) => holdActive(row.holds));
    return rows.filter((row) => row.admissibility === filter);
  }, [rows, filter]);

  const selected = rows.find((row) => row.id === selectedId);

  // Plain functions (not hooks) so the refreshDetail ↔ mountEntry ↔
  // buildCardProps mutual recursion below can rely on ordinary function-
  // declaration hoisting instead of fighting the hooks lint's forward-
  // reference rule.
  async function refreshDetail(id: string): Promise<void> {
    try {
      const fresh = resolveNames(await getEvidenceObjectDetail(api, id));
      setRows((current) => current.map((row) => (row.id === id ? fresh : row)));
      mountEntry(fresh);
    } catch {
      // Best-effort refresh — the mutation itself already surfaced its own
      // error to the caller; the row keeps showing the last-known state.
    }
  }

  function buildCardProps(id: string): Omit<EvidenceCardProps, "detail"> {
    return {
      currentUserId,
      verify: (detail) => verifyEvidenceObject(api, detail.id),
      applyHold: async (body) => {
        await applyLegalHold(api, id, body);
        await refreshDetail(id);
      },
      requestHoldRelease: (holdId) => requestHoldReleaseApproval(api, id, holdId),
      decideHoldRelease: (requestRef, requestedBy, decision) =>
        decideHoldReleaseApproval(api, requestRef, requestedBy, decision),
      releaseHold: async (body) => {
        await releaseLegalHold(api, id, body);
        await refreshDetail(id);
      },
    };
  }

  function mountEntry(detail: EvidenceObjectDetail): void {
    if (windowManager) {
      windowManager.open(evidenceWindowEntry(detail, buildCardProps(detail.id)));
    } else {
      setSelectedId(detail.id);
    }
  }

  async function openDetail(row: EvidenceObjectDetail): Promise<void> {
    setOpenError(null);
    setOpeningId(row.id);
    try {
      const fresh = resolveNames(await getEvidenceObjectDetail(api, row.id));
      setRows((current) => current.map((r) => (r.id === row.id ? fresh : r)));
      mountEntry(fresh);
    } catch {
      setOpenError(T.records.openFailed);
    } finally {
      setOpeningId(null);
    }
  }

  function statButton(key: RecordsFilter, label: string, count: number) {
    const active = filter === key;
    return (
      <button
        key={key}
        type="button"
        aria-pressed={active}
        style={active ? statButtonActiveStyle : statButtonStyle}
        onClick={() => {
          setFilter(active ? "ALL" : key);
        }}
      >
        <span>{label}</span>
        <StatusChip tone={active ? "accent" : "neutral"}>{TA.count(count)}</StatusChip>
      </button>
    );
  }

  if (listState === "loading" && rows.length === 0) {
    return (
      <section className="console" aria-label={T.records.label} style={rootStyle}>
        <StatusChip role="status" tone="info">{T.records.loading}</StatusChip>
      </section>
    );
  }

  if (listState === "error") {
    return (
      <section className="console" aria-label={T.records.label} style={rootStyle}>
        <div role="alert" style={errorPaneStyle}>
          <p>{T.records.loadFailed}</p>
          <button
            type="button"
            style={openButtonStyle}
            onClick={() => {
              void loadList();
            }}
          >
            {T.records.retry}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="console" aria-label={T.records.label} style={rootStyle}>
      {/* Compact stat bar — counts double as filters. */}
      <div role="group" aria-label={T.records.statBar} style={statBarStyle}>
        {statButton("ALL", T.records.all, rows.length)}
        {ADMISSIBILITY_ORDER.map((status) =>
          statButton(status, admissibilityLabel(status), counts.byStatus.get(status) ?? 0),
        )}
        {statButton("HOLD", T.hold.active, counts.hold)}
      </div>

      {openError ? (
        <div role="alert" style={errorPaneStyle}>
          {openError}
        </div>
      ) : null}

      <div
        style={{
          ...splitStyle,
          gridTemplateColumns:
            selected && !windowManager ? "minmax(0, 1fr) minmax(320px, 420px)" : "minmax(0, 1fr)",
        }}
      >
        {visible.length === 0 ? (
          <StatusChip tone="neutral">{T.records.empty}</StatusChip>
        ) : (
          <ul style={listStyle}>
            {visible.map((row) => {
              const original = originalOf(row.copies);
              return (
                <li key={row.id} style={rowStyle}>
                  <button
                    type="button"
                    {...objDrag(row.code, row.title)}
                    aria-label={T.records.open(row.code, row.title)}
                    style={codeStyle}
                    disabled={openingId === row.id}
                    onClick={() => {
                      void openDetail(row);
                    }}
                  >
                    {row.code}
                  </button>
                  <div style={rowBodyStyle}>
                    <p style={rowTitleStyle}>{row.title}</p>
                    <div style={rowMetaStyle}>
                      <StatusChip tone={admissibilityTone(row.admissibility)}>
                        {admissibilityLabel(row.admissibility)}
                      </StatusChip>
                      {holdActive(row.holds) ? (
                        <StatusChip tone="purple">{T.hold.active}</StatusChip>
                      ) : null}
                      <StatusChip tone="neutral">{custodyStageLabel(row.custodyStage)}</StatusChip>
                      {original ? (
                        <span style={monoStyle}>{shortDigest(original.digestSha256)}</span>
                      ) : null}
                      <span>{timestampLabel(row.registeredAt)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={T.records.open(row.code, row.title)}
                    style={openButtonStyle}
                    disabled={openingId === row.id}
                    onClick={() => {
                      void openDetail(row);
                    }}
                  >
                    {T.records.detail}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selected && !windowManager ? (
          // Accessible name comes from the EvidenceCard article inside.
          <aside style={asideStyle}>
            <div style={asideBarStyle}>
              <button
                type="button"
                aria-label={T.records.close}
                style={openButtonStyle}
                onClick={() => {
                  setSelectedId(null);
                }}
              >
                {T.records.close}
              </button>
            </div>
            <EvidenceCard key={selected.id} detail={selected} {...buildCardProps(selected.id)} />
          </aside>
        ) : null}
      </div>
    </section>
  );
}
