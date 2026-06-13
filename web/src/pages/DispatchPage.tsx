import { useCallback, useEffect, useState } from "react";

import type { WorkOrderListItem } from "../api/types";
import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { DispatchBoard } from "../features/dispatch/DispatchBoard";
import { WorkOrderList } from "../features/dispatch/WorkOrderList";
import { ko } from "../i18n/ko";

const defaultMechanicId = "00000000-0000-4000-8000-000000000002";

type ReadState = "idle" | "loading" | "error";
type WriteState = "idle" | "error";

export function DispatchPage() {
  const { api } = useAuth();
  const [workOrders, setWorkOrders] = useState<WorkOrderListItem[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [writeState, setWriteState] = useState<WriteState>("idle");

  const loadData = useCallback(async () => {
    setReadState("loading");
    const response = await api.GET("/api/v1/work-orders", {
      params: { query: { limit: 100, offset: 0 } },
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

  async function assignWorkOrder(workOrderId: string, mechanicId: string): Promise<boolean> {
    setWriteState("idle");
    try {
      const response = await api.PUT("/api/work-orders/{workOrderId}/assignments", {
        params: { path: { workOrderId } },
        body: { assignments: [{ mechanic_id: mechanicId, role: "PRIMARY" }] },
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
        title={ko.dispatch.title}
        description={ko.dispatch.description}
        actions={
          <RefreshButton
            onClick={() => { void loadData(); }}
            isLoading={readState === "loading"}
          />
        }
      />
      <div className="grid gap-5">
        {readState === "error" ? <PageError onRetry={() => { void loadData(); }} /> : null}
        {writeState === "error" ? <PageError message={ko.common.writeFailed} /> : null}
        <WorkOrderList workOrders={workOrders} isLoading={readState === "loading"} />
        <DispatchBoard
          workOrders={workOrders}
          selectedMechanicId={defaultMechanicId}
          isLoading={readState === "loading"}
          onAssignWorkOrder={assignWorkOrder}
        />
      </div>
    </>
  );
}
