import { useCallback, useEffect, useState } from "react";

import type { WorkOrderListItem } from "../api/types";
import { useAuth } from "../context/auth";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { ApprovalQueue } from "../features/approvals/ApprovalQueue";
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
        {readState === "error" ? <PageError onRetry={() => { void loadData(); }} /> : null}
        {writeState === "error" ? <PageError message={ko.common.writeFailed} /> : null}
        <ApprovalQueue
          workOrders={workOrders}
          onApprove={approveWorkOrder}
          onReject={rejectWorkOrder}
        />
      </div>
    </>
  );
}
