import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

import type {
  ApprovalItemsPage,
  TargetChangeDecision,
  TargetChangeRequestSummary,
} from "../api/types";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { useAuth } from "../context/auth";
import {
  ApprovalCommandCenter,
} from "../features/approvals/ApprovalCommandCenter";
import { ApprovalQueue } from "../features/approvals/ApprovalQueue";
import { TargetChangeReviewQueue } from "../features/approvals/TargetChangeReviewQueue";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";
type WriteState = "idle" | "error";

export function ApprovalsPage() {
  const { api } = useAuth();
  const location = useLocation();
  const [approvalPage, setApprovalPage] = useState<ApprovalItemsPage>();
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
      const response = await api.GET("/api/approval-items", {
        params: { query: { limit: 100, offset: 0 } },
      });
      if (!response.data) {
        setReadState("error");
        return;
      }
      setApprovalPage(response.data);
      setReadState("idle");
    } catch {
      setReadState("error");
    }
  }, [api]);

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
