import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

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

interface ApiOwned<T> {
  api: object;
  value: T;
}

function ownedBy<T>(api: object, value: T): ApiOwned<T> {
  return { api, value };
}

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

  const currentApiRef = useRef<InboxApi | undefined>(api);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const confirmationOperationRef = useRef(0);

  useLayoutEffect(() => {
    currentApiRef.current = api;
    selectedIdRef.current = undefined;
    confirmationOperationRef.current += 1;
    return () => {
      if (currentApiRef.current === api) currentApiRef.current = undefined;
      selectedIdRef.current = undefined;
      confirmationOperationRef.current += 1;
    };
  }, [api]);

  const [filter, setFilter] = useState<InboxFilter>("all");
  const [listStateOwned, setListStateOwned] = useState<ApiOwned<LoadState>>(() =>
    ownedBy(api, "loading"),
  );
  const [docsOwned, setDocsOwned] = useState<ApiOwned<InboxDocSummary[]>>(() =>
    ownedBy(api, []),
  );
  const [selectedIdOwned, setSelectedIdOwned] = useState<
    ApiOwned<string | undefined>
  >(() => ownedBy(api, undefined));
  const [detailOwned, setDetailOwned] = useState<ApiOwned<DetailState>>(() =>
    ownedBy(api, { phase: "idle" }),
  );
  const [confirmingOwned, setConfirmingOwned] = useState<ApiOwned<boolean>>(() =>
    ownedBy(api, false),
  );
  const [receiptErrorOwned, setReceiptErrorOwned] = useState<ApiOwned<boolean>>(() =>
    ownedBy(api, false),
  );
  const [reloadKey, setReloadKey] = useState(0);

  const listState = listStateOwned.api === api ? listStateOwned.value : "loading";
  const docs = docsOwned.api === api ? docsOwned.value : [];
  const selectedId = selectedIdOwned.api === api ? selectedIdOwned.value : undefined;
  const detail =
    detailOwned.api === api ? detailOwned.value : ({ phase: "idle" } satisfies DetailState);
  const confirming = confirmingOwned.api === api ? confirmingOwned.value : false;
  const receiptError = receiptErrorOwned.api === api ? receiptErrorOwned.value : false;

  // List load — refetched on filter change or explicit retry. The "loading"
  // transition is set by the triggering handlers (tab/retry), so the effect
  // only ever writes state from its async callbacks (no cascading renders).
  useEffect(() => {
    let live = true;
    api
      .loadDocs(filter)
      .then((items) => {
        if (!live || currentApiRef.current !== api) return;
        setDocsOwned(ownedBy(api, items));
        setListStateOwned(ownedBy(api, "ready"));
      })
      .catch(() => {
        if (live && currentApiRef.current === api) {
          setListStateOwned(ownedBy(api, "error"));
        }
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
        if (live && currentApiRef.current === api) {
          setDetailOwned(ownedBy(api, { phase: "ready", detail: doc }));
        }
      })
      .catch(() => {
        if (live && currentApiRef.current === api) {
          setDetailOwned(ownedBy(api, { phase: "error", id: selectedId }));
        }
      });
    return () => {
      live = false;
    };
  }, [api, selectedId]);

  const selectDoc = useCallback(
    (id: string) => {
      if (currentApiRef.current !== api) return;
      selectedIdRef.current = id;
      confirmationOperationRef.current += 1;
      setConfirmingOwned(ownedBy(api, false));
      setReceiptErrorOwned(ownedBy(api, false));
      setDetailOwned(ownedBy(api, { phase: "loading", id }));
      setSelectedIdOwned(ownedBy(api, id));
    },
    [api],
  );

  const confirmReceipt = useCallback(
    async (id: string) => {
      if (currentApiRef.current !== api) return;
      const operation = confirmationOperationRef.current + 1;
      confirmationOperationRef.current = operation;
      const hasApiAuthority = () => currentApiRef.current === api;
      const hasSelectionAuthority = () =>
        hasApiAuthority() &&
        selectedIdRef.current === id &&
        confirmationOperationRef.current === operation;

      setConfirmingOwned(ownedBy(api, true));
      setReceiptErrorOwned(ownedBy(api, false));
      let summary: InboxDocSummary;
      try {
        summary = await api.confirmReceipt(id);
      } catch {
        if (hasSelectionAuthority()) {
          setReceiptErrorOwned(ownedBy(api, true));
          setConfirmingOwned(ownedBy(api, false));
        }
        return;
      }

      // A confirmation remains authoritative list data after a same-api
      // selection change, but never after authenticated API identity changes.
      if (!hasApiAuthority()) return;
      setDocsOwned((previous) => {
        if (!hasApiAuthority()) return previous;
        const rows = previous.api === api ? previous.value : [];
        return ownedBy(
          api,
          rows.map((doc) => (doc.id === id ? summary : doc)),
        );
      });
      if (!hasSelectionAuthority()) return;

      try {
        const doc = await api.loadDoc(id);
        if (hasSelectionAuthority()) {
          setDetailOwned(ownedBy(api, { phase: "ready", detail: doc }));
        }
      } catch {
        if (hasSelectionAuthority()) {
          setDetailOwned(ownedBy(api, { phase: "error", id }));
        }
      } finally {
        if (hasSelectionAuthority()) setConfirmingOwned(ownedBy(api, false));
      }
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
        {INBOX_FILTERS.map((nextFilter) => {
          const active = filter === nextFilter;
          return (
            <button
              key={nextFilter}
              type="button"
              role="tab"
              aria-selected={active}
              data-window-control="true"
              style={tabStyle(active)}
              onClick={() => {
                if (active || currentApiRef.current !== api) return;
                selectedIdRef.current = undefined;
                confirmationOperationRef.current += 1;
                setSelectedIdOwned(ownedBy(api, undefined));
                setDetailOwned(ownedBy(api, { phase: "idle" }));
                setConfirmingOwned(ownedBy(api, false));
                setReceiptErrorOwned(ownedBy(api, false));
                setListStateOwned(ownedBy(api, "loading"));
                setFilter(nextFilter);
              }}
            >
              {S.filters[nextFilter]}
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
                  if (currentApiRef.current !== api) return;
                  setListStateOwned(ownedBy(api, "loading"));
                  setReloadKey((key) => key + 1);
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
            onConfirm={(id) => {
              void confirmReceipt(id);
            }}
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
