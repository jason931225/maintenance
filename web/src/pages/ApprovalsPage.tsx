import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

import type {
  DailyPlanSummary,
  TargetChangeDecision,
  TargetChangeRequestSummary,
  WorkOrderListItem,
} from "../api/types";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { useAuth } from "../context/auth";
import {
  ApprovalCommandCenter,
  type ApprovalSourceKey,
} from "../features/approvals/ApprovalCommandCenter";
import { ApprovalQueue } from "../features/approvals/ApprovalQueue";
import { TargetChangeReviewQueue } from "../features/approvals/TargetChangeReviewQueue";
import { ko } from "../i18n/ko";

const approvalStatuses: WorkOrderListItem["status"][] = [
  "REPORT_SUBMITTED",
  "ADMIN_REVIEW",
];

type ReadState = "idle" | "loading" | "error";
type WriteState = "idle" | "error";

interface CapturedSource<T = unknown> {
  key: ApprovalSourceKey;
  data?: T;
  failed: boolean;
}

async function capture<T>(
  key: ApprovalSourceKey,
  request: Promise<{ data?: T } | undefined>,
): Promise<CapturedSource<T>> {
  const response = await request.catch(() => undefined);
  return { key, data: response?.data, failed: !response?.data };
}

function sourceFailureMessage(failures: ApprovalSourceKey[]): string {
  return ko.approvals.partialFailure.replace(
    "{sources}",
    failures.map((failure) => ko.approvals.sources[failure]).join(", "),
  );
}

export function ApprovalsPage() {
  const { api } = useAuth();
  const location = useLocation();
  const [workOrders, setWorkOrders] = useState<WorkOrderListItem[]>([]);
  const [dailyPlans, setDailyPlans] = useState<DailyPlanSummary[]>([]);
  const [failures, setFailures] = useState<ApprovalSourceKey[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [writeState, setWriteState] = useState<WriteState>("idle");

  const requestedDailyPlans = useMemo(
    () => dailyPlans.filter((plan) => plan.status === "REQUESTED"),
    [dailyPlans],
  );
  const pendingCount = workOrders.length + requestedDailyPlans.length;
  const workOrdersFailed = failures.includes("workOrders");
  const focusedWorkOrderId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("source") === "work-order"
      ? params.get("focus")?.trim() || undefined
      : undefined;
  }, [location.search]);

  const loadData = useCallback(async () => {
    setReadState("loading");
    const results = await Promise.all([
      capture(
        "workOrders",
        api.GET("/api/v1/work-orders", {
          params: {
            query: { status: approvalStatuses, limit: 100, offset: 0 },
          },
        }),
      ),
      capture(
        "dailyPlans",
        api.GET("/api/daily-work-plans", { params: { query: {} } }),
      ),
    ]);

    const workOrderResult = results.find((result) => result.key === "workOrders") as
      | CapturedSource<{ items?: WorkOrderListItem[] }>
      | undefined;
    const dailyPlanResult = results.find((result) => result.key === "dailyPlans") as
      | CapturedSource<{ items?: DailyPlanSummary[] }>
      | undefined;
    const nextFailures = results
      .filter((result) => result.failed)
      .map((result) => result.key);

    setWorkOrders(workOrderResult?.data?.items ?? []);
    setDailyPlans(dailyPlanResult?.data?.items ?? []);
    setFailures(nextFailures);
    setReadState(nextFailures.length === results.length ? "error" : "idle");
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(loadData);
  }, [loadData]);

  async function approveWorkOrder(workOrderId: string): Promise<boolean> {
    setWriteState("idle");
    try {
      const response = await api.POST("/api/work-orders/{workOrderId}/approve", {
        params: { path: { workOrderId } },
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
      return response.data;
    } catch {
      setWriteState("error");
      return undefined;
    }
  }

  const isInitialLoading =
    readState === "loading" && workOrders.length === 0 && dailyPlans.length === 0;

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
              workOrders={workOrders}
              dailyPlans={dailyPlans}
              failures={failures}
            />
            {failures.length > 0 ? (
              <PageError
                message={sourceFailureMessage(failures)}
                onRetry={() => { void loadData(); }}
              />
            ) : null}
            <div id="work-order-approval-queue" className="scroll-mt-24">
              {workOrdersFailed ? (
                <PageError
                  message={sourceFailureMessage(["workOrders"])}
                  onRetry={() => { void loadData(); }}
                />
              ) : (
                <ApprovalQueue
                  workOrders={workOrders}
                  focusedWorkOrderId={focusedWorkOrderId}
                  onApprove={approveWorkOrder}
                  onReject={rejectWorkOrder}
                />
              )}
            </div>
            <div id="target-change-review-queue" className="scroll-mt-24">
              <TargetChangeReviewQueue onReview={reviewTargetChange} />
            </div>
          </>
        )}
      </div>
    </>
  );
}
