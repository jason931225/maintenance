import { useCallback, useEffect, useRef, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { ApiCallError } from "../../api/ontologyActions";
import { ko } from "../../i18n/ko";
import {
  createAccountingPeriodLock,
  listAccountingPeriodLocks,
  unlockAccountingPeriodLock,
  type PeriodLock,
} from "./financeApi";
import "./PeriodLockPanel.css";

const copy = ko.console.modules.finance.periodLock;

type LoadState = "loading" | "ready" | "denied" | "error";
type FormIssue =
  | "start"
  | "end"
  | "range"
  | "reason"
  | "unlockReason"
  | "conflict"
  | "denied"
  | "failed";

function newestFirst(locks: PeriodLock[]): PeriodLock[] {
  return [...locks].sort((left, right) =>
    right.lockedAt.localeCompare(left.lockedAt),
  );
}

function isDenied(error: unknown): boolean {
  return (
    error instanceof ApiCallError &&
    (error.status === 401 || error.status === 403)
  );
}

function issueText(issue: FormIssue): string {
  if (issue === "conflict") return copy.conflict;
  if (issue === "denied") return copy.denied;
  if (issue === "failed") return copy.failed;
  return copy.errors[issue];
}

function dateIsValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function displayAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ko-KR", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(date);
}

/** Accounting-only close control. It presents the immutable backend history and
 * never implies that voucher posting itself is period-lock enforced. */
