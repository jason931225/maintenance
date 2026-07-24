import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useNavigate } from "react-router";

import { resolveRowTitle } from "../../../lib/rowTitle";
import { StatusChip } from "../../components";
import "../../tokens.css";
import { screenHeaderStyle, screenTitleStyle } from "../screenHeader";
import { MyWorkDetailPanel } from "./MyWorkDetailPanel";
import type { MyWorkApi, TodoSummary } from "./myWorkApi";
import {
  actionInboxDue,
  actionInboxDoneTone,
  actionInboxTone,
  actionStatusLabel,
  actionInboxLinkRoute,
  dueCountOn,
  filterAssigned,
  kindLabel,
  myWorkStrings,
  urgencyLabel,
  weekDays,
  type ActionInboxItem,
  type DayFilter,
} from "./myWorkModel";

type LoadState = "loading" | "ready" | "error";

const EMPTY_ACTION_ITEMS: readonly ActionInboxItem[] = [];

interface ApiOwned<T> {
  api: object;
  value: T;
}

function ownedBy<T>(api: object, value: T): ApiOwned<T> {
  return { api, value };
}

function assignedDetailId(itemId: string): string {
  return `mywork-assigned-detail-${encodeURIComponent(itemId)}`;
}

export interface MyWorkBodyProps {
  api: MyWorkApi;
  now?: Date;
  /** Assigned-item drill; invoked only when a canonical source-object link resolves. */
  onOpen?: (item: ActionInboxItem) => void;
}

