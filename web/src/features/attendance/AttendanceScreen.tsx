import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { attendanceStrings as text } from "../../i18n/attendance";
import { consoleScreenPath } from "../../console/shell/nav";
import { Dialog } from "../../components/ui/dialog";
import {
  AttendanceTransportError,
  type AttendanceTransport,
  type AttendanceException,
  type CloseAmendmentInput,
  type CreateAttendanceException,
  type ClosePreflight,
  type EmployeeAttendanceRecord,
  type MonthCloseBoard,
  type MonthClose,
  type MonthCloseItem,
  type Page,
  type Substitution,
  type Week52Board,
  type Week52Row,
} from "./attendanceApi";
import { SubstitutionCandidateDialog } from "./SubstitutionCandidateDialog";
import type { AttendanceCapabilities } from "./attendanceCapabilities";
import {
  checkedInCount,
  coverPlanRows,
  dayBoardRows,
  formatWindow,
  isoDate,
  isoMonth,
  monthOperationalRange,
  minutesOfDay,
  monthSheetRows,
  weekStart,
  type EmployeeDayRow,
} from "./attendanceModel";
import "./attendance.css";

type Props = {
  transport: AttendanceTransport;
  branchId: string;
  actorId: string | undefined;
  capabilities: AttendanceCapabilities;
  /** Changes whenever auth replaces the effective tenant/session. */
  sessionKey: string | undefined;
  /** Whether this persistent shell slot is currently visible and authorized to read. */
  active?: boolean;
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  now?: () => Date;
};

const transportFenceIds = new WeakMap<object, number>();
let nextTransportFenceId = 1;

function transportFenceKey(transport: AttendanceTransport): number {
  const reference = transport as object;
  const existing = transportFenceIds.get(reference);
  if (existing) return existing;
  const id = nextTransportFenceId++;
  transportFenceIds.set(reference, id);
  return id;
}

type Res<T> =
  | { s: "loading" }
  | { s: "denied" }
  | { s: "error"; message: string }
  | { s: "ready"; data: T };

type MutationFence = {
  generation: number;
  month: string;
};

function resolveError(
  cause: unknown,
): { s: "denied" } | { s: "error"; message: string } {
  if (cause instanceof AttendanceTransportError && cause.status === 403)
    return { s: "denied" };
  return {
    s: "error",
    message: cause instanceof Error ? cause.message : text.loadError,
  };
}

function pct(min: number): string {
  return `${String((min / 1440) * 100)}%`;
}