export function PeriodLockPanel({
  api,
  authorityKey,
}: {
  api: ConsoleApiClient;
  authorityKey: string;
}) {
  const controllerRef = useRef<AbortController | null>(null);
  const epochRef = useRef(0);
  const [locks, setLocks] = useState<PeriodLock[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [issue, setIssue] = useState<FormIssue | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [unlockReasons, setUnlockReasons] = useState<Record<string, string>>(
    {},
  );
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const epoch = ++epochRef.current;
    setLoadState("loading");
    try {
      const next = await listAccountingPeriodLocks(api, controller.signal);
      if (controller.signal.aborted || epoch !== epochRef.current) return;
      setLocks(newestFirst(next));
      setLoadState("ready");
    } catch (error: unknown) {
      if (controller.signal.aborted || epoch !== epochRef.current) return;
      setLoadState(isDenied(error) ? "denied" : "error");
    }
  }, [api]);

  useEffect(() => {
    const run = async () => {
      await Promise.resolve();
      await refresh();
    };
    void run();
    return () => {
      epochRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [authorityKey, refresh]);

  const create = useCallback(async () => {
    const trimmedReason = reason.trim();
    if (!dateIsValid(start)) {
      setIssue("start");
      return;
    }
    if (!dateIsValid(end)) {
      setIssue("end");
      return;
    }
    if (end < start) {
      setIssue("range");
      return;
    }
    if (!trimmedReason) {
      setIssue("reason");
      return;
    }
    const authorityEpoch = epochRef.current;
    setIssue(null);
    setBusy("create");
    try {
      await createAccountingPeriodLock(api, {
        domain: "accounting",
        periodStart: start,
        periodEnd: end,
        reason: trimmedReason,
      });
      if (authorityEpoch !== epochRef.current) return;
      setStart("");
      setEnd("");
      setReason("");
      await refresh();
    } catch (error: unknown) {
      if (authorityEpoch === epochRef.current) {
        setIssue(
          error instanceof ApiCallError && error.status === 409
            ? "conflict"
            : isDenied(error)
              ? "denied"
              : "failed",
        );
      }
    } finally {
      if (authorityEpoch === epochRef.current) setBusy(null);
    }
  }, [api, end, reason, refresh, start]);

  const unlock = useCallback(
    async (lockId: string) => {
      const unlockReason = (unlockReasons[lockId] ?? "").trim();
      if (!unlockReason) {
        setIssue("unlockReason");
        return;
      }
      const authorityEpoch = epochRef.current;
      setIssue(null);
      setBusy(lockId);
      try {
        await unlockAccountingPeriodLock(api, lockId, { reason: unlockReason });
        if (authorityEpoch !== epochRef.current) return;
        setUnlockReasons((current) => ({ ...current, [lockId]: "" }));
        await refresh();
      } catch (error: unknown) {
        if (authorityEpoch === epochRef.current) {
          setIssue(
            error instanceof ApiCallError && error.status === 409
              ? "conflict"
              : isDenied(error)
                ? "denied"
                : "failed",
          );
        }
      } finally {
        if (authorityEpoch === epochRef.current) setBusy(null);
      }
    },
    [api, refresh, unlockReasons],
  );

  const active = locks.filter((lock) => !lock.unlockedAt);
  const history = locks.filter((lock) => !!lock.unlockedAt);

  return (
    <section aria-label={copy.title} className="period-lock-panel">
      <div className="period-lock-panel__heading">
        <div>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
      </div>
      {issue ? <div role="alert">{issueText(issue)}</div> : null}
      <form
        className="period-lock-panel__form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="period-lock-panel__field">
          {copy.start}
          <input
            aria-label={copy.start}
            type="date"
            value={start}
            onChange={(event) => {
              setStart(event.target.value);
            }}
            disabled={busy !== null}
          />
        </label>
        <label className="period-lock-panel__field">
          {copy.end}
          <input
            aria-label={copy.end}
            type="date"
            value={end}
            onChange={(event) => {
              setEnd(event.target.value);
            }}
            disabled={busy !== null}
          />
        </label>
        <label className="period-lock-panel__field">
          {copy.reason}
          <input
            aria-label={copy.reason}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            disabled={busy !== null}
          />
        </label>
        <button
          className="period-lock-panel__primary"
          type="submit"
          disabled={busy !== null}
        >
          {busy === "create" ? copy.creating : copy.create}
        </button>
      </form>
      {loadState === "loading" ? (
        <div className="period-lock-panel__state" role="status">
          {copy.loading}
        </div>
      ) : null}
      {loadState === "denied" ? <div role="alert">{copy.denied}</div> : null}
      {loadState === "error" ? <div role="alert">{copy.failed}</div> : null}
      {loadState === "ready" && locks.length === 0 ? (
        <div className="period-lock-panel__state">{copy.empty}</div>
      ) : null}
      {loadState === "ready" && locks.length > 0 ? (
        <div className="period-lock-panel__table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{copy.status}</th>
                <th scope="col">{copy.domain}</th>
                <th scope="col">{copy.start}</th>
                <th scope="col">{copy.end}</th>
                <th scope="col">{copy.reason}</th>
                <th scope="col">{copy.lockedAt}</th>
                <th scope="col">{copy.unlockedAt}</th>
                <th scope="col">{copy.unlockReasonLabel}</th>
              </tr>
            </thead>
            <tbody>
              {active.map((lock) => (
                <tr key={lock.id}>
                  <td>{copy.active}</td>
                  <td>{copy.domain}</td>
                  <td>{lock.periodStart}</td>
                  <td>{lock.periodEnd}</td>
                  <td>{lock.reason}</td>
                  <td>{displayAt(lock.lockedAt)}</td>
                  <td>
                    <div className="period-lock-panel__unlock">
                      <label className="period-lock-panel__field">
                        {copy.unlockReason(lock.id)}
                        <input
                          aria-label={copy.unlockReason(lock.id)}
                          value={unlockReasons[lock.id] ?? ""}
                          onChange={(event) => {
                            setUnlockReasons((current) => ({
                              ...current,
                              [lock.id]: event.target.value,
                            }));
                          }}
                          disabled={busy !== null}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          void unlock(lock.id);
                        }}
                        disabled={busy !== null}
                      >
                        {busy === lock.id ? copy.unlocking : copy.unlock}
                      </button>
                    </div>
                  </td>
                  <td>{copy.locked}</td>
                </tr>
              ))}
              {history.map((lock) => (
                <tr key={lock.id}>
                  <td>{copy.history}</td>
                  <td>{copy.domain}</td>
                  <td>{lock.periodStart}</td>
                  <td>{lock.periodEnd}</td>
                  <td>{lock.reason}</td>
                  <td>{displayAt(lock.lockedAt)}</td>
                  <td>
                    {lock.unlockedAt ? (
                      <>
                        <span>{copy.unlocked}</span>{" "}
                        {displayAt(lock.unlockedAt)}
                      </>
                    ) : (
                      ""
                    )}
                  </td>
                  <td>{lock.unlockReason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
