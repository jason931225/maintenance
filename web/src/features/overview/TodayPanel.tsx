// UI-M3 Overview — Today/Plan side panel: personal todos CRUD bound to the
// todos domain (/api/v1/me/todos) plus the caller's punch/attendance status
// derived from their latest attendance record.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type { TodoSummary } from "../../api/types";
import { Chip, SectionCard } from "../../components/console/primitives";
import { emitConsoleToast } from "../../components/shell/useConsoleToast";
import { PageError } from "../../components/states/PageError";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";

type PunchState = "CLOCKED_IN" | "OUT_FOR_WORK" | "BUSINESS_TRIP" | "OFF_DUTY";
type ReadState = "loading" | "idle" | "error";

const t = ko.overview.today;

function punchLabel(state: PunchState): string {
  return t.punchStates[state];
}

function isPunchState(value: string): value is PunchState {
  return value in t.punchStates;
}

export function TodayPanel({ active = true }: { active?: boolean }) {
  const { api } = useAuth();
  const mountedRef = useRef(false);
  const loadTodosRequestRef = useRef(0);
  const [todos, setTodos] = useState<TodoSummary[]>([]);
  const [todosState, setTodosState] = useState<ReadState>("loading");
  const [showDone, setShowDone] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [punch, setPunch] = useState<PunchState | undefined>();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadTodos = useCallback(
    async (includeDone: boolean) => {
      const requestId = loadTodosRequestRef.current + 1;
      loadTodosRequestRef.current = requestId;
      const isCurrentRequest = () =>
        mountedRef.current && loadTodosRequestRef.current === requestId;
      setTodosState("loading");
      const response = await api
        .GET("/api/v1/me/todos", {
          params: { query: { include_done: includeDone, limit: 100 } },
        })
        .catch(() => undefined);
      if (!isCurrentRequest()) return;
      if (!response?.data) {
        setTodosState("error");
        return;
      }
      setTodos(response.data.items);
      setTodosState("idle");
    },
    [api],
  );

  const loadPunch = useCallback(async () => {
    const response = await api
      .GET("/api/v1/hr/attendance-records/me", {
        params: { query: { limit: 1, offset: 0 } },
      })
      .catch(() => undefined);
    if (!mountedRef.current) return;
    // Punch status is auxiliary: a failed read renders no chip rather than
    // failing the whole panel. No records at all = off duty.
    if (!response?.data) {
      setPunch(undefined);
      return;
    }
    const latest = response.data.items[0]?.state_after ?? "OFF_DUTY";
    setPunch(isPunchState(latest) ? latest : undefined);
  }, [api]);

  useEffect(() => {
    if (!active) return;
    void Promise.resolve().then(() => loadTodos(showDone));
    void Promise.resolve().then(loadPunch);
  }, [active, loadPunch, loadTodos, showDone]);

  const createTodo = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const response = await api
      .POST("/api/v1/me/todos", {
        body: { text: trimmed, scopes: [], links: [] },
      })
      .catch(() => undefined);
    if (!mountedRef.current) return;
    setBusy(false);
    if (!response?.data) {
      emitConsoleToast({ message: t.createFailed });
      return;
    }
    setText("");
    await loadTodos(showDone);
  }, [api, busy, loadTodos, showDone, text]);

  const writeTodoDone = useCallback(
    async (todo: TodoSummary, done: boolean) => {
      const response = await api
        .POST("/api/v1/me/todos/{todoId}/done", {
          params: { path: { todoId: todo.id } },
          body: { done },
        })
        .catch(() => undefined);
      if (!mountedRef.current) return undefined;
      return Boolean(response?.data);
    },
    [api],
  );

  const setDone = useCallback(
    async (todo: TodoSummary, done: boolean, withUndoToast: boolean) => {
      const ok = await writeTodoDone(todo, done);
      if (!mountedRef.current) return;
      if (!ok) {
        emitConsoleToast({ message: t.mutateFailed });
        return;
      }
      if (withUndoToast && done) {
        emitConsoleToast({
          message: t.doneToast,
          onUndo: () => {
            void writeTodoDone(todo, false).then((undoOk) => {
              if (!mountedRef.current) return;
              if (!undoOk) {
                emitConsoleToast({ message: t.mutateFailed });
                return;
              }
              void loadTodos(showDone);
            });
          },
        });
      }
      await loadTodos(showDone);
    },
    [loadTodos, showDone, writeTodoDone],
  );

  const deleteTodo = useCallback(
    async (todo: TodoSummary) => {
      const response = await api
        .DELETE("/api/v1/me/todos/{todoId}", {
          params: { path: { todoId: todo.id } },
        })
        .catch(() => undefined);
      if (!mountedRef.current) return;
      if (!response || response.response.status >= 400) {
        emitConsoleToast({ message: t.mutateFailed });
        await loadTodos(showDone);
        return;
      }
      emitConsoleToast({ message: t.deletedToast });
      await loadTodos(showDone);
    },
    [api, loadTodos, showDone],
  );

  return (
    <SectionCard title={t.title} meta={t.hint} className="h-fit">
      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold text-console-steel">
            {t.punchLabel}
          </span>
          <span className="flex items-center gap-2">
            {punch ? (
              <Chip tone={punch === "OFF_DUTY" ? "neutral" : "ok"}>
                {punchLabel(punch)}
              </Chip>
            ) : null}
            <Link
              to="/attendance"
              className="text-[11px] font-bold text-console-signal underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-console-signal"
            >
              {t.punchLink}
            </Link>
          </span>
        </div>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createTodo();
          }}
        >
          <label className="min-w-0 flex-1">
            <span className="sr-only">{t.addLabel}</span>
            <input
              type="text"
              value={text}
              maxLength={500}
              placeholder={t.addPlaceholder}
              onChange={(event) => {
                setText(event.currentTarget.value);
              }}
              className="min-h-9 w-full rounded-[8px] border border-console-border bg-console-canvas px-3 text-[13px] text-console-ink placeholder:text-console-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
            />
          </label>
          <button
            type="submit"
            disabled={busy || text.trim().length === 0}
            className="min-h-9 shrink-0 rounded-[8px] border border-console-border bg-console-surface px-3 text-[12px] font-bold text-console-ink hover:bg-console-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal disabled:opacity-50"
          >
            {t.addButton}
          </button>
        </form>

        {todosState === "error" ? (
          <PageError
            message={t.loadFailed}
            onRetry={() => {
              void loadTodos(showDone);
            }}
          />
        ) : todosState === "idle" && todos.length === 0 ? (
          <p className="text-[12px] text-console-steel">{t.empty}</p>
        ) : (
          <ul className="grid gap-1.5" aria-label={t.todosLabel}>
            {todos.map((todo) => (
              <li
                key={todo.id}
                className="grid grid-cols-[auto_1fr_auto] items-start gap-2 rounded-[7px] border border-console-border px-2 py-1.5"
              >
                <input
                  type="checkbox"
                  checked={todo.done}
                  aria-label={(todo.done ? t.undoneAction : t.doneAction).replace(
                    "{text}",
                    todo.text,
                  )}
                  onChange={() => {
                    void setDone(todo, !todo.done, true);
                  }}
                  className="mt-0.5 size-4 accent-console-signal"
                />
                <div className="min-w-0">
                  <p
                    className={
                      todo.done
                        ? "truncate text-[13px] text-console-faint line-through"
                        : "truncate text-[13px] text-console-ink"
                    }
                  >
                    {todo.text}
                  </p>
                  {todo.scopes.length > 0 || todo.links.length > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {[...todo.scopes, ...todo.links].map((ref, index) => (
                        <Chip key={`${todo.id}-${String(index)}`} tone="info">
                          {ref.label ?? `${ref.kind}:${ref.id.slice(0, 8)}`}
                        </Chip>
                      ))}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-label={t.deleteAction.replace("{text}", todo.text)}
                  onClick={() => {
                    void deleteTodo(todo);
                  }}
                  className="rounded px-1.5 py-0.5 text-[12px] font-bold text-console-faint hover:bg-console-muted hover:text-console-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <label className="flex items-center gap-2 text-[11px] font-bold text-console-steel">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(event) => {
              setShowDone(event.currentTarget.checked);
            }}
            className="size-3.5 accent-console-signal"
          />
          {t.showDone}
        </label>
      </div>
    </SectionCard>
  );
}
