// UI-M4 전자결재 — approvals on the workflow engine (ConsoleShell screen).
//
// 결재함 (inbox): my waiting tasks (/api/v1/workflow-tasks?assignee=me). 상신함
// (my requests): runs I initiated (/api/v1/workflow-runs/mine). Each row is an
// AP- object with a status chip and ONE primary action; clicking pins the run
// detail panel (ApprovalDetailPanel) where the engine decision/finalization is
// made. 기안 (compose) is deferred — there is no all-employee submittable-
// definition catalog on the backend yet (studio catalog is workflow-manage only),
// so a template gallery would have no live source (plan §1 principle 4).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import type {
  WorkflowRunListItem,
  WorkflowTaskSummary,
} from "../api/types";
import { Chip, MonoRef, type Tone } from "../components/console/primitives";
import {
  CONSOLE_LIST_BODY_CLASS,
  useListNav,
} from "../components/console/list-grammar";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PinButton } from "../components/shell/workspace/PinButton";
import {
  useConsoleScreen,
  useConsoleWorkspaceOwner,
} from "../features/workspace/pin-context";
import { useWorkspaceStore } from "../features/workspace/store";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { useAuth } from "../context/auth";
import {
  apCode,
  buildInboxRows,
  buildRequestRows,
  runStatusLabel,
  taskStatusLabel,
  type InboxRow,
  type RequestRow,
} from "../features/eApprovals/approvals-data";
import { onApprovalsChanged } from "../features/eApprovals/changed-event";
import { hubRowToPin } from "../features/workspace/adapters";
import type { PinnedObject } from "../features/workspace/types";
import { ko } from "../i18n/ko";
import { objectRegistry } from "../lib/objectRegistry";
import { cn } from "../lib/utils";

type ReadState = "loading" | "idle" | "error";
type Tab = "inbox" | "requests";

interface EApprovalsPageProps {
  active?: boolean;
}

function runPin(runId: string, code: string, title: string): PinnedObject {
  return hubRowToPin({
    code,
    kind: "approval",
    title,
    eyebrow: ko.console.objectKinds.approval,
    detail: title,
    href: objectRegistry.approval.route({ id: runId, code }),
    refId: runId,
  });
}

