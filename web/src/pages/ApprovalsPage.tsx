import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

import type { ConsoleApiClient } from "../api/client";
import type {
  ApprovalItemsPage,
  HrReadinessSummary,
  LeaveBalancePage,
  TargetChangeDecision,
  TargetChangeRequestSummary,
} from "../api/types";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import type { AuthSession } from "../context/auth";
import { useAuth } from "../context/auth";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import {
  ApprovalCommandCenter,
} from "../features/approvals/ApprovalCommandCenter";
import { ApprovalDocumentDesk } from "../features/approvals/ApprovalDocumentDesk";
import { ApprovalQueue } from "../features/approvals/ApprovalQueue";
import { TargetChangeReviewQueue } from "../features/approvals/TargetChangeReviewQueue";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";
type WriteState = "idle" | "error";

const ORG_WIDE_HR_ROLES = [ROLES.EXECUTIVE, ROLES.SUPER_ADMIN] as const;

type ApprovalsApi = ConsoleApiClient & {
  GET(
    path: "/api/approval-items",
    options: { params: { query: { limit: number; offset: number } } },
  ): Promise<{ data?: ApprovalItemsPage }>;
  GET(path: "/api/v1/hr/readiness-summary"): Promise<{
    data?: HrReadinessSummary;
  }>;
  GET(
    path: "/api/v1/hr/leave-balances",
    options?: { params?: { query?: { limit?: number; offset?: number } } },
  ): Promise<{ data?: LeaveBalancePage }>;
};

function canLoadOrgWideHrData(session: AuthSession | undefined): boolean {
  return hasAnyRole(session?.roles, ORG_WIDE_HR_ROLES);
}

export function ApprovalsPage() {
  const { api, session } = useAuth();
  const approvalsApi = api as ApprovalsApi;
  const location = useLocation();
  const canLoadHrData = canLoadOrgWideHrData(session);
  const [approvalPage, setApprovalPage] = useState<ApprovalItemsPage>();
  const [readinessSummary, setReadinessSummary] =
    useState<HrReadinessSummary>();
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalancePage>();
  const [readState, setReadState] = useState<ReadState>("loading");
  const [writeState, setWriteState] = useState<WriteState>("idle");

  const workOrders = useMemo(
    () =>
      approvalPage?.items.flatMap((item) =>
        item.work_order ? [item.work_order] : [],
      ) ?? [],
    [approvalPage],
  );
  const dailyPlans = useMemo(
    () =>
      approvalPage?.items.flatMap((item) =>
        item.daily_plan ? [item.daily_plan] : [],
      ) ?? [],
    [approvalPage],
  );
  const targetChanges = useMemo(
    () =>
      approvalPage?.items.flatMap((item) =>
        item.target_change ? [item.target_change] : [],
      ) ?? [],
    [approvalPage],
  );
  const requestedDailyPlans = useMemo(
    () => dailyPlans.filter((plan) => plan.status === "REQUESTED"),
    [dailyPlans],
  );
  const pendingCount =
    approvalPage?.total ??
    workOrders.length + requestedDailyPlans.length + targetChanges.length;
  const canReviewTargetChanges =
    !approvalPage ||
    approvalPage.sources.length === 0 ||
    approvalPage.sources.some((source) => source.key === "targetChanges");
  const focusedWorkOrderId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("source") === "work-order"
      ? params.get("focus")?.trim() || undefined
      : undefined;
  }, [location.search]);

  const loadData = useCallback(async () => {
    setReadState("loading");
    try {
      const [response, readinessResponse, leaveResponse] = await Promise.all([
        approvalsApi.GET("/api/approval-items", {
          params: { query: { limit: 100, offset: 0 } },
        }),
        canLoadHrData
          ? approvalsApi
              .GET("/api/v1/hr/readiness-summary")
              .catch(() => undefined)
          : Promise.resolve(undefined),
        canLoadHrData
          ? approvalsApi
              .GET("/api/v1/hr/leave-balances", {
                params: { query: { limit: 1000, offset: 0 } },
              })
              .catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      if (!response.data) {
        setReadState("error");
        return;
      }
      setApprovalPage(response.data);
      setReadinessSummary(readinessResponse?.data);
      setLeaveBalances(leaveResponse?.data);
      setReadState("idle");
    } catch {
      setReadState("error");
    }
  }, [approvalsApi, canLoadHrData]);

  useEffect(() => {
    void Promise.resolve().then(loadData);
  }, [loadData]);

  async function approveWorkOrder(workOrderId: string, comment: string): Promise<boolean> {
    setWriteState("idle");
    try {
      const response = await api.POST("/api/work-orders/{workOrderId}/approve", {
        params: { path: { workOrderId } },
        body: { comment },
      });
      if (!response.data) {
        setWriteState("error");
        return false;
      }
      await loadData();
      return true;
    } catch {
      setWriteState("error");
      return false;
    }
  }

  async function rejectWorkOrder(workOrderId: string, memo: string): Promise<boolean> {
    setWriteState("idle");
    try {
      const response = await api.POST("/api/v1/work-orders/{workOrderId}/reject", {
        params: { path: { workOrderId } },
        body: { memo },
      });
      if (!response.data) {
        setWriteState("error");
        return false;
      }
      await loadData();
      return true;
    } catch {
      setWriteState("error");
      return false;
    }
  }

  async function reviewTargetChange(
    requestId: string,
    decision: TargetChangeDecision,
    memo: string,
  ): Promise<TargetChangeRequestSummary | undefined> {
    setWriteState("idle");
    try {
      const response = await api.POST(
        "/api/target-change-requests/{requestId}/review",
        {
          params: { path: { requestId } },
          body: { decision, memo: memo || undefined },
        },
      );
      if (!response.data) {
        setWriteState("error");
        return undefined;
      }
      await loadData();
      return response.data;
    } catch {
      setWriteState("error");
      return undefined;
    }
  }

  const isInitialLoading =
    readState === "loading" && !approvalPage;

  return (
    <>
      <PageHeader
        title={ko.approvals.title}
        description={ko.approvals.description}
        actions={
          <>
            <Badge>{pendingCount}</Badge>
            <RefreshButton
              onClick={() => { void loadData(); }}
              isLoading={readState === "loading"}
            />
          </>
        }
      />
      <div className="grid gap-5">
        {writeState === "error" ? <PageError message={ko.common.writeFailed} /> : null}
        {isInitialLoading ? (
          <SkeletonCards count={3} lines={2} />
        ) : readState === "error" ? (
          <PageError onRetry={() => { void loadData(); }} />
        ) : (
          <>
            <ApprovalCommandCenter
              items={approvalPage?.items ?? []}
              workOrders={workOrders}
              dailyPlans={dailyPlans}
              targetChanges={targetChanges}
              sources={approvalPage?.sources ?? []}
            />
            <ApprovalDocumentDesk
              items={approvalPage?.items ?? []}
              readinessSummary={readinessSummary}
              leaveBalances={leaveBalances}
            />
            <div id="work-order-approval-queue" className="scroll-mt-24">
              <ApprovalQueue
                workOrders={workOrders}
                focusedWorkOrderId={focusedWorkOrderId}
                onApprove={approveWorkOrder}
                onReject={rejectWorkOrder}
              />
            </div>
            {canReviewTargetChanges ? (
              <div id="target-change-review-queue" className="scroll-mt-24">
                <TargetChangeReviewQueue
                  requests={targetChanges}
                  onReview={reviewTargetChange}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
