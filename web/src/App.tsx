import { useEffect, useMemo, useState } from "react";

import { createConsoleApiClient } from "./api/client";
import type {
  CreateWorkOrderRequest,
  TokenPairResponse,
  WorkOrderSummary,
} from "./api/types";
import { ko } from "./i18n/ko";
import { PasskeyLoginPage } from "./features/auth/PasskeyLoginPage";
import { IntakeForm } from "./features/intake/IntakeForm";
import { DispatchBoard } from "./features/dispatch/DispatchBoard";
import { ApprovalQueue } from "./features/approvals/ApprovalQueue";

const defaultBranchId = "00000000-0000-4000-8000-000000000001";
const defaultMechanicId = "00000000-0000-4000-8000-000000000002";

export function App() {
  const [session, setSession] = useState<TokenPairResponse | undefined>();
  const [workOrders, setWorkOrders] = useState<WorkOrderSummary[]>([]);
  const api = useMemo(
    () => createConsoleApiClient(session?.access_token),
    [session?.access_token],
  );

  useEffect(() => {
    document.title = ko.app.title;
  }, []);

  async function createWorkOrder(request: CreateWorkOrderRequest) {
    const response = await api.POST("/api/work-orders", { body: request });
    if (!response.data) {
      throw new Error("createWorkOrder response missing data");
    }
    return response.data;
  }

  async function assignWorkOrder(workOrderId: string, mechanicId: string) {
    const response = await api.PUT("/api/work-orders/{workOrderId}/assignments", {
      params: { path: { workOrderId } },
      body: {
        assignments: [{ mechanic_id: mechanicId, role: "PRIMARY" }],
      },
    });
    if (response.data) {
      upsertWorkOrder(response.data);
    }
  }

  async function approveWorkOrder(workOrderId: string) {
    const response = await api.POST("/api/work-orders/{workOrderId}/approve", {
      params: { path: { workOrderId } },
    });
    if (response.data) {
      upsertWorkOrder(response.data);
    }
  }

  function upsertWorkOrder(workOrder: WorkOrderSummary) {
    setWorkOrders((current) => {
      const withoutExisting = current.filter((item) => item.id !== workOrder.id);
      return [workOrder, ...withoutExisting];
    });
  }

  return (
    <main className="mx-auto grid max-w-7xl gap-5 px-4 py-5 sm:px-6 lg:px-8">
      <header className="grid gap-2">
        <h1 className="text-2xl font-bold text-slate-950">{ko.app.title}</h1>
        <p className="max-w-4xl text-sm leading-6 text-slate-700">
          {ko.app.apiContractGap}
        </p>
      </header>
      <section className="grid gap-5 xl:grid-cols-[minmax(280px,360px)_1fr]">
        <div className="grid content-start gap-5">
          <PasskeyLoginPage
            api={api}
            session={session}
            onSessionChange={setSession}
          />
          <IntakeForm
            branchId={defaultBranchId}
            equipmentLookupState={{ status: "unavailable" }}
            onCreateWorkOrder={createWorkOrder}
            onCreated={upsertWorkOrder}
          />
        </div>
        <div className="grid content-start gap-5">
          <DispatchBoard
            workOrders={workOrders}
            selectedMechanicId={defaultMechanicId}
            onAssignWorkOrder={assignWorkOrder}
          />
          <ApprovalQueue workOrders={workOrders} onApprove={approveWorkOrder} />
        </div>
      </section>
    </main>
  );
}