export function EApprovalsPage({ active = true }: EApprovalsPageProps = {}) {
  const { api, session } = useAuth();
  const location = useLocation();
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const openedRunRef = useRef<string | null>(null);
  const [tab, setTab] = useState<Tab>("inbox");
  const [tasks, setTasks] = useState<WorkflowTaskSummary[]>([]);
  const [runs, setRuns] = useState<WorkflowRunListItem[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");

  // Pin plumbing (mirrors PinButton) so a row's primary "open" action pins the
  // run detail panel onto this screen.
  const screen = useConsoleScreen();
  const ownerKey = useConsoleWorkspaceOwner();
  const storeOwnerKey = useWorkspaceStore((s) => s.ownerKey);
  const pin = useWorkspaceStore((s) => s.pin);
  const pinRun = useCallback(
    (object: PinnedObject) => {
      if (!screen) return;
      if (ownerKey !== undefined && storeOwnerKey !== ownerKey) return;
      pin(screen, object);
    },
    [screen, ownerKey, storeOwnerKey, pin],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadData = useCallback(async () => {
    if (!mountedRef.current) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const isCurrent = () =>
      mountedRef.current && requestRef.current === requestId;
    setReadState("loading");

    const [inbox, mine] = await Promise.all([
      api
        .GET("/api/v1/workflow-tasks", {
          params: { query: { assignee: "me", status: "OPEN,CLAIMED" } },
        })
        .catch(() => undefined),
      api.GET("/api/v1/workflow-runs/mine", {}).catch(() => undefined),
    ]);

    if (!isCurrent()) return;
    const inboxFailed = !inbox?.data;
    const mineFailed = !mine?.data;
    setTasks(inbox?.data?.items ?? []);
    setRuns(mine?.data?.items ?? []);
    setReadState(inboxFailed && mineFailed ? "error" : "idle");
  }, [api]);

  useEffect(() => {
    if (!active) return;
    void Promise.resolve().then(loadData);
  }, [active, loadData]);

  // A decision made inside a pinned detail panel refreshes the lists here.
  useEffect(() => {
    if (!active) return undefined;
    return onApprovalsChanged(() => {
      void loadData();
    });
  }, [active, loadData]);

  const inboxRows = useMemo(
    () => buildInboxRows(tasks, session?.user_id),
    [tasks, session?.user_id],
  );
  const requestRows = useMemo(() => buildRequestRows(runs), [runs]);

  // Deep-link (overview row / ⌘K / AP- code) → open the run detail panel: no
  // dead end. The reducer dedupes on (kind, code), so the ref just avoids
  // re-pinning on unrelated re-renders.
  const runParam = new URLSearchParams(location.search).get("run");
  useEffect(() => {
    if (!active || !runParam || openedRunRef.current === runParam) return;
    openedRunRef.current = runParam;
    const known = [...inboxRows, ...requestRows].find(
      (row) => row.runId === runParam,
    );
    pinRun(
      runPin(
        runParam,
        apCode(runParam),
        known?.title ?? ko.eApprovals.rows.untitledRequest,
      ),
    );
  }, [active, runParam, inboxRows, requestRows, pinRun]);

  const runInboxAction = useCallback(
    (row: InboxRow) => {
      pinRun(runPin(row.runId, row.code, row.title));
    },
    [pinRun],
  );

  const openRequest = useCallback(
    (row: RequestRow) => {
      pinRun(runPin(row.runId, row.code, row.title));
    },
    [pinRun],
  );

  const rows = tab === "inbox" ? inboxRows : requestRows;
  const listNav = useListNav({
    count: rows.length,
    onOpen: (index) => {
      if (tab === "inbox") runInboxAction(inboxRows[index]);
      else openRequest(requestRows[index]);
    },
  });

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "inbox", label: ko.eApprovals.tabs.inbox, count: inboxRows.length },
    {
      key: "requests",
      label: ko.eApprovals.tabs.requests,
      count: requestRows.length,
    },
  ];

  return (
    <>
      <PageHeader
        title={ko.eApprovals.title}
        actions={
          <RefreshButton
            onClick={() => {
              void loadData();
            }}
            isLoading={readState === "loading"}
          />
        }
      />

      <div
        className="mb-3 flex flex-wrap gap-1.5"
        role="tablist"
        aria-label={ko.eApprovals.tabsLabel}
      >
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            onClick={() => {
              setTab(entry.key);
            }}
            className={cn(
              "min-h-8 rounded-full border px-3 text-[12px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal",
              tab === entry.key
                ? "border-console-ink bg-console-ink text-console-surface"
                : "border-console-border bg-console-surface text-console-steel hover:text-console-ink",
            )}
          >
            {entry.label} {entry.count}
          </button>
        ))}
      </div>

      {readState === "loading" && rows.length === 0 ? (
        <SkeletonCards count={4} lines={2} />
      ) : readState === "error" ? (
        <PageError
          onRetry={() => {
            void loadData();
          }}
        />
      ) : rows.length === 0 ? (
        <PageEmpty
          message={
            tab === "inbox"
              ? ko.eApprovals.emptyInbox
              : ko.eApprovals.emptyRequests
          }
        />
      ) : (
        <div
          role="list"
          aria-label={
            tab === "inbox"
              ? ko.eApprovals.tabs.inbox
              : ko.eApprovals.tabs.requests
          }
          tabIndex={0}
          className={cn(
            CONSOLE_LIST_BODY_CLASS,
            "max-h-[70vh] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal",
          )}
          onKeyDown={listNav.onKeyDown}
        >
          {tab === "inbox"
            ? inboxRows.map((row, index) => (
                <ApprovalRow
                  key={row.id}
                  index={index}
                  selected={listNav.selectedIndex === index}
                  itemRef={listNav.getItemRef(index)}
                  code={row.code}
                  title={row.title}
                  statusLabelText={taskStatusLabel(row.status)}
                  statusTone={row.statusTone}
                  detail={row.detail}
                  dueLabel={row.dueLabel}
                  actionLabel={row.actionLabel}
                  actionDisabled={false}
                  onAction={() => {
                    runInboxAction(row);
                  }}
                  pinObject={runPin(row.runId, row.code, row.title)}
                />
              ))
            : requestRows.map((row, index) => (
                <ApprovalRow
                  key={row.id}
                  index={index}
                  selected={listNav.selectedIndex === index}
                  itemRef={listNav.getItemRef(index)}
                  code={row.code}
                  title={row.title}
                  statusLabelText={runStatusLabel(row.status)}
                  statusTone={row.statusTone}
                  detail={row.detail}
                  actionLabel={ko.eApprovals.actions.view}
                  actionDisabled={false}
                  onAction={() => {
                    openRequest(row);
                  }}
                  pinObject={runPin(row.runId, row.code, row.title)}
                />
              ))}
        </div>
      )}
    </>
  );
}

function ApprovalRow({
  index,
  selected,
  itemRef,
  code,
  title,
  statusLabelText,
  statusTone,
  detail,
  dueLabel,
  actionLabel,
  actionDisabled,
  onAction,
  pinObject,
}: {
  index: number;
  selected: boolean;
  itemRef: (node: HTMLElement | null) => void;
  code: string;
  title: string;
  statusLabelText: string;
  statusTone: Tone;
  detail: string;
  dueLabel?: string;
  actionLabel: string;
  actionDisabled: boolean;
  onAction: () => void;
  pinObject: PinnedObject;
}) {
  return (
    <div
      role="listitem"
      tabIndex={selected ? 0 : -1}
      ref={itemRef}
      data-index={index}
      className={cn(
        "mb-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[8px] border border-console-border bg-console-surface px-3 py-2",
        selected && "ring-2 ring-inset ring-console-signal",
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={statusTone}>{statusLabelText}</Chip>
          <MonoRef value={code} />
        </div>
        <p className="mt-1 truncate text-[13px] font-bold text-console-ink">{title}</p>
        <p className="truncate text-[12px] text-console-steel">
          {detail}
          {dueLabel ? ` · ${dueLabel}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <PinButton object={pinObject} />
        <button
          type="button"
          disabled={actionDisabled}
          aria-label={`${title} ${actionLabel}`}
          onClick={onAction}
          className="min-h-8 rounded-[7px] border border-console-border bg-console-surface px-2.5 text-[12px] font-bold text-console-ink hover:bg-console-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal disabled:opacity-50"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