export function MyWorkBody({ api, now, onOpen }: MyWorkBodyProps) {
  const S = useMemo(() => myWorkStrings(), []);
  const navigate = useNavigate();
  const today = useMemo(() => now ?? new Date(), [now]);
  const currentApiRef = useRef<MyWorkApi | undefined>(api);
  const todosRequest = useRef(0);
  const inboxCursors = useRef(new Set<string>());

  useLayoutEffect(() => {
    currentApiRef.current = api;
    inboxCursors.current = new Set();
    todosRequest.current += 1;
    return () => {
      if (currentApiRef.current === api) currentApiRef.current = undefined;
      todosRequest.current += 1;
    };
  }, [api]);

  const [inboxStateOwned, setInboxStateOwned] = useState<ApiOwned<LoadState>>(() =>
    ownedBy(api, "loading"),
  );
  const [itemsOwned, setItemsOwned] = useState<ApiOwned<ActionInboxItem[]>>(() =>
    ownedBy(api, []),
  );
  const [nextCursorOwned, setNextCursorOwned] = useState<ApiOwned<string | null>>(() =>
    ownedBy(api, null),
  );
  const [loadingMoreOwned, setLoadingMoreOwned] = useState<ApiOwned<boolean>>(() =>
    ownedBy(api, false),
  );
  const [dayFilter, setDayFilter] = useState<DayFilter>("all");
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const assignedRowRefs = useRef(new Map<string, HTMLButtonElement>());

  const [todosStateOwned, setTodosStateOwned] = useState<ApiOwned<LoadState>>(() =>
    ownedBy(api, "loading"),
  );
  const [todosOwned, setTodosOwned] = useState<ApiOwned<TodoSummary[]>>(() =>
    ownedBy(api, []),
  );
  const [showDone, setShowDone] = useState(false);
  const [textOwned, setTextOwned] = useState<ApiOwned<string>>(() => ownedBy(api, ""));
  const [busyOwned, setBusyOwned] = useState<ApiOwned<boolean>>(() => ownedBy(api, false));
  const [todoErrorOwned, setTodoErrorOwned] = useState<ApiOwned<string | undefined>>(() =>
    ownedBy(api, undefined),
  );
  const showDoneRef = useRef(showDone);

  const inboxState = inboxStateOwned.api === api ? inboxStateOwned.value : "loading";
  const items = itemsOwned.api === api ? itemsOwned.value : EMPTY_ACTION_ITEMS;
  const nextCursor = nextCursorOwned.api === api ? nextCursorOwned.value : null;
  const loadingMore = loadingMoreOwned.api === api && loadingMoreOwned.value;
  const todosState = todosStateOwned.api === api ? todosStateOwned.value : "loading";
  const todos = todosOwned.api === api ? todosOwned.value : [];
  const text = textOwned.api === api ? textOwned.value : "";
  const busy = busyOwned.api === api ? busyOwned.value : false;
  const todoError = todoErrorOwned.api === api ? todoErrorOwned.value : undefined;

  const dueFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("ko-KR", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    [],
  );
  const dowFmt = useMemo(() => new Intl.DateTimeFormat("ko-KR", { weekday: "narrow" }), []);

  // The "loading" transition is set by the triggering handlers (retry), so the
  // effect only writes state from its async callbacks (no cascading renders).
  useEffect(() => {
    let live = true;
    api
      .loadInbox()
      .then((res) => {
        if (!live || currentApiRef.current !== api) return;
        setItemsOwned(ownedBy(api, res.items));
        setSelectedItemId((current) =>
          current && res.items.some((item) => item.id === current) ? current : undefined,
        );
        const next = res.next_cursor ?? null;
        inboxCursors.current = new Set(next ? [next] : []);
        setNextCursorOwned(ownedBy(api, next));
        setInboxStateOwned(ownedBy(api, "ready"));
      })
      .catch(() => {
        if (live && currentApiRef.current === api) {
          setInboxStateOwned(ownedBy(api, "error"));
        }
      });
    return () => {
      live = false;
    };
  }, [api, reloadKey]);

  const loadMoreInbox = useCallback(() => {
    if (!nextCursor || loadingMore || currentApiRef.current !== api) return;
    const requestedCursor = nextCursor;
    setLoadingMoreOwned(ownedBy(api, true));
    api
      .loadInbox(requestedCursor)
      .then((page) => {
        if (currentApiRef.current !== api) return;
        const next = page.next_cursor ?? null;
        if (next && inboxCursors.current.has(next)) {
          throw new Error("action-inbox cursor repeated");
        }
        if (next) inboxCursors.current.add(next);
        setItemsOwned((current) => {
          const existing = current.api === api ? current.value : [];
          const ids = new Set(existing.map((item) => item.id));
          return ownedBy(api, [
            ...existing,
            ...page.items.filter((item) => !ids.has(item.id)),
          ]);
        });
        setNextCursorOwned(ownedBy(api, next));
      })
      .catch(() => {
        if (currentApiRef.current === api) {
          setInboxStateOwned(ownedBy(api, "error"));
        }
      })
      .finally(() => {
        if (currentApiRef.current === api) {
          setLoadingMoreOwned(ownedBy(api, false));
        }
      });
  }, [api, loadingMore, nextCursor]);

  // loadTodos never sets "loading" synchronously (it would cascade when called
  // from the mount effect); callers that want the flash set it themselves.
  const loadTodos = useCallback(
    (includeDone: boolean) => {
      if (currentApiRef.current !== api) return Promise.resolve();
      const request = todosRequest.current + 1;
      todosRequest.current = request;
      return api
        .loadTodos(includeDone)
        .then((rows) => {
          if (currentApiRef.current !== api || todosRequest.current !== request) return;
          setTodosOwned(ownedBy(api, rows));
          setTodosStateOwned(ownedBy(api, "ready"));
        })
        .catch(() => {
          if (currentApiRef.current === api && todosRequest.current === request) {
            setTodosStateOwned(ownedBy(api, "error"));
          }
        });
    },
    [api],
  );

  useEffect(() => {
    void loadTodos(showDone);
  }, [loadTodos, showDone]);

  const openItem = useCallback(
    (item: ActionInboxItem) => {
      const destination = actionInboxLinkRoute(item);
      if (!destination) return;
      if (onOpen) {
        onOpen(item);
        return;
      }
      void navigate(destination);
    },
    [onOpen, navigate],
  );

  const createTodo = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || busy || currentApiRef.current !== api) return;
    setBusyOwned(ownedBy(api, true));
    setTodoErrorOwned(ownedBy(api, undefined));
    api
      .createTodo(trimmed)
      .then(() => {
        if (currentApiRef.current !== api) return;
        setTextOwned(ownedBy(api, ""));
        return loadTodos(showDoneRef.current);
      })
      .catch(() => {
        if (currentApiRef.current === api) {
          setTodoErrorOwned(ownedBy(api, S.todos.createFailed));
        }
      })
      .finally(() => {
        if (currentApiRef.current === api) setBusyOwned(ownedBy(api, false));
      });
  }, [api, busy, loadTodos, text, S]);

  const toggleDone = useCallback(
    (todo: TodoSummary) => {
      if (currentApiRef.current !== api) return;
      setTodoErrorOwned(ownedBy(api, undefined));
      api
        .setTodoDone(todo.id, !todo.done)
        .then(() => {
          if (currentApiRef.current !== api) return;
          return loadTodos(showDoneRef.current);
        })
        .catch(() => {
          if (currentApiRef.current === api) {
            setTodoErrorOwned(ownedBy(api, S.todos.mutateFailed));
          }
        });
    },
    [api, loadTodos, S],
  );

  const removeTodo = useCallback(
    (todo: TodoSummary) => {
      if (currentApiRef.current !== api) return;
      setTodoErrorOwned(ownedBy(api, undefined));
      api
        .deleteTodo(todo.id)
        .then(() => {
          if (currentApiRef.current !== api) return;
          return loadTodos(showDoneRef.current);
        })
        .catch(() => {
          if (currentApiRef.current === api) {
            setTodoErrorOwned(ownedBy(api, S.todos.mutateFailed));
          }
        });
    },
    [api, loadTodos, S],
  );

  const days = useMemo(() => weekDays(today), [today]);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const rows = useMemo(() => filterAssigned(items, dayFilter), [items, dayFilter]);
  const selectedItem = useMemo(
    () => rows.find((item) => item.id === selectedItemId),
    [rows, selectedItemId],
  );

  const setAssignedDayFilter = useCallback(
    (nextFilter: DayFilter) => {
      setDayFilter(nextFilter);
      if (nextFilter === "all" || !selectedItem) return;
      const selectedDue = actionInboxDue(selectedItem.due);
      if (!selectedDue || !sameDay(selectedDue, nextFilter.day)) {
        setSelectedItemId(undefined);
      }
    },
    [selectedItem],
  );

  const closeDetail = useCallback(() => {
    const previousId = selectedItemId;
    setSelectedItemId(undefined);
    if (previousId) assignedRowRefs.current.get(previousId)?.focus();
  }, [selectedItemId]);

  const moveAssignedFocus = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      const key = event.key.toLowerCase();
      const direction = key === "j" || key === "arrowdown" ? 1 : key === "k" || key === "arrowup" ? -1 : 0;
      if (!direction) return;

      const controls = rows
        .map((item) => assignedRowRefs.current.get(item.id))
        .filter((control): control is HTMLButtonElement => control !== undefined);
      if (controls.length === 0) return;

      const currentIndex = controls.findIndex((control) => control === document.activeElement);
      const nextIndex =
        currentIndex === -1
          ? direction > 0
            ? 0
            : controls.length - 1
          : (currentIndex + direction + controls.length) % controls.length;
      event.preventDefault();
      controls[nextIndex]?.focus();
    },
    [rows],
  );

  return (
    <div
      className="console"
      style={rootStyle}
      onKeyDown={(event) => {
        if (event.key === "Escape" && selectedItem) {
          event.preventDefault();
          closeDetail();
        }
      }}
    >
      <header style={headerStyle}>
        <h1 style={titleStyle}>{S.title}</h1>
      </header>

      <div style={gridStyle}>
        {/* 할 일 — personal todos CRUD */}
        <section style={panelStyle} aria-label={S.todos.title}>
          <div style={panelHeadStyle}>
            <h2 style={panelTitleStyle}>{S.todos.title}</h2>
            <span style={countBadgeStyle}>{todos.length}</span>
          </div>

          <form
            style={addFormStyle}
            onSubmit={(e) => {
              e.preventDefault();
              createTodo();
            }}
          >
            <input
              type="text"
              value={text}
              maxLength={500}
              placeholder={S.todos.addPlaceholder}
              aria-label={S.todos.addPlaceholder}
              onChange={(e) => {
                if (currentApiRef.current !== api) return;
                setTextOwned(ownedBy(api, e.currentTarget.value));
              }}
              style={inputStyle}
            />
            <button
              type="submit"
              data-window-control="true"
              disabled={busy || text.trim().length === 0}
              style={addButtonStyle}
            >
              {S.todos.addButton}
            </button>
          </form>

          {todoError ? (
            <p role="alert" style={{ margin: 0, color: "var(--danger-tx)", fontSize: "var(--text-sm)" }}>
              {todoError}
            </p>
          ) : null}

          {todosState === "error" ? (
            <div role="alert" style={{ display: "grid", gap: "var(--sp-2)" }}>
              <p style={{ margin: 0, color: "var(--steel)" }}>{S.error}</p>
              <button
                type="button"
                data-window-control="true"
                style={ghostButtonStyle}
                onClick={() => {
                  if (currentApiRef.current !== api) return;
                  setTodosStateOwned(ownedBy(api, "loading"));
                  void loadTodos(showDone);
                }}
              >
                {S.retry}
              </button>
            </div>
          ) : todosState === "loading" ? (
            <StatusChip role="status">{S.loading}</StatusChip>
          ) : todos.length === 0 ? (
            <p style={emptyStyle}>{S.todos.empty}</p>
          ) : (
            <ul style={listStyle}>
              {todos.map((todo) => (
                <li key={todo.id} style={todoRowStyle}>
                  <input
                    type="checkbox"
                    checked={todo.done}
                    aria-label={S.todos.doneToggle(todo.text)}
                    onChange={() => {
                      toggleDone(todo);
                    }}
                    style={{ width: 16, height: 16, marginTop: 2 }}
                  />
                  <span style={todo.done ? todoTextDoneStyle : todoTextStyle}>{todo.text}</span>
                  <button
                    type="button"
                    data-window-control="true"
                    aria-label={S.todos.deleteLabel(todo.text)}
                    style={deleteButtonStyle}
                    onClick={() => {
                      removeTodo(todo);
                    }}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label style={showDoneStyle}>
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => {
                if (currentApiRef.current !== api) return;
                showDoneRef.current = e.currentTarget.checked;
                setTodosStateOwned(ownedBy(api, "loading"));
                setShowDone(e.currentTarget.checked);
              }}
              style={{ width: 14, height: 14 }}
            />
            {S.todos.showDone}
          </label>
        </section>

        {/* 배정된 업무 — assigned action-inbox items + real week ribbon */}
        <section style={panelStyle} aria-label={S.assigned.title}>
          <div style={panelHeadStyle}>
            <h2 style={panelTitleStyle}>{S.assigned.title}</h2>
            <span style={countBadgeStyle}>{rows.length}</span>
          </div>

          <div style={weekStripStyle} role="group" aria-label={S.assigned.title}>
            <button
              type="button"
              data-window-control="true"
              aria-pressed={dayFilter === "all"}
              style={allDayChipStyle(dayFilter === "all")}
              onClick={() => {
                setAssignedDayFilter("all");
              }}
            >
              {S.assigned.allDays}
            </button>
            {days.map((day) => {
              const count = dueCountOn(items, day);
              const active = dayFilter !== "all" && sameDay(dayFilter.day, day);
              const isToday = sameDay(day, today);
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  data-window-control="true"
                  aria-pressed={active}
                  aria-label={`${dowFmt.format(day)} ${String(day.getDate())} · ${String(count)}`}
                  style={weekCellStyle(active, isToday)}
                  onClick={() => {
                    setAssignedDayFilter({ day });
                  }}
                >
                  <span style={weekDowStyle}>{dowFmt.format(day)}</span>
                  <span style={weekNumStyle(active)}>{day.getDate()}</span>
                  <span style={count > 0 ? weekDotStyle : weekDotEmptyStyle}>
                    {count > 0 ? count : ""}
                  </span>
                </button>
              );
            })}
          </div>

          {inboxState === "error" ? (
            <div role="alert" style={{ display: "grid", gap: "var(--sp-2)" }}>
              <p style={{ margin: 0, color: "var(--steel)" }}>{S.error}</p>
              <button
                type="button"
                data-window-control="true"
                style={ghostButtonStyle}
                onClick={() => {
                  if (currentApiRef.current !== api) return;
                  setInboxStateOwned(ownedBy(api, "loading"));
                  setReloadKey((k) => k + 1);
                }}
              >
                {S.retry}
              </button>
            </div>
          ) : inboxState === "loading" ? (
            <StatusChip role="status">{S.loading}</StatusChip>
          ) : rows.length === 0 ? (
            <p style={emptyStyle}>{S.assigned.empty}</p>
          ) : (
            <div style={assignedWorkspaceStyle}>
              <ul
                style={listStyle}
                aria-keyshortcuts="J K ArrowDown ArrowUp Enter Escape"
                onKeyDown={moveAssignedFocus}
              >
                {rows.map((item) => {
                const destination = actionInboxLinkRoute(item);
                const selected = selectedItem?.id === item.id;
                const due = actionInboxDue(item.due);
                const resolved = resolveRowTitle(
                  item.title,
                  item.ref,
                  item.site ?? kindLabel(item.kind, S),
                );
                const siteInTitle = resolved.title === item.site;
                const meta = [siteInTitle ? undefined : item.site, item.who].filter(Boolean).join(" · ");
                return (
                  <li key={item.id} style={assignedRowStyle}>
                    <StatusChip tone={actionInboxDoneTone(item.done)}>{kindLabel(item.kind, S)}</StatusChip>
                    <StatusChip tone={actionInboxTone(item.dueTone)}>{urgencyLabel(item.urg, S)}</StatusChip>
                    <div style={assignedContentStyle}>
                      <button
                        ref={(control) => {
                          if (control) assignedRowRefs.current.set(item.id, control);
                          else assignedRowRefs.current.delete(item.id);
                        }}
                        type="button"
                        data-window-control="true"
                        aria-expanded={selected}
                        aria-controls={selected ? assignedDetailId(item.id) : undefined}
                        style={assignedSelectStyle(selected)}
                        onClick={() => {
                          setSelectedItemId(item.id);
                        }}
                      >
                        <span style={rowTitleStyle}>
                          <span style={titleTextStyle}>{resolved.title}</span>
                          {resolved.code ? <span style={rowCodeStyle}>{resolved.code}</span> : null}
                        </span>
                      </button>
                      {meta ? <div style={rowMetaStyle}>{meta}</div> : null}
                    </div>
                    {due ? (
                      <time
                        dateTime={item.due}
                        aria-label={S.assigned.dueAt(dueFmt.format(due))}
                        style={dueStyle}
                      >
                        {S.assigned.dueAt(dueFmt.format(due))}
                      </time>
                    ) : item.due != null ? (
                      <StatusChip tone="neutral">{S.assigned.dueUnavailable}</StatusChip>
                    ) : null}
                    <StatusChip tone={actionInboxDoneTone(item.done)}>
                      {actionStatusLabel(item.done, S)}
                    </StatusChip>
                    <button
                      type="button"
                      data-window-control="true"
                      style={ghostButtonStyle}
                      disabled={!destination}
                      onClick={() => {
                        openItem(item);
                      }}
                    >
                      {S.assigned.open}
                    </button>
                  </li>
                );
                })}
              </ul>
              {selectedItem ? (
                <MyWorkDetailPanel
                  detailId={assignedDetailId(selectedItem.id)}
                  item={selectedItem}
                  dueFmt={dueFmt}
                  onClose={closeDetail}
                  onOpen={openItem}
                  strings={S}
                />
              ) : null}
              {nextCursor ? (
                <button
                  type="button"
                  data-window-control="true"
                  style={ghostButtonStyle}
                  disabled={loadingMore}
                  onClick={loadMoreInbox}
                >
                  {loadingMore ? S.loading : S.assigned.loadMore}
                </button>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ── styles (console tokens only) ─────────────────────────────────────────────

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-6)",
  fontFamily: "var(--font-sans)",
  color: "var(--ink)",
  minHeight: 0,
  overflow: "auto",
};

const headerStyle = screenHeaderStyle;
const titleStyle = screenTitleStyle;

const gridStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  // Two dense panels when space permits; one column before either queue loses
  // readable task actions or metadata. `min(100%, …)` also keeps narrow
  // embedded/windowed console views from overflowing.
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 24rem), 1fr))",
  alignItems: "start",
};

const panelStyle: CSSProperties = {
  display: "grid",
  alignContent: "start",
  gap: "var(--sp-3)",
  padding: "var(--sp-card-y) var(--sp-6)",
  border: "var(--border-hairline)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
  minWidth: 0,
};

const panelHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const panelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const countBadgeStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--faint)",
  fontVariantNumeric: "tabular-nums",
};

