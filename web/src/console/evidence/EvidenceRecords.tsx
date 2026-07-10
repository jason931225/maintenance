// 증거 records surface — EV- rows with a compact stat bar, admissibility/hold
// filters, objDrag row sources, and detail opening as the right pin (§4.7-3;
// inline aside fallback when no window shell is mounted, e.g. legacy pages).
import { useMemo, useState, type CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { objDrag, useOptionalWindowManager } from "../window";
import { EvidenceCard, evidenceWindowEntry } from "./EvidenceCard";
import {
  admissibilityLabel,
  admissibilityTone,
  custodyStageLabel,
  holdActive,
  originalOf,
  shortDigest,
} from "./evidenceModel";
import { createEvidenceStubs } from "./evidenceStubs";
import type {
  AdmissibilityStatus,
  EvidenceObjectDetail,
  VerifyEvidence,
} from "./types";
import "../tokens.css";

const T = ko.console.evidence;
const TA = ko.console.audit;

type RecordsFilter = "ALL" | AdmissibilityStatus | "HOLD";

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

function timestampLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : TA.datetime(date);
}

export interface EvidenceRecordsProps {
  /**
   * EV rows. Defaults to the stub feed.
   * wire-pending: Phase C → GET /api/v1/evidence-objects (t_15b1a1ec §7.1).
   */
  records?: EvidenceObjectDetail[];
  /** Real fixity poll for the detail's 무결성 검증 affordance. */
  verify?: VerifyEvidence;
}

export function EvidenceRecords({ records, verify }: EvidenceRecordsProps) {
  const rows = useMemo(() => records ?? createEvidenceStubs(), [records]);
  const [filter, setFilter] = useState<RecordsFilter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const windowManager = useOptionalWindowManager();

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

  function openDetail(row: EvidenceObjectDetail): void {
    if (windowManager) {
      windowManager.open(evidenceWindowEntry(row, verify));
      return;
    }
    setSelectedId(row.id);
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
                    onClick={() => {
                      openDetail(row);
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
                      <span>{timestampLabel(row.collectedAt)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={T.records.open(row.code, row.title)}
                    style={openButtonStyle}
                    onClick={() => {
                      openDetail(row);
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
            <EvidenceCard key={selected.id} detail={selected} verify={verify} />
          </aside>
        ) : null}
      </div>
    </section>
  );
}
