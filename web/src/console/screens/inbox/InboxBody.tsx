import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import { StatusChip } from "../../components";
import "../../tokens.css";
import { screenHeaderStyle, screenTitleStyle } from "../screenHeader";
import type { InboxApi, InboxDocDetail, InboxDocSummary, InboxFilter } from "./inboxApi";
import {
  INBOX_FILTERS,
  docStatus,
  inboxStrings,
  isReadable,
  kindLabel,
  payloadBlocks,
} from "./inboxModel";

type LoadState = "loading" | "ready" | "error";
type DetailState =
  | { phase: "idle" }
  | { phase: "loading"; id: string }
  | { phase: "ready"; detail: InboxDocDetail }
  | { phase: "error"; id: string };

export interface InboxBodyProps {
  api: InboxApi;
}

export function InboxBody({ api }: InboxBodyProps) {
  const S = useMemo(() => inboxStrings(), []);
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    [],
  );

  const [filter, setFilter] = useState<InboxFilter>("all");
  const [listState, setListState] = useState<LoadState>("loading");
  const [docs, setDocs] = useState<InboxDocSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detail, setDetail] = useState<DetailState>({ phase: "idle" });
  const [confirming, setConfirming] = useState(false);
  const [receiptError, setReceiptError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // List load — refetched on filter change or explicit retry. The "loading"
  // transition is set by the triggering handlers (tab/retry), so the effect
  // only ever writes state from its async callbacks (no cascading renders).
  useEffect(() => {
    let live = true;
    api
      .loadDocs(filter)
      .then((items) => {
        if (!live) return;
        setDocs(items);
        setListState("ready");
      })
      .catch(() => {
        if (live) setListState("error");
      });
    return () => {
      live = false;
    };
  }, [api, filter, reloadKey]);

  // Detail load — driven by the selected id. Idle (no selection) is derived in
  // render; the "loading" transition is set by the row click handler.
  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    api
      .loadDoc(selectedId)
      .then((doc) => {
        if (live) setDetail({ phase: "ready", detail: doc });
      })
      .catch(() => {
        if (live) setDetail({ phase: "error", id: selectedId });
      });
    return () => {
      live = false;
    };
  }, [api, selectedId]);

  const selectDoc = useCallback((id: string) => {
    setReceiptError(false);
    setDetail({ phase: "loading", id });
    setSelectedId(id);
  }, []);

  const confirmReceipt = useCallback(
    (id: string) => {
      setConfirming(true);
      setReceiptError(false);
      api
        .confirmReceipt(id)
        .then((summary) => {
          // Reflect the confirmed stamp in the list, then re-read the now-
          // readable body.
          setDocs((prev) => prev.map((d) => (d.id === id ? summary : d)));
          return api.loadDoc(id);
        })
        .then((doc) => {
          setDetail({ phase: "ready", detail: doc });
        })
        .catch(() => {
          // User cancelled the passkey or verification failed — stay locked.
          setReceiptError(true);
        })
        .finally(() => {
          setConfirming(false);
        });
    },
    [api],
  );

  return (
    <div className="console" style={rootStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>{S.title}</h1>
        <span style={{ color: "var(--faint)", fontSize: "var(--text-sm)" }}>
          {S.count(docs.length)}
        </span>
      </header>

      <div style={tabsStyle} role="tablist" aria-label={S.title}>
        {INBOX_FILTERS.map((f) => {
          const active = filter === f;
          return (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={active}
              data-window-control="true"
              style={tabStyle(active)}
              onClick={() => {
                setListState("loading");
                setFilter(f);
              }}
            >
              {S.filters[f]}
            </button>
          );
        })}
      </div>

      <div style={gridStyle}>
        {/* list pane */}
        <section style={listPaneStyle} aria-label={S.title}>
          {listState === "error" ? (
            <div role="alert" style={{ display: "grid", gap: "var(--sp-2)" }}>
              <p style={{ margin: 0, color: "var(--steel)" }}>{S.error}</p>
              <button
                type="button"
                data-window-control="true"
                style={ghostButtonStyle}
                onClick={() => {
                  setListState("loading");
                  setReloadKey((k) => k + 1);
                }}
              >
                {S.retry}
              </button>
            </div>
          ) : listState === "loading" ? (
            <StatusChip role="status">{S.loading}</StatusChip>
          ) : docs.length === 0 ? (
            <p style={emptyStyle}>{S.empty.list}</p>
          ) : (
            <ul style={listStyle}>
              {docs.map((doc) => {
                const status = docStatus(doc, dateFmt, S);
                const active = doc.id === selectedId;
                return (
                  <li key={doc.id}>
                    <button
                      type="button"
                      data-window-control="true"
                      aria-pressed={active}
                      style={docRowStyle(active)}
                      onClick={() => {
                        selectDoc(doc.id);
                      }}
                    >
                      <div style={docRowHeadStyle}>
                        <StatusChip tone={doc.kind === "payslip" ? "info" : "purple"}>
                          {kindLabel(doc.kind, S)}
                        </StatusChip>
                        <StatusChip tone={status.tone}>{status.text}</StatusChip>
                      </div>
                      <div style={docTitleStyle}>{doc.title}</div>
                      <div style={docMetaStyle}>
                        {[doc.notice_type, dateFmt.format(new Date(doc.created_at))]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* detail pane */}
        <section style={detailPaneStyle} aria-label={S.title}>
          <DetailPane
            state={detail}
            confirming={confirming}
            receiptError={receiptError}
            onConfirm={confirmReceipt}
            dateFmt={dateFmt}
            S={S}
          />
        </section>
      </div>
    </div>
  );
}

function DetailPane({
  state,
  confirming,
  receiptError,
  onConfirm,
  dateFmt,
  S,
}: {
  state: DetailState;
  confirming: boolean;
  receiptError: boolean;
  onConfirm: (id: string) => void;
  dateFmt: Intl.DateTimeFormat;
  S: ReturnType<typeof inboxStrings>;
}) {
  if (state.phase === "idle") {
    return <p style={emptyStyle}>{S.empty.selection}</p>;
  }
  if (state.phase === "loading") {
    return <StatusChip role="status">{S.loading}</StatusChip>;
  }
  if (state.phase === "error") {
    return (
      <div role="alert" style={{ display: "grid", gap: "var(--sp-2)" }}>
        <p style={{ margin: 0, color: "var(--steel)" }}>{S.error}</p>
      </div>
    );
  }

  const detail = state.detail;
  const readable = isReadable(detail);
  return (
    <article style={{ display: "grid", gap: "var(--sp-4)", minWidth: 0 }}>
      <div style={{ display: "grid", gap: "var(--sp-2)" }}>
        <h2 style={detailTitleStyle}>{detail.title}</h2>
        <div style={detailMetaRowStyle}>
          <StatusChip tone={detail.kind === "payslip" ? "info" : "purple"}>
            {kindLabel(detail.kind, S)}
          </StatusChip>
          {detail.confirmed_at ? (
            <StatusChip tone="ok">
              {S.detail.confirmedAt(dateFmt.format(new Date(detail.confirmed_at)))}
            </StatusChip>
          ) : null}
        </div>
        {detail.legal_basis ? (
          <div style={detailKvStyle}>
            <span style={detailKvKeyStyle}>{S.detail.basisLabel}</span>
            <span>{detail.legal_basis}</span>
          </div>
        ) : null}
        {detail.source_id ? (
          <div style={detailKvStyle}>
            <span style={detailKvKeyStyle}>{S.detail.fromLabel}</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>{detail.source_id}</span>
          </div>
        ) : null}
      </div>

      {readable ? (
        <div style={payloadStyle}>
          {payloadBlocks(detail).map((block, i) =>
            block.kind === "paragraph" ? (
              <p key={i} style={paragraphStyle}>
                {block.text}
              </p>
            ) : (
              <div key={i} style={detailKvStyle}>
                <span style={detailKvKeyStyle}>{block.label}</span>
                <span>{block.value}</span>
              </div>
            ),
          )}
        </div>
      ) : (
        <div style={lockedStyle} role="group" aria-label={S.detail.lockedTitle}>
          <div style={lockHeadStyle}>
            <span aria-hidden="true" style={{ fontSize: "1.4rem" }}>
              🔒
            </span>
            <span style={{ fontWeight: "var(--fw-strong)" }}>{S.detail.lockedTitle}</span>
          </div>
          <p style={{ margin: 0, color: "var(--steel)", fontSize: "var(--text-sm)" }}>
            {S.detail.lockedHint}
          </p>
          {receiptError ? (
            <p role="alert" style={{ margin: 0, color: "var(--danger-tx)", fontSize: "var(--text-sm)" }}>
              {S.detail.receiptFailed}
            </p>
          ) : null}
          <button
            type="button"
            data-window-control="true"
            disabled={confirming}
            style={confirmButtonStyle}
            onClick={() => {
              onConfirm(detail.id);
            }}
          >
            {confirming ? S.detail.confirming : S.detail.confirmButton}
          </button>
        </div>
      )}
    </article>
  );
}

// ── styles (console tokens only) ─────────────────────────────────────────────

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-6)",
  gridTemplateRows: "auto auto minmax(0, 1fr)",
  fontFamily: "var(--font-sans)",
  color: "var(--ink)",
  minHeight: 0,
  overflow: "hidden",
};

const headerStyle = screenHeaderStyle;
const titleStyle = screenTitleStyle;

const tabsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

function tabStyle(active: boolean): CSSProperties {
  return {
    minHeight: 32,
    padding: "0 var(--sp-4)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-chip)",
    background: active ? "var(--ink)" : "var(--surface)",
    color: active ? "var(--surface)" : "var(--steel)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--fw-medium)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

const gridStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  gridTemplateColumns: "minmax(0, 22rem) minmax(0, 1fr)",
  minHeight: 0,
  alignItems: "stretch",
};

const listPaneStyle: CSSProperties = {
  display: "grid",
  alignContent: "start",
  gap: "var(--sp-2)",
  padding: "var(--sp-card-y) var(--sp-4)",
  border: "var(--border-hairline)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
  minWidth: 0,
  overflow: "auto",
};

const detailPaneStyle: CSSProperties = {
  padding: "var(--sp-card-y) var(--sp-6)",
  border: "var(--border-hairline)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
  minWidth: 0,
  overflow: "auto",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

function docRowStyle(active: boolean): CSSProperties {
  return {
    display: "grid",
    gap: "var(--sp-1)",
    width: "100%",
    textAlign: "left",
    padding: "var(--sp-3)",
    border: `1px solid ${active ? "var(--ink)" : "var(--border)"}`,
    borderRadius: "var(--radius-card)",
    background: active ? "var(--muted)" : "var(--surface)",
    cursor: "pointer",
  };
}

const docRowHeadStyle: CSSProperties = {
  display: "flex",
  gap: "var(--sp-2)",
  flexWrap: "wrap",
};

const docTitleStyle: CSSProperties = {
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-medium)",
  color: "var(--ink)",
};

const docMetaStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--steel)",
};

const detailTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const detailMetaRowStyle: CSSProperties = {
  display: "flex",
  gap: "var(--sp-2)",
  flexWrap: "wrap",
};

const detailKvStyle: CSSProperties = {
  display: "flex",
  gap: "var(--sp-3)",
  fontSize: "var(--text-sm)",
  color: "var(--ink)",
};

const detailKvKeyStyle: CSSProperties = {
  flex: "none",
  minWidth: "5rem",
  color: "var(--faint)",
};

const payloadStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  paddingTop: "var(--sp-3)",
  borderTop: "1px solid var(--border-soft)",
};

const paragraphStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-body)",
  lineHeight: 1.7,
  color: "var(--ink)",
  whiteSpace: "pre-wrap",
};

const lockedStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  padding: "var(--sp-5)",
  border: "1px dashed var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--muted)",
};

const lockHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const confirmButtonStyle: CSSProperties = {
  justifySelf: "start",
  minHeight: 36,
  padding: "0 var(--sp-5)",
  border: "1px solid var(--ink)",
  borderRadius: "var(--radius-sm)",
  background: "var(--ink)",
  color: "var(--surface)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const ghostButtonStyle: CSSProperties = {
  justifySelf: "start",
  minHeight: 32,
  padding: "0 var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-medium)",
  cursor: "pointer",
};

const emptyStyle: CSSProperties = {
  margin: 0,
  padding: "var(--sp-4) 0",
  color: "var(--faint)",
  fontSize: "var(--text-sm)",
};
