import { useCallback, useEffect, useState } from "react";

import type {
  TargetChangeDecision,
  TargetChangeRequestSummary,
  WorkOrderListItem,
} from "../api/types";
import { useAuth } from "../context/auth";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { ApprovalQueue } from "../features/approvals/ApprovalQueue";
import { TargetChangeReviewQueue } from "../features/approvals/TargetChangeReviewQueue";
import { ko } from "../i18n/ko";

const approvalStatuses: WorkOrderListItem["status"][] = [
  "REPORT_SUBMITTED",
  "ADMIN_REVIEW",
];

type ReadState = "idle" | "loading" | "error";
type WriteState = "idle" | "error";

export function ApprovalsPage() {
  const { api } = useAuth();
  const [workOrders, setWorkOrders] = useState<WorkOrderListItem[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [writeState, setWriteState] = useState<WriteState>("idle");

  const loadData = useCallback(async () => {
    setReadState("loading");
    const response = await api.GET("/api/v1/work-orders", {
      params: {
        query: { status: approvalStatuses, limit: 100, offset: 0 },
      },
    }).catch(() => undefined);
    if (!response?.data) {
      setReadState("error");
      return;
    }
    setWorkOrders(response.data.items);
    setReadState("idle");
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

  return (
    <>
      <PageHeader
        title={ko.approvals.title}
        description={ko.approvals.description}
        actions={
          <>
            <Badge>{workOrders.length}</Badge>
            <RefreshButton
              onClick={() => { void loadData(); }}
              isLoading={readState === "loading"}
            />
          </>
        }
      />
      <div className="grid gap-5">
        {writeState === "error" ? <PageError message={ko.common.writeFailed} /> : null}
        {/* First load shows a skeleton so the empty-queue copy is never mistaken
            for "nothing to approve" while the fetch is still in flight. A
            refetch keeps the current queue visible (stale-while-revalidate). */}
        {readState === "loading" && workOrders.length === 0 ? (
          <SkeletonCards count={3} lines={2} />
        ) : readState === "error" ? (
          <PageError onRetry={() => { void loadData(); }} />
        ) : (
          <ApprovalQueue
            workOrders={workOrders}
            onApprove={approveWorkOrder}
            onReject={rejectWorkOrder}
          />
        )}
        <TargetChangeReviewQueue onReview={reviewTargetChange} />
      </div>
    </>
  );
}