const addFormStyle: CSSProperties = {
  display: "flex",
  gap: "var(--sp-2)",
};

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 36,
  padding: "0 var(--sp-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};

const addButtonStyle: CSSProperties = {
  flex: "none",
  minHeight: 36,
  padding: "0 var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-medium)",
  cursor: "pointer",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const todoRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--sp-3)",
  padding: "var(--sp-2) 0",
  borderTop: "1px solid var(--border-soft)",
};

const todoTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: "var(--text-body)",
  color: "var(--ink)",
};

const todoTextDoneStyle: CSSProperties = {
  ...todoTextStyle,
  color: "var(--faint)",
  textDecoration: "line-through",
};

const deleteButtonStyle: CSSProperties = {
  flex: "none",
  border: "none",
  background: "transparent",
  color: "var(--faint)",
  fontSize: "var(--text-body)",
  cursor: "pointer",
  padding: "0 var(--sp-1)",
};

const showDoneStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-medium)",
};

const weekStripStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "stretch",
  gap: "var(--sp-1)",
};

function allDayChipStyle(active: boolean): CSSProperties {
  return {
    minHeight: 30,
    padding: "0 var(--sp-3)",
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

function weekCellStyle(active: boolean, isToday: boolean): CSSProperties {
  return {
    display: "grid",
    justifyItems: "center",
    gap: 2,
    minWidth: "2.6rem",
    padding: "var(--sp-2) var(--sp-1)",
    borderRadius: "var(--radius-sm)",
    border: `1px solid ${active ? "var(--ink)" : "var(--border)"}`,
    background: active ? "var(--muted)" : isToday ? "var(--muted)" : "var(--surface)",
    cursor: "pointer",
  };
}

const weekDowStyle: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--faint)",
};