function storageGet(key: string): string | undefined {
  try {
    return window.sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function storageSet(key: string, value: string | undefined) {
  try {
    if (value === undefined) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable: drafts simply do not survive */
  }
}

function exceptionToneClass(kind: AttendanceException["kind"]): string {
  if (kind === "NO_SHOW")
    return "attendance__extype attendance__extype--danger";
  if (kind === "UNAPPROVED_OVERTIME")
    return "attendance__extype attendance__extype--info";
  return "attendance__extype attendance__extype--warn";
}

function linkHref(ref: string | null | undefined): string {
  if (ref && ref.startsWith("AP-")) return consoleScreenPath("appr");
  return consoleScreenPath("objectExplorer");
}

const PEOPLE_HREF = consoleScreenPath("people");
const LEAVE_HREF = consoleScreenPath("leave");
const LABORCOST_HREF = consoleScreenPath("laborcost");

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Re-mount synchronously whenever effective authority changes. Effects run too
 * late to fence an old tenant/session's selection, drafts, or busy state.
 */
export function AttendanceScreen(props: Props) {
  if (props.active === false) return null;
  const capabilityKey = Object.values(props.capabilities).join(":");
  const sessionFence = [
    props.sessionKey ?? "no-session",
    props.branchId,
    props.actorId ?? "no-actor",
    transportFenceKey(props.transport),
    capabilityKey,
  ].join(":");
  return <AttendanceScreenBodyInner key={sessionFence} {...props} />;
}

function AttendanceScreenBodyInner({
  transport,
  capabilities,
  sessionKey,
  now,
}: Props) {
  const clock = now ?? (() => new Date());
  const today = isoDate(clock());
  const currentWeek = weekStart(clock());
  const nowMin = minutesOfDay(clock().toISOString());

  const [view, setView] = useState<"day" | "month">(() =>
    storageGet("attendance:view") === "month" ? "month" : "day",
  );
  const [month, setMonth] = useState<string>(() => {
    const stored = storageGet("attendance:month");
    return stored && /^\d{4}-(0[1-9]|1[0-2])$/.test(stored)
      ? stored
      : isoMonth(clock());
  });
  const substitutionWindow = useMemo(() => monthOperationalRange(month), [month]);
  const [exceptions, setExceptions] = useState<Res<Page<AttendanceException>>>({
    s: "loading",
  });
  const [substitutions, setSubstitutions] = useState<Res<Page<Substitution>>>({
    s: "loading",
  });
  const [closes, setCloses] = useState<Res<MonthCloseBoard>>({ s: "loading" });
  const [week52, setWeek52] = useState<Res<Week52Board>>({ s: "loading" });
  const [records, setRecords] = useState<
    Res<{ items: EmployeeAttendanceRecord[] }>
  >({
    s: "loading",
  });
  const [coverOpen, setCoverOpen] = useState(false);
  const [employeeFilter, setEmployeeFilter] = useState<string>();
  const [exOpen, setExOpen] = useState<AttendanceException>();
  const [subGap, setSubGap] = useState<AttendanceException>();
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [cancelSub, setCancelSub] = useState<Substitution>();
  const [amendClose, setAmendClose] = useState<MonthCloseItem>();
  const [preflight, setPreflight] = useState<{
    data: ClosePreflight;
    scope: string;
    month: string;
    generation: number;
  }>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const generation = useRef(0);
  const operation = useRef<AbortController | undefined>(undefined);
  const boardRef = useRef<HTMLElement | null>(null);
  const exceptionsRef = useRef<HTMLElement | null>(null);
  const w52Ref = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLElement | null>(null);
  const isCurrent = useCallback(
    (token: number) => generation.current === token,
    [],
  );
  const monthRef = useRef(month);
  const isFenceCurrent = useCallback(
    (fence: MutationFence) =>
      monthRef.current === fence.month && isCurrent(fence.generation),
    [isCurrent],
  );
  const selectMonth = useCallback((nextMonth: string) => {
    if (busy) return;
    monthRef.current = nextMonth;
    setPreflight((current) =>
      current?.month === nextMonth ? current : undefined,
    );
    setActionError(undefined);
    setMonth(nextMonth);
  }, [busy]);

  const load = useCallback(async () => {
    if (!capabilities.canRead) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const token = ++generation.current;
    const requestedMonth = month;
    const requestedSubstitutionWindow = substitutionWindow;
    setExceptions({ s: "loading" });
    setSubstitutions({ s: "loading" });
    setCloses({ s: "loading" });
    setWeek52({ s: "loading" });
    setRecords({ s: "loading" });
    const guard =
      <T,>(apply: (value: Res<T>) => void) =>
      (settled: PromiseSettledResult<T>) => {
        if (
          !isCurrent(token) ||
          monthRef.current !== requestedMonth ||
          controller.signal.aborted
        )
          return;
        if (settled.status === "fulfilled")
          apply({ s: "ready", data: settled.value });
        else apply(resolveError(settled.reason));
      };
    const [ex, subs, close, w52, recs] = await Promise.allSettled([
      transport.listExceptions(
        { month: requestedMonth, limit: 200 },
        controller.signal,
      ),
      transport.listSubstitutions(
        requestedSubstitutionWindow,
        controller.signal,
      ),
      transport.listCloses(requestedMonth, controller.signal),
      transport.listWeek52(currentWeek, controller.signal),
      transport.listAttendanceRecords(200, controller.signal),
    ]);
    guard<Page<AttendanceException>>(setExceptions)(ex);
    guard<Page<Substitution>>(setSubstitutions)(subs);
    guard<MonthCloseBoard>(setCloses)(close);
    guard<Week52Board>(setWeek52)(w52);
    guard<{ items: EmployeeAttendanceRecord[] }>(setRecords)(recs);
  }, [
    transport,
    capabilities.canRead,
    currentWeek,
    isCurrent,
    month,
    substitutionWindow,
  ]);

  useEffect(() => {
    generation.current += 1;
    operation.current?.abort();
    const start = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(start);
      operation.current?.abort();
    };
  }, [load, sessionKey]);

  useEffect(() => {
    storageSet("attendance:view", view);
  }, [view]);
  useEffect(() => {
    storageSet("attendance:month", month);
  }, [month]);

  const mutate = useCallback(
    async (
      work: (signal: AbortSignal, fence: MutationFence) => Promise<void>,
    ) => {
      const controller = new AbortController();
      const fence = {
        generation: generation.current,
        month: monthRef.current,
      };
      setBusy(true);
      setActionError(undefined);
      try {
        await work(controller.signal, fence);
        return isFenceCurrent(fence);
      } catch (cause) {
        if (isFenceCurrent(fence) && !controller.signal.aborted) {
          setActionError(
            cause instanceof Error ? cause.message : text.actionError,
          );
        }
        return false;
      } finally {
        if (isFenceCurrent(fence)) setBusy(false);
      }
    },
    [isFenceCurrent],
  );

  const replaceException = useCallback((next: AttendanceException) => {
    setExceptions((current) =>
      current.s === "ready"
        ? {
            s: "ready",
            data: {
              ...current.data,
              items: current.data.items.map((item) =>
                item.id === next.id ? next : item,
              ),
            },
          }
        : current,
    );
  }, []);

  const refreshCloses = useCallback(
    async (targetMonth: string, token: number) => {
      try {
        const board = await transport.listCloses(targetMonth);
        if (isFenceCurrent({ month: targetMonth, generation: token })) {
          setCloses({ s: "ready", data: board });
        }
      } catch (cause) {
        if (isFenceCurrent({ month: targetMonth, generation: token })) {
          setCloses(resolveError(cause));
        }
      }
    },
    [transport, isFenceCurrent],
  );

  const exceptionItems = exceptions.s === "ready" ? exceptions.data.items : [];
  const substitutionItems =
    substitutions.s === "ready" ? substitutions.data.items : [];
  const recordItems = records.s === "ready" ? records.data.items : [];

  if (!capabilities.canRead) {
    return null;
  }

  const openExceptionCount = exceptionItems.filter(
    (item) => item.status === "OPEN",
  ).length;
  const closeItems = closes.s === "ready" ? closes.data.items : [];
  const closedMonth = amendClose?.close;
  const closedCount = closeItems.filter((item) => item.closed).length;
  const allClosed = closeItems.length > 0 && closedCount === closeItems.length;
  const week52Items = week52.s === "ready" ? week52.data.items : [];
  const w52AtRisk = week52Items.filter((row) => row.tone !== "OK").length;
  const coverRows = coverPlanRows(exceptionItems, substitutionItems);
  const uncovered = coverRows.filter((row) => !row.assigned).length;

  const firstOpenException = exceptionItems.find(
    (item) => item.status === "OPEN",
  );
  const focusCard = (ref: { current: HTMLElement | null }) => {
    ref.current?.scrollIntoView({ block: "nearest" });
    ref.current?.focus();
  };

  return (
    <section className="attendance" aria-label="근태 운영" aria-busy={busy}>
      <div className="attendance__header">
        <div>
          <h2>근태 운영</h2>
          <div className="attendance__headmeta">
            <span>
              {today} · {text.header.liveSuffix}
            </span>
            {closes.s === "ready" && (
              <span
                className={
                  allClosed
                    ? "attendance__chip attendance__chip--ok"
                    : "attendance__chip attendance__chip--warn"
                }
              >
                {text.nf.monthShort(month)}{" "}
                {allClosed ? text.header.closeDone : text.header.closeOpen}
              </span>
            )}
          </div>
        </div>
        <div className="attendance__spacer" />
        <div className="attendance__popwrap">
          <button
            type="button"
            className="attendance__toolbtn"
            aria-expanded={coverOpen}
            onClick={() => {
              setCoverOpen((open) => !open);
            }}
          >
            <span>{text.cover.title}</span>
            <span
              className={
                uncovered > 0
                  ? "attendance__badge attendance__badge--hot"
                  : "attendance__badge"
              }
            >
              {uncovered}
            </span>
          </button>
          {coverOpen && (
            <div
              className="attendance__popover"
              role="dialog"
              aria-label={text.cover.title}
            >
              <div className="attendance__pophead">
                <span>{text.cover.title}</span>
                <span className="attendance__count">{text.cover.window}</span>
              </div>
              {coverRows.length === 0 ? (
                <div className="attendance__popempty">{text.cover.empty}</div>
              ) : (
                coverRows.map((row) => (
                  <div key={row.key} className="attendance__poprow">
                    <a className="attendance__who" href={PEOPLE_HREF}>
                      {row.who}
                    </a>
                    {row.team != null && (
                      <span className="attendance__chip">{row.team}</span>
                    )}
                    <span className="attendance__exdetail">
                      {row.date} · {row.detail}
                    </span>
                    <span className="attendance__spacer" />
                    <span
                      className={
                        row.assigned
                          ? "attendance__chip attendance__chip--ok"
                          : "attendance__chip attendance__chip--danger"
                      }
                    >
                      {row.assigned
                        ? text.cover.assigned
                        : text.cover.unassigned}
                    </span>
                    {!row.assigned &&
                      capabilities.canSubstitute &&
                      row.exception && (
                        <button
                          type="button"
                          className="attendance__ghostbtn"
                          onClick={() => {
                            setCoverOpen(false);
                            setSubGap(row.exception);
                          }}
                        >
                          {text.cover.assignCta}
                        </button>
                      )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className={
            view === "month"
              ? "attendance__toolbtn attendance__toolbtn--active"
              : "attendance__toolbtn"
          }
          onClick={() => {
            setView(view === "month" ? "day" : "month");
          }}
        >
          {text.header.monthSheet}
        </button>
      </div>

      <div className="attendance__stats">
        <button
          type="button"
          className="attendance__stat"
          onClick={() => {
            setView("day");
            focusCard(boardRef);
          }}
        >
          <span className="attendance__statlabel">{text.stats.checkedIn}</span>
          <span className="attendance__statvalue">
            {records.s === "ready" ? checkedInCount(recordItems, today) : "—"}
          </span>
        </button>
        <button
          type="button"
          className="attendance__stat"
          onClick={() => {
            focusCard(exceptionsRef);
          }}
        >
          <span className="attendance__statlabel">{text.stats.lateAbsent}</span>
          <span
            className={
              openExceptionCount > 0
                ? "attendance__statvalue attendance__statvalue--danger"
                : "attendance__statvalue"
            }
          >
            {exceptions.s === "ready"
              ? `${String(exceptionItems.filter((i) => i.kind === "LATE" && i.status === "OPEN").length)} · ${String(exceptionItems.filter((i) => i.kind === "NO_SHOW" && i.status === "OPEN").length)}`
              : "—"}
          </span>
        </button>
        <button
          type="button"
          className="attendance__stat"
          onClick={() => {
            focusCard(w52Ref);
          }}
        >
          <span className="attendance__statlabel">{text.stats.w52}</span>
          <span
            className={
              w52AtRisk > 0
                ? "attendance__statvalue attendance__statvalue--warn"
                : "attendance__statvalue"
            }
          >
            {week52.s === "ready" ? w52AtRisk : "—"}
          </span>
        </button>
        <button
          type="button"
          className="attendance__stat"
          onClick={() => {
            focusCard(closeRef);
          }}
        >
          <span className="attendance__statlabel">
            {text.nf.monthShort(month)} {text.stats.close}
          </span>
          <span className="attendance__statvalue">
            {closes.s === "ready"
              ? text.nf.closeRatio(closedCount, closeItems.length)
              : "—"}
          </span>
        </button>
      </div>

      {actionError !== undefined && (
        <div className="attendance__alert" role="alert">
          <span>{actionError}</span>
          <button
            type="button"
            className="attendance__ghostbtn"
            onClick={() => {
              setActionError(undefined);
              void load();
            }}
          >
            {text.retry}
          </button>
        </div>
      )}

      <div className="attendance__zones">
        <section
          className="attendance__card"
          aria-label={text.board.title}
          ref={boardRef}
          tabIndex={-1}
        >
          <div className="attendance__cardhead">
            <span className="attendance__cardtitle">{text.board.title}</span>
            <div
              className="attendance__seg"
              role="group"
              aria-label={text.board.title}
            >
              <button
                type="button"
                className={
                  view === "day"
                    ? "attendance__segbtn attendance__segbtn--on"
                    : "attendance__segbtn"
                }
                aria-pressed={view === "day"}
                onClick={() => {
                  setView("day");
                }}
              >
                {text.board.day}
              </button>
              <button
                type="button"
                className={
                  view === "month"
                    ? "attendance__segbtn attendance__segbtn--on"
                    : "attendance__segbtn"
                }
                aria-pressed={view === "month"}
                onClick={() => {
                  setView("month");
                }}
              >
                {text.board.month}
              </button>
            </div>
            {view === "month" && (
              <div className="attendance__monthnav">
                <button
                  type="button"
                  aria-label={text.board.prevMonth}
                  disabled={busy}
                  onClick={() => {
                    selectMonth(shiftMonth(month, -1));
                  }}
                >
                  {"<"}
                </button>
                <span className="attendance__monthlabel">
                  {text.nf.monthLabel(month)}
                </span>
                <button
                  type="button"
                  aria-label={text.board.nextMonth}
                  disabled={busy}
                  onClick={() => {
                    selectMonth(shiftMonth(month, 1));
                  }}
                >
                  {">"}
                </button>
              </div>
            )}
          </div>
          {view === "day" ? (
            <DayBoard
              records={records}
              exceptions={exceptions}
              substitutions={substitutionItems}
              today={today}
              nowMin={nowMin}
              canSubstitute={capabilities.canSubstitute}
              recordItems={recordItems}
              onAssign={setSubGap}
              onCancel={setCancelSub}
              onRetry={() => void load()}
            />
          ) : (
            <MonthBoard
              exceptions={exceptions}
              substitutions={substitutionItems}
              month={month}
              today={today}
              onDrill={(employeeId) => {
                setEmployeeFilter(employeeId);
                focusCard(exceptionsRef);
              }}
              onRetry={() => void load()}
            />
          )}
        </section>

        <div className="attendance__side">
          <section
            className="attendance__card"
            aria-label={text.w52.title}
            ref={w52Ref}
            tabIndex={-1}
          >
            <div className="attendance__cardhead">
              <span className="attendance__cardtitle">{text.w52.title}</span>
              <span className="attendance__count">{currentWeek}</span>
              <span className="attendance__spacer" />
              <span className="attendance__hint">{text.w52.limitLegend}</span>
            </div>
            <PanelBody
              res={week52}
              empty={text.w52.empty}
              isEmpty={(data) => data.items.length === 0}
              onRetry={() => void load()}
            >
              {(data) => (
                <div className="attendance__sidelist">
                  {data.items.map((row) => (
                    <W52RowView
                      key={row.employee_id}
                      row={row}
                      canAck={capabilities.canAckW52}
                      busy={busy}
                      onAck={() =>
                        void mutate(async (signal, fence) => {
                          const next = await transport.ackWeek52(
                            row.employee_id,
                            row.week_start,
                            signal,
                          );
                          if (!isFenceCurrent(fence)) return;
                          setWeek52((current) =>
                            current.s === "ready"
                              ? {
                                  s: "ready",
                                  data: {
                                    ...current.data,
                                    items: current.data.items.map((item) =>
                                      item.employee_id === next.employee_id
                                        ? next
                                        : item,
                                    ),
                                  },
                                }
                              : current,
                          );
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </PanelBody>
          </section>

          <section
            className="attendance__card"
            aria-label={text.exceptions.title}
            ref={exceptionsRef}
            tabIndex={-1}
          >
            <div className="attendance__cardhead">
              <span className="attendance__dot" />
              <span className="attendance__cardtitle">
                {text.exceptions.title}
              </span>
              <span className="attendance__count">{openExceptionCount}</span>
              <span className="attendance__spacer" />
              <span className="attendance__hint">{text.exceptions.hint}</span>
              {capabilities.canRaise && (
                <button type="button" className="attendance__actionbtn" disabled={busy} onClick={() => { setRaiseOpen(true); }}>
                  {text.actions.raise}
                </button>
              )}
            </div>
            {employeeFilter !== undefined && (
              <div className="attendance__cardhead">
                <span className="attendance__chip attendance__chip--accent">
                  {exceptionItems.find(
                    (item) => item.employee_id === employeeFilter,
                  )?.employee_name ?? employeeFilter}
                </span>
                <button
                  type="button"
                  className="attendance__ghostbtn"
                  onClick={() => {
                    setEmployeeFilter(undefined);
                  }}
                >
                  {text.exceptions.filterClear}
                </button>
              </div>
            )}
            <PanelBody
              res={exceptions}
              empty={text.empty}
              isEmpty={(data) => data.items.length === 0}
              onRetry={() => void load()}
            >
              {(data) => (
                <div className="attendance__sidelist">
                  {sortExceptions(data.items, employeeFilter).map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={
                        item.status === "RESOLVED"
                          ? "attendance__exrow attendance__exrow--resolved"
                          : "attendance__exrow"
                      }
                      onClick={() => {
                        setExOpen(item);
                      }}
                    >
                      <span className={exceptionToneClass(item.kind)}>
                        {text.exceptions.kind[item.kind]}
                      </span>
                      <span className="attendance__exbody">
                        <span className="attendance__who">
                          {item.employee_name}
                        </span>
                        <span className="attendance__exdetail">
                          {item.work_date} · {item.detail}
                        </span>
                      </span>
                      {item.status === "RESOLVED" ? (
                        <span className="attendance__chip attendance__chip--ok">
                          {text.exceptions.resolved}
                        </span>
                      ) : (
                        <span className="attendance__chip attendance__chip--warn">
                          {text.exceptions.open}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </PanelBody>
          </section>

          <section
            className="attendance__card"
            aria-label={text.closePanel.title}
            ref={closeRef}
            tabIndex={-1}
          >
            <div className="attendance__cardhead">
              <span className="attendance__cardtitle">
                {text.nf.monthShort(month)} {text.closePanel.title}
              </span>
              <span
                className={
                  allClosed
                    ? "attendance__chip attendance__chip--ok"
                    : "attendance__chip attendance__chip--warn"
                }
              >
                {allClosed
                  ? text.closePanel.doneChip
                  : text.closePanel.deadlineChip}
              </span>
            </div>
            <PanelBody
              res={closes}
              empty={text.empty}
              isEmpty={(data) => data.items.length === 0}
              onRetry={() => void load()}
            >
              {(data) => (
                <>
                  <div className="attendance__sidelist">
                    {data.items.map((item) => (
                      <CloseRowView key={item.branch_scope} item={item} canAmend={capabilities.canClose} busy={busy} onAmend={setAmendClose} />
                    ))}
                  </div>
                  <div className="attendance__closefoot">
                    <CloseCta
                      items={data.items}
                      canClose={capabilities.canClose}
                      busy={busy}
                      openExceptions={openExceptionCount}
                      firstOpenException={firstOpenException}
                      onFix={(exception) => {
                        setExOpen(exception);
                      }}
                      onConfirm={(scope) =>
                        void mutate(async (signal, fence) => {
                          const requestedMonth = fence.month;
                          const requestedGeneration = fence.generation;
                          const result = await transport.preflightClose(
                            requestedMonth,
                            scope,
                            signal,
                          );
                          if (
                            isFenceCurrent({
                              month: requestedMonth,
                              generation: requestedGeneration,
                            })
                          ) {
                            setPreflight({
                              data: result,
                              scope,
                              month: requestedMonth,
                              generation: requestedGeneration,
                            });
                          }
                        })
                      }
                    />
                    <span className="attendance__footnote">
                      {text.closePanel.retroNote}
                    </span>
                  </div>
                </>
              )}
            </PanelBody>
          </section>
        </div>
      </div>

      {exOpen && (
        <ExceptionModal
          exception={exOpen}
          canResolve={capabilities.canResolve}
          busy={busy}
          onClose={() => {
            setExOpen(undefined);
          }}
          onResolve={(input) =>
            void mutate(async (signal, fence) => {
              const next = await transport.resolveException(
                exOpen.id,
                input,
                signal,
              );
              if (!isFenceCurrent(fence)) return;
              replaceException(next);
              storageSet(`attendance:exdraft:${exOpen.id}`, undefined);
              setExOpen(undefined);
              await refreshCloses(fence.month, fence.generation);
            })
          }
        />
      )}

      {subGap && (
        <SubstitutionCandidateDialog
          gap={subGap}
          transport={transport}
          busy={busy}
          onClose={() => {
            setSubGap(undefined);
          }}
          onAssign={(input) =>
            void mutate(async (signal, fence) => {
              await transport.createSubstitution(input, signal);
              if (!isFenceCurrent(fence)) return;
              setSubGap(undefined);
              const [subs, ex] = await Promise.all([
                transport.listSubstitutions(monthOperationalRange(fence.month)),
                transport.listExceptions({ month: fence.month, limit: 200 }),
              ]);
              if (!isFenceCurrent(fence)) return;
              setSubstitutions({ s: "ready", data: subs });
              setExceptions({ s: "ready", data: ex });
            })
          }
        />
      )}

      {raiseOpen && (
        <RaiseExceptionModal busy={busy} onClose={() => { setRaiseOpen(false); }} onSubmit={(input) =>
          void mutate(async (signal, fence) => {
            const next = await transport.createException(input, signal);
            if (!isFenceCurrent(fence)) return;
            setExceptions((current) => current.s === "ready" ? { s: "ready", data: { ...current.data, items: [next, ...current.data.items], total: current.data.total + 1 } } : current);
            setRaiseOpen(false);
            await refreshCloses(fence.month, fence.generation);
          })}
        />
      )}

      {cancelSub && (
        <CancelSubstitutionModal substitution={cancelSub} busy={busy} onClose={() => { setCancelSub(undefined); }} onSubmit={(reason) =>
          void mutate(async (signal, fence) => {
            const next = await transport.cancelSubstitution(cancelSub.id, reason, signal);
            if (!isFenceCurrent(fence)) return;
            setSubstitutions((current) => current.s === "ready" ? { s: "ready", data: { ...current.data, items: current.data.items.map((item) => item.id === next.id ? next : item) } } : current);
            setCancelSub(undefined);
          })}
        />
      )}

      {closedMonth && (
        <CloseAmendmentModal close={closedMonth} busy={busy} onClose={() => { setAmendClose(undefined); }} onSubmit={(input) =>
          void mutate(async (signal, fence) => {
            await transport.addCloseAmendment(closedMonth.id, input, signal);
            if (!isFenceCurrent(fence)) return;
            setAmendClose(undefined);
            await refreshCloses(fence.month, fence.generation);
          })}
        />
      )}

      {preflight && (
        <PreflightModal
          preflight={preflight.data}
          scope={preflight.scope}
          month={preflight.month}
          busy={busy}
          onClose={() => {
            setPreflight(undefined);
          }}
          onConfirm={() =>
            void mutate(async (signal) => {
              const preflightMonth = preflight.month;
              const preflightGeneration = preflight.generation;
              try {
                await transport.confirmClose(
                  preflightMonth,
                  preflight.scope,
                  signal,
                );
                if (
                  isFenceCurrent({
                    month: preflightMonth,
                    generation: preflightGeneration,
                  })
                ) {
                  setPreflight(undefined);
                }
              } finally {
                await refreshCloses(preflightMonth, preflightGeneration);
              }
            })
          }
        />
      )}
    </section>
  );
}

function shiftMonth(month: string, delta: number): string {
  const [year, monthIndex] = month.split("-").map(Number);
  if (!year || !monthIndex) return month;
  const total = year * 12 + (monthIndex - 1) + delta;
  return `${String(Math.floor(total / 12))}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function sortExceptions(
  items: AttendanceException[],
  employeeFilter: string | undefined,
): AttendanceException[] {
  const scoped = employeeFilter
    ? items.filter((item) => item.employee_id === employeeFilter)
    : items;
  return [...scoped].sort((a, b) => {
    if (a.status !== b.status) return a.status === "OPEN" ? -1 : 1;
    return b.work_date.localeCompare(a.work_date);
  });
}

function PanelBody<T>({
  res,
  empty,
  isEmpty,
  onRetry,
  children,
}: {
  res: Res<T>;
  empty: string;
  isEmpty: (data: T) => boolean;
  onRetry: () => void;
  children: (data: T) => ReactElement;
}) {
  if (res.s === "loading") {
    return (
      <p role="status" className="attendance__status">
        {text.loading}
      </p>
    );
  }
  if (res.s === "denied") {
    return (
      <p role="status" className="attendance__status">
        {text.panelDenied}
      </p>
    );
  }
  if (res.s === "error") {
    return (
      <div className="attendance__alert" role="alert">
        <span>{res.message}</span>
        <button
          type="button"
          className="attendance__ghostbtn"
          onClick={onRetry}
        >
          {text.retry}
        </button>
      </div>
    );
  }
  if (isEmpty(res.data)) {
    return (
      <p role="status" className="attendance__status">
        {empty}
      </p>
    );
  }
  return children(res.data);
}

const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

function DayBoard({
  records,
  exceptions,
  substitutions,
  today,
  nowMin,
  canSubstitute,
  recordItems,
  onAssign,
  onCancel,
  onRetry,
}: {
  records: Res<{ items: EmployeeAttendanceRecord[] }>;
  exceptions: Res<Page<AttendanceException>>;
  substitutions: Substitution[];
  today: string;
  nowMin: number;
  canSubstitute: boolean;
  recordItems: EmployeeAttendanceRecord[];
  onAssign: (exception: AttendanceException) => void;
  onCancel: (substitution: Substitution) => void;
  onRetry: () => void;
}) {
  const exceptionItems = exceptions.s === "ready" ? exceptions.data.items : [];
  if (records.s !== "ready") {
    return (
      <PanelBody
        res={records}
        empty={text.board.dayEmpty}
        isEmpty={() => false}
        onRetry={onRetry}
      >
        {() => <></>}
      </PanelBody>
    );
  }
  const rows = dayBoardRows(
    recordItems,
    exceptionItems,
    substitutions,
    today,
    nowMin,
  );
  if (rows.length === 0) {
    return (
      <p role="status" className="attendance__status">
        {text.board.dayEmpty}
      </p>
    );
  }
  return (
    <>
      <div className="attendance__rows">
        <div className="attendance__ticks">
          <span className="attendance__colhead">{text.board.colWorker}</span>
          <span className="attendance__tickscale">
            {TICKS.map((hour) => (
              <span
                key={hour}
                className="attendance__tick"
                style={{ left: pct(hour * 60) }}
              >
                {String(hour).padStart(2, "0")}
              </span>
            ))}
          </span>
        </div>
        {rows.map((row) => {
          if (row.type === "employee") {
            return (
              <DayRowView
                key={`emp-${row.employeeId}`}
                row={row}
                nowMin={nowMin}
              />
            );
          }
          if (row.type === "sub") {
            return (
              <div key={`sub-${row.sub.id}`} className="attendance__dayrow">
                <span>
                  <span className="attendance__who">{row.sub.worker_name}</span>
                  <span className="attendance__rowchips">
                    <span className="attendance__chip attendance__chip--accent">
                      {text.board.subFillIn}
                    </span>
                    <span className="attendance__chip">
                      {row.sub.site} · {row.sub.role}
                    </span>
                    <span className="attendance__chip">
                      {formatWindow(row.sub.from_minutes, row.sub.to_minutes)}
                    </span>
                    {canSubstitute && row.sub.status === "ASSIGNED" && (
                      <button type="button" className="attendance__subcta" onClick={() => { onCancel(row.sub); }}>
                        {text.actions.cancelSubstitution}
                      </button>
                    )}
                  </span>
                </span>
                <span className="attendance__track">
                  <span
                    className="attendance__nowline"
                    style={{ left: pct(nowMin) }}
                  />
                  <span className="attendance__lane">
                    <span
                      className="attendance__segment attendance__segment--work"
                      style={{
                        left: pct(row.sub.from_minutes),
                        width: pct(row.sub.to_minutes - row.sub.from_minutes),
                      }}
                    />
                  </span>
                </span>
              </div>
            );
          }
          return (
            <div key={`gap-${row.exception.id}`} className="attendance__dayrow">
              <span>
                <a className="attendance__who" href={PEOPLE_HREF}>
                  {row.exception.employee_name}
                </a>
                <span className="attendance__rowchips">
                  <span className="attendance__chip attendance__chip--danger">
                    {text.exceptions.kind[row.exception.kind]}
                  </span>
                  {canSubstitute && (
                    <button
                      type="button"
                      className="attendance__subcta"
                      onClick={() => {
                        onAssign(row.exception);
                      }}
                    >
                      {text.board.assignSub}
                    </button>
                  )}
                </span>
              </span>
              <span className="attendance__track">
                <span
                  className="attendance__nowline"
                  style={{ left: pct(nowMin) }}
                />
              </span>
            </div>
          );
        })}
      </div>
      <div className="attendance__legend">
        <span>
          <span
            className="attendance__swatch"
            style={{ background: "var(--teal)" }}
          />
          {text.board.legendWork}
        </span>
        <span>
          <span
            className="attendance__swatch"
            style={{
              background: "var(--info-bg)",
              border: "1px solid var(--info-bd)",
            }}
          />
          {text.board.legendAway}
        </span>
        <span>
          <span
            className="attendance__swatch"
            style={{ background: "var(--warn-solid)" }}
          />
          {text.board.legendLate}
        </span>
        <span>
          <span
            className="attendance__swatch"
            style={{ background: "var(--danger-solid)" }}
          />
          {text.board.legendAbsent}
        </span>
        <span className="attendance__spacer" />
        <span>
          <span
            className="attendance__swatch"
            style={{ background: "var(--danger-solid)", width: 2, height: 11 }}
          />
          {text.board.now}
        </span>
      </div>
    </>
  );
}

function DayRowView({ row, nowMin }: { row: EmployeeDayRow; nowMin: number }) {
  return (
    <div className="attendance__dayrow">
      <span>
        <a className="attendance__who" href={PEOPLE_HREF}>
          {row.name}
        </a>
        <span className="attendance__rowchips">
          {row.segments.some((segment) => segment.open) && (
            <span className="attendance__chip attendance__chip--ok">
              {text.board.workingBadge}
            </span>
          )}
          {row.exceptions.map((exception) => (
            <span
              key={exception.id}
              className={
                exception.kind === "NO_SHOW"
                  ? "attendance__chip attendance__chip--danger"
                  : exception.kind === "UNAPPROVED_OVERTIME"
                    ? "attendance__chip attendance__chip--info"
                    : "attendance__chip attendance__chip--warn"
              }
            >
              {text.exceptions.kind[exception.kind]}
            </span>
          ))}
          {row.cover && (
            <span className="attendance__chip attendance__chip--accent">
              {text.board.coveredBy} → {row.cover.worker_name}
            </span>
          )}
        </span>
      </span>
      <span className="attendance__track">
        <span className="attendance__nowline" style={{ left: pct(nowMin) }} />
        <span className="attendance__lane">
          {row.segments.map((segment) => (
            <span
              key={`${segment.kind}-${String(segment.fromMin)}`}
              className={
                segment.kind === "work"
                  ? "attendance__segment attendance__segment--work"
                  : "attendance__segment attendance__segment--away"
              }
              style={{
                left: pct(segment.fromMin),
                width: pct(segment.toMin - segment.fromMin),
              }}
            />
          ))}
        </span>
      </span>
    </div>
  );
}

function MonthBoard({
  exceptions,
  substitutions,
  month,
  today,
  onDrill,
  onRetry,
}: {
  exceptions: Res<Page<AttendanceException>>;
  substitutions: Substitution[];
  month: string;
  today: string;
  onDrill: (employeeId: string) => void;
  onRetry: () => void;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const moveFocus = (delta: number) => {
    const grid = gridRef.current;
    if (!grid) return;
    const rows = [
      ...grid.querySelectorAll<HTMLButtonElement>(".attendance__monthrow"),
    ];
    const index = rows.findIndex((row) => row === document.activeElement);
    const next = rows.at(
      index < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, index + delta)),
    );
    next?.focus();
  };
  return (
    <PanelBody
      res={exceptions}
      empty={text.board.monthEmpty}
      isEmpty={(data) =>
        monthSheetRows(data.items, substitutions, month, today).length === 0
      }
      onRetry={onRetry}
    >
      {(data) => {
        const rows = monthSheetRows(data.items, substitutions, month, today);
        const totals = rows.reduce(
          (sum, row) => ({
            late: sum.late + row.late,
            absent: sum.absent + row.absent,
            ot: sum.ot + row.otHours,
          }),
          { late: 0, absent: 0, ot: 0 },
        );
        return (
          <>
            <div
              className="attendance__monthgrid"
              ref={gridRef}
              onKeyDown={(event) => {
                if (event.key === "j" || event.key === "ArrowDown") {
                  event.preventDefault();
                  moveFocus(1);
                } else if (event.key === "k" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveFocus(-1);
                }
              }}
            >
              <div className="attendance__monthhead">
                <span>{text.board.monthColUnit}</span>
                <span className="attendance__num">
                  {text.board.monthColLate}
                </span>
                <span className="attendance__num">
                  {text.board.monthColAbsent}
                </span>
                <span className="attendance__num">{text.board.monthColOt}</span>
                <span>{text.board.monthColDays}</span>
              </div>
              <div className="attendance__monthrow attendance__monthrow--summary">
                <span>{text.board.monthSummary}</span>
                <span className="attendance__num attendance__num--warn">
                  {totals.late}
                </span>
                <span className="attendance__num attendance__num--danger">
                  {totals.absent}
                </span>
                <span className="attendance__num">
                  {text.nf.hours(totals.ot)}
                </span>
                <span />
              </div>
              {rows.map((row) => (
                <button
                  type="button"
                  key={row.employeeId}
                  className="attendance__monthrow"
                  onClick={() => {
                    onDrill(row.employeeId);
                  }}
                >
                  <span>
                    <span className="attendance__who">{row.name}</span>
                    {row.team != null && (
                      <span className="attendance__w52team">{row.team}</span>
                    )}
                  </span>
                  <span
                    className={
                      row.late > 0
                        ? "attendance__num attendance__num--warn"
                        : "attendance__num"
                    }
                  >
                    {row.late}
                  </span>
                  <span
                    className={
                      row.absent > 0
                        ? "attendance__num attendance__num--danger"
                        : "attendance__num"
                    }
                  >
                    {row.absent}
                  </span>
                  <span className="attendance__num">
                    {text.nf.hours(row.otHours)}
                  </span>
                  <span className="attendance__strip">
                    {row.cells.map((cell) => (
                      <span
                        key={cell.day}
                        title={`${month}-${String(cell.day).padStart(2, "0")}`}
                        className={
                          cell.kind === "late"
                            ? "attendance__cell attendance__cell--late"
                            : cell.kind === "absent"
                              ? "attendance__cell attendance__cell--absent"
                              : cell.kind === "covered"
                                ? "attendance__cell attendance__cell--covered"
                                : cell.kind === "ot"
                                  ? "attendance__cell attendance__cell--ot"
                                  : cell.kind === "holiday"
                                    ? "attendance__cell attendance__cell--holiday"
                                    : cell.kind === "future"
                                      ? "attendance__cell attendance__cell--future"
                                      : "attendance__cell"
                        }
                      >
                        {cell.kind === "covered" && (
                          <span className="attendance__celldot" />
                        )}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
            <div className="attendance__legend">
              <span>
                <span
                  className="attendance__swatch"
                  style={{ background: "var(--warn-solid)" }}
                />
                {text.board.legendLate}
              </span>
              <span>
                <span
                  className="attendance__swatch"
                  style={{ background: "var(--danger-solid)" }}
                />
                {text.board.legendAbsent}
              </span>
              <span>
                <span
                  className="attendance__swatch"
                  style={{ background: "var(--teal)" }}
                />
                {text.board.legendOvertime}
              </span>
              <span>
                <span
                  className="attendance__swatch"
                  style={{
                    background: "var(--danger-solid)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span className="attendance__celldot" />
                </span>
                {text.board.legendCovered}
              </span>
              <span>
                <span
                  className="attendance__swatch"
                  style={{ background: "var(--muted)" }}
                />
                {text.board.legendHoliday}
              </span>
              <span>
                <span
                  className="attendance__swatch"
                  style={{
                    background: "transparent",
                    border: "1px solid var(--border)",
                  }}
                />
                {text.board.legendFuture}
              </span>
              <span className="attendance__spacer" />
              <span>{text.board.monthBasis}</span>
            </div>
          </>
        );
      }}
    </PanelBody>
  );
}

function W52RowView({
  row,
  canAck,
  busy,
  onAck,
}: {
  row: Week52Row;
  canAck: boolean;
  busy: boolean;
  onAck: () => void;
}) {
  const fillClass =
    row.tone === "DANGER"
      ? "attendance__w52fill attendance__w52fill--danger"
      : row.tone === "WARN"
        ? "attendance__w52fill attendance__w52fill--warn"
        : "attendance__w52fill attendance__w52fill--ok";
  const projClass =
    row.tone === "DANGER"
      ? "attendance__w52proj attendance__w52proj--danger"
      : row.tone === "WARN"
        ? "attendance__w52proj attendance__w52proj--warn"
        : "attendance__w52proj";
  return (
    <div className="attendance__w52row">
      <span className="attendance__w52who">
        <a className="attendance__who" href={PEOPLE_HREF}>
          {row.name}
        </a>
        {row.team != null && (
          <span className="attendance__w52team">{row.team}</span>
        )}
      </span>
      <span className="attendance__w52bar">
        <span
          className={fillClass}
          style={{
            width: `${String(Math.min(100, (row.current_hours / 52) * 100))}%`,
          }}
        />
        <span className="attendance__w52limit" />
      </span>
      <span className="attendance__w52hours">
        <span className="attendance__w52cur">
          {text.nf.hours(row.current_hours)}
        </span>
        <span className={projClass}>
          {text.w52.projectedPrefix} {text.nf.hours(row.projected_hours)}
        </span>
      </span>
      {row.acked ? (
        <span className="attendance__chip attendance__chip--ok">
          {text.w52.requested}
        </span>
      ) : row.tone === "DANGER" && canAck ? (
        <button
          type="button"
          className="attendance__actionbtn"
          disabled={busy}
          onClick={onAck}
        >
          {text.w52.adjust}
        </button>
      ) : (
        <span className="attendance__hint">—</span>
      )}
    </div>
  );
}

function CloseRowView({ item, canAmend, busy, onAmend }: { item: MonthCloseItem; canAmend: boolean; busy: boolean; onAmend: (item: MonthCloseItem) => void; }) {
  return (
    <div className="attendance__closerow">
      {item.closed ? <span className="attendance__okmark" aria-hidden>✓</span> : <span className="attendance__waitdot" aria-hidden />}
      <span className="attendance__closescope">{item.branch_scope}</span>
      {item.closed && item.close ? (
        <>
          <span className="attendance__closemeta">{timeLabel(item.close.closed_at)} · {item.close.attested_by}</span>
          {canAmend && <button type="button" className="attendance__ghostbtn" disabled={busy} onClick={() => { onAmend(item); }}>{text.actions.amend}</button>}
        </>
      ) : (
        <span className="attendance__closemeta attendance__closemeta--warn">
          {text.closePanel.openExceptions} {item.open_exceptions}{text.closePanel.countUnit}
          {item.pending_leave > 0 && <> {" · "}<a href={LEAVE_HREF}>{text.closePanel.pendingLeave} {item.pending_leave}{text.closePanel.countUnit}</a></>}
        </span>
      )}
    </div>
  );
}

function CloseCta({
  items,
  canClose,
  busy,
  openExceptions,
  firstOpenException,
  onFix,
  onConfirm,
}: {
  items: MonthCloseItem[];
  canClose: boolean;
  busy: boolean;
  openExceptions: number;
  firstOpenException: AttendanceException | undefined;
  onFix: (exception: AttendanceException) => void;
  onConfirm: (scope: string) => void;
}) {
  const open = items.find((item) => !item.closed);
  if (!open) {
    return (
      <div className="attendance__donebanner">
        <span className="attendance__spacer">{text.closePanel.doneBanner}</span>
        <a href={LABORCOST_HREF}>{text.closePanel.goPayroll}</a>
      </div>
    );
  }
  if (!canClose) return null;
  if (open.open_exceptions > 0 || openExceptions > 0) {
    return (
      <button
        type="button"
        className="attendance__blockedbtn"
        disabled={!firstOpenException}
        onClick={() => {
          if (firstOpenException) onFix(firstOpenException);
        }}
      >
        {text.closePanel.blockedPrefix}{" "}
        {Math.max(open.open_exceptions, openExceptions)}
        {text.closePanel.blockedSuffix}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="attendance__primarybtn"
      disabled={busy}
      onClick={() => {
        onConfirm(open.branch_scope);
      }}
    >
      {open.branch_scope} {text.closePanel.confirmCta}
    </button>
  );
}

function ExceptionModal({
  exception,
  canResolve,
  busy,
  onClose,
  onResolve,
}: {
  exception: AttendanceException;
  canResolve: boolean;
  busy: boolean;
  onClose: () => void;
  onResolve: (input: {
    action: "CONFIRM" | "APPROVE_OVERTIME";
    reason: string;
    linked_work_ref?: string;
    ot_hours?: number;
  }) => void;
}) {
  const draftKey = `attendance:exdraft:${exception.id}`;
  const [reason, setReason] = useState(() => storageGet(draftKey) ?? "");
  const [workRef, setWorkRef] = useState("");
  const [otHours, setOtHours] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const reasonId = useId();
  const workRefId = useId();
  const otHoursId = useId();
  const isOvertime = exception.kind === "UNAPPROVED_OVERTIME";
  const close = () => {
    if (!busy) onClose();
  };
  const submit = () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setFieldError(text.exceptions.reasonRequired);
      return;
    }
    if (isOvertime && !workRef.trim()) {
      setFieldError(text.exceptions.workRefRequired);
      return;
    }
    setFieldError(undefined);
    const hours = Number(otHours);
    onResolve({
      action: isOvertime ? "APPROVE_OVERTIME" : "CONFIRM",
      reason: trimmed,
      ...(isOvertime ? { linked_work_ref: workRef.trim() } : {}),
      ...(isOvertime && otHours && Number.isFinite(hours)
        ? { ot_hours: hours }
        : {}),
    });
  };
  return (
    <Dialog
      open
      onClose={close}
      closeOnScrimClick={!busy}
      label={text.exceptions.detailTitle}
      className="attendance__modal"
    >
        <div className="attendance__modalhead">
          <span className={exceptionToneClass(exception.kind)}>
            {text.exceptions.kind[exception.kind]}
          </span>
          <span className="attendance__count">{exception.code}</span>
          <span className="attendance__modaltitle">
            {exception.employee_name}
          </span>
          <span className="attendance__count">{exception.work_date}</span>
          {exception.status === "RESOLVED" && (
            <span className="attendance__chip attendance__chip--ok">
              {text.exceptions.resolved}
            </span>
          )}
        </div>
        <p className="attendance__exdetail">{exception.detail}</p>
        {exception.evidence.length > 0 && (
          <div
            className="attendance__evlist"
            aria-label={text.exceptions.evidence}
          >
            {exception.evidence.map((item) => (
              <span key={item.name}>
                {item.name}
                {item.size != null ? ` · ${item.size}` : ""}
              </span>
            ))}
          </div>
        )}
        {exception.links.length > 0 && (
          <div
            className="attendance__linkchips"
            aria-label={text.exceptions.links}
          >
            {exception.links.map((link) => (
              <a
                key={`${link.kind}-${link.label}`}
                className="attendance__chip attendance__chipbtn"
                href={linkHref(link.ref)}
              >
                {link.label}
              </a>
            ))}
          </div>
        )}
        {exception.resolution && (
          <p className="attendance__exdetail">
            {exception.resolution.reason} · {exception.resolution.actor} ·{" "}
            {timeLabel(exception.resolution.resolved_at)}
            {exception.resolution.linked_work_ref != null
              ? ` · ${exception.resolution.linked_work_ref}`
              : ""}
          </p>
        )}
        {exception.status === "OPEN" && canResolve && (
          <>
            <label className="attendance__field" htmlFor={reasonId}>
              {text.exceptions.reasonLabel}
              <textarea
                id={reasonId}
                value={reason}
                maxLength={500}
                required
                onChange={(event) => {
                  setReason(event.target.value);
                  storageSet(draftKey, event.target.value);
                }}
              />
            </label>
            {isOvertime && (
              <>
                <label className="attendance__field" htmlFor={workRefId}>
                  {text.exceptions.workRefLabel}
                  <input
                    id={workRefId}
                    value={workRef}
                    required
                    onChange={(event) => {
                      setWorkRef(event.target.value);
                    }}
                  />
                </label>
                <label className="attendance__field" htmlFor={otHoursId}>
                  {text.exceptions.otHoursLabel}
                  <input
                    id={otHoursId}
                    value={otHours}
                    type="number"
                    min="0"
                    step="0.1"
                    onChange={(event) => {
                      setOtHours(event.target.value);
                    }}
                  />
                </label>
              </>
            )}
            {fieldError !== undefined && (
              <span className="attendance__fielderror" role="alert">
                {fieldError}
              </span>
            )}
          </>
        )}
        <div className="attendance__modalactions">
          <button
            type="button"
            className="attendance__ghostbtn"
            disabled={busy}
            onClick={close}
          >
            {text.exceptions.close}
          </button>
          {exception.status === "OPEN" && canResolve && (
            <button
              type="button"
              className="attendance__actionbtn"
              disabled={busy}
              onClick={submit}
            >
              {isOvertime
                ? text.exceptions.resolveOvertime
                : text.exceptions.resolveConfirm}
            </button>
          )}
        </div>
    </Dialog>
  );
}

function PreflightModal({
  preflight,
  scope,
  month,
  busy,
  onClose,
  onConfirm,
}: {
  preflight: ClosePreflight;
  scope: string;
  month: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [attest, setAttest] = useState(false);
  const attestId = useId();
  const hardFail = preflight.checks.some((check) => !check.ok && !check.warn);
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Dialog
      open
      onClose={close}
      closeOnScrimClick={!busy}
      label={text.closePanel.preflightTitle}
      className="attendance__modal"
    >
        <div className="attendance__modalhead">
          <span className="attendance__modaltitle">
            {text.closePanel.preflightTitle}
          </span>
          <span className="attendance__chip">{scope}</span>
          <span className="attendance__count">{month}</span>
        </div>
        {preflight.checks.map((check) => (
          <div key={check.key} className="attendance__checkrow">
            {check.ok ? (
              <span className="attendance__okmark" aria-hidden>
                ✓
              </span>
            ) : (
              <span className="attendance__waitdot" aria-hidden />
            )}
            <span>{check.key}</span>
            <span
              className={
                check.ok
                  ? check.warn
                    ? "attendance__chip attendance__chip--warn"
                    : "attendance__chip attendance__chip--ok"
                  : "attendance__chip attendance__chip--danger"
              }
            >
              {check.ok
                ? check.warn
                  ? text.closePanel.checkWarn
                  : text.closePanel.checkOk
                : text.closePanel.checkFail}
            </span>
            {check.note != null && (
              <span className="attendance__exdetail">{check.note}</span>
            )}
          </div>
        ))}
        {!preflight.can_close && (
          <span className="attendance__fielderror" role="alert">
            {text.closePanel.conflict}
          </span>
        )}
        <label className="attendance__attest" htmlFor={attestId}>
          <input
            id={attestId}
            type="checkbox"
            checked={attest}
            onChange={(event) => {
              setAttest(event.target.checked);
            }}
          />
          {text.closePanel.attest}
        </label>
        <div className="attendance__modalactions">
          <button
            type="button"
            className="attendance__ghostbtn"
            disabled={busy}
            onClick={close}
          >
            {text.closePanel.cancel}
          </button>
          <button
            type="button"
            className="attendance__primarybtn"
            disabled={busy || !attest || hardFail || !preflight.can_close}
            onClick={onConfirm}
          >
            {scope} {text.closePanel.confirmCta}
          </button>
        </div>
    </Dialog>
  );
}

function RaiseExceptionModal({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: CreateAttendanceException) => void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [kind, setKind] = useState<AttendanceException["kind"]>("LATE");
  const [workDate, setWorkDate] = useState(isoDate(new Date()));
  const [detail, setDetail] = useState("");
  const [evidence, setEvidence] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const employeeIdId = useId();
  const kindId = useId();
  const dateId = useId();
  const detailId = useId();
  const evidenceId = useId();
  const close = () => {
    if (!busy) onClose();
  };
  const submit = () => {
    const trimmedEmployee = employeeId.trim();
    const trimmedDetail = detail.trim();
    if (!trimmedEmployee || !workDate || !trimmedDetail) {
      setFieldError(text.actions.required);
      return;
    }
    const parsedEvidence = evidence
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
    setFieldError(undefined);
    onSubmit({
      kind,
      employee_id: trimmedEmployee,
      work_date: workDate,
      detail: trimmedDetail,
      ...(parsedEvidence.length ? { evidence: parsedEvidence } : {}),
    });
  };
  return (
    <Dialog
      open
      onClose={close}
      closeOnScrimClick={!busy}
      label={text.actions.raiseTitle}
      className="attendance__modal"
    >
      <div className="attendance__modalhead">
        <span className="attendance__modaltitle">
          {text.actions.raiseTitle}
        </span>
      </div>
      <label className="attendance__field" htmlFor={employeeIdId}>
        {text.actions.employee}
        <input
          id={employeeIdId}
          value={employeeId}
          required
          onChange={(event) => { setEmployeeId(event.target.value); }}
        />
      </label>
      <label className="attendance__field" htmlFor={kindId}>
        {text.actions.kind}
        <select
          id={kindId}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as AttendanceException["kind"]);
          }}
        >
          {Object.entries(text.exceptions.kind).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="attendance__field" htmlFor={dateId}>
        {text.actions.date}
        <input
          id={dateId}
          type="date"
          value={workDate}
          required
          onChange={(event) => { setWorkDate(event.target.value); }}
        />
      </label>
      <label className="attendance__field" htmlFor={detailId}>
        {text.actions.detail}
        <textarea
          id={detailId}
          value={detail}
          required
          maxLength={500}
          onChange={(event) => { setDetail(event.target.value); }}
        />
      </label>
      <label className="attendance__field" htmlFor={evidenceId}>
        {text.actions.evidence}
        <textarea
          id={evidenceId}
          value={evidence}
          onChange={(event) => { setEvidence(event.target.value); }}
          aria-describedby={`${evidenceId}-hint`}
        />
        <span id={`${evidenceId}-hint`} className="attendance__hint">
          {text.actions.evidenceHint}
        </span>
      </label>
      {fieldError && (
        <span className="attendance__fielderror" role="alert">
          {fieldError}
        </span>
      )}
      <div className="attendance__modalactions">
        <button
          type="button"
          className="attendance__ghostbtn"
          disabled={busy}
          onClick={close}
        >
          {text.actions.cancel}
        </button>
        <button
          type="button"
          className="attendance__actionbtn"
          disabled={busy}
          onClick={submit}
        >
          {text.actions.create}
        </button>
      </div>
    </Dialog>
  );
}

function CancelSubstitutionModal({
  substitution,
  busy,
  onClose,
  onSubmit,
}: {
  substitution: Substitution;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const reasonId = useId();
  const close = () => {
    if (!busy) onClose();
  };
  const submit = () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setFieldError(text.exceptions.reasonRequired);
      return;
    }
    setFieldError(undefined);
    onSubmit(trimmed);
  };
  return (
    <Dialog
      open
      onClose={close}
      closeOnScrimClick={!busy}
      label={text.actions.cancelSubstitutionTitle}
      className="attendance__modal"
    >
      <div className="attendance__modalhead">
        <span className="attendance__modaltitle">
          {text.actions.cancelSubstitutionTitle}
        </span>
        <span className="attendance__chip">{substitution.worker_name}</span>
      </div>
      <label className="attendance__field" htmlFor={reasonId}>
        {text.actions.cancellationReason}
        <textarea
          id={reasonId}
          value={reason}
          required
          maxLength={500}
          onChange={(event) => { setReason(event.target.value); }}
        />
      </label>
      {fieldError && (
        <span className="attendance__fielderror" role="alert">
          {fieldError}
        </span>
      )}
      <div className="attendance__modalactions">
        <button
          type="button"
          className="attendance__ghostbtn"
          disabled={busy}
          onClick={close}
        >
          {text.actions.cancel}
        </button>
        <button
          type="button"
          className="attendance__actionbtn"
          disabled={busy}
          onClick={submit}
        >
          {text.actions.cancelSubstitution}
        </button>
      </div>
    </Dialog>
  );
}

function CloseAmendmentModal({
  close: monthClose,
  busy,
  onClose,
  onSubmit,
}: {
  close: MonthClose;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: CloseAmendmentInput) => void;
}) {
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");
  const [ref, setRef] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const reasonId = useId();
  const detailId = useId();
  const refId = useId();
  const closeDialog = () => {
    if (!busy) onClose();
  };
  const submit = () => {
    const nextReason = reason.trim();
    const nextDetail = detail.trim();
    if (!nextReason || !nextDetail) {
      setFieldError(text.actions.required);
      return;
    }
    setFieldError(undefined);
    onSubmit({
      reason: nextReason,
      detail: nextDetail,
      ...(ref.trim() ? { ref: ref.trim() } : {}),
    });
  };
  return (
    <Dialog
      open
      onClose={closeDialog}
      closeOnScrimClick={!busy}
      label={text.actions.amendTitle}
      className="attendance__modal"
    >
      <div className="attendance__modalhead">
        <span className="attendance__modaltitle">
          {text.actions.amendTitle}
        </span>
        <span className="attendance__chip">{monthClose.month}</span>
      </div>
      <label className="attendance__field" htmlFor={reasonId}>
        {text.actions.amendmentReason}
        <input
          id={reasonId}
          value={reason}
          required
          onChange={(event) => { setReason(event.target.value); }}
        />
      </label>
      <label className="attendance__field" htmlFor={detailId}>
        {text.actions.amendmentDetail}
        <textarea
          id={detailId}
          value={detail}
          required
          maxLength={500}
          onChange={(event) => { setDetail(event.target.value); }}
        />
      </label>
      <label className="attendance__field" htmlFor={refId}>
        {text.actions.amendmentRef}
        <input
          id={refId}
          value={ref}
          onChange={(event) => { setRef(event.target.value); }}
        />
      </label>
      {fieldError && (
        <span className="attendance__fielderror" role="alert">
          {fieldError}
        </span>
      )}
      <div className="attendance__modalactions">
        <button
          type="button"
          className="attendance__ghostbtn"
          disabled={busy}
          onClick={closeDialog}
        >
          {text.actions.cancel}
        </button>
        <button
          type="button"
          className="attendance__actionbtn"
          disabled={busy}
          onClick={submit}
        >
          {text.actions.submit}
        </button>
      </div>
    </Dialog>
  );
}