function weekNumStyle(active: boolean): CSSProperties {
  return {
    fontSize: "var(--text-sm)",
    fontVariantNumeric: "tabular-nums",
    fontWeight: active ? "var(--fw-strong)" : "var(--fw-body)",
    color: active ? "var(--ink)" : "var(--steel)",
  };
}

const weekDotStyle: CSSProperties = {
  minWidth: 16,
  height: 16,
  lineHeight: "16px",
  borderRadius: 8,
  background: "var(--ink)",
  color: "var(--surface)",
  fontSize: 10,
  fontVariantNumeric: "tabular-nums",
  textAlign: "center",
};

const weekDotEmptyStyle: CSSProperties = {
  height: 16,
};

const assignedRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-3)",
  padding: "var(--sp-3) 0",
  borderTop: "1px solid var(--border-soft)",
};

const assignedWorkspaceStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))",
  alignItems: "start",
  gap: "var(--sp-4)",
};

const assignedContentStyle: CSSProperties = {
  flex: "1 1 12rem",
  minWidth: "min(100%, 12rem)",
};

function assignedSelectStyle(selected: boolean): CSSProperties {
  return {
    display: "block",
    width: "100%",
    padding: 0,
    border: "none",
    background: "transparent",
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    outlineOffset: 2,
    ...(selected ? { color: "var(--teal)" } : undefined),
  };
}

const rowTitleStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--sp-2)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-medium)",
  color: "var(--ink)",
  minWidth: 0,
};

const titleTextStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const rowCodeStyle: CSSProperties = {
  flex: "none",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
  color: "var(--faint)",
};

const rowMetaStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--steel)",
};

const dueStyle: CSSProperties = {
  flex: "none",
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

const ghostButtonStyle: CSSProperties = {
  flex: "none",
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
