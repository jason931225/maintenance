import { useCallback, useEffect, useMemo, useState } from "react";

import { createConsoleApiClient } from "./api/client";
import type {
  CreateWorkOrderRequest,
  EquipmentLookupResponse,
  EquipmentLookupState,
  KpiReport,
  TokenPairResponse,
  WorkOrderListItem,
} from "./api/types";
import { ko } from "./i18n/ko";
import { PasskeyLoginPage } from "./features/auth/PasskeyLoginPage";
import { IntakeForm } from "./features/intake/IntakeForm";
import { DispatchBoard } from "./features/dispatch/DispatchBoard";
import { WorkOrderList } from "./features/dispatch/WorkOrderList";
import { ApprovalQueue } from "./features/approvals/ApprovalQueue";
import { LocationConsentPanel } from "./features/location/LocationConsentPanel";
import { KpiDashboard } from "./features/kpi/KpiDashboard";
import { WallBoard } from "./features/kpi/WallBoard";
import { MessengerPanel } from "./features/messenger/MessengerPanel";
import {
  getDefaultKpiPeriod,
  getWallboardRefreshIntervalMs,
} from "./features/kpi/kpi-format";

const defaultBranchId = "00000000-0000-4000-8000-000000000001";
const defaultMechanicId = "00000000-0000-4000-8000-000000000002";
const approvalStatuses: WorkOrderListItem["status"][] = [
  "REPORT_SUBMITTED",
  "ADMIN_REVIEW",
];
type ReadState = "idle" | "loading" | "error";
type ReadyEquipmentLookup = Extract<
  EquipmentLookupState,
  { status: "ready" }
>["equipment"];

interface AppProps {
  initialSession?: TokenPairResponse;
}

export function App({ initialSession }: AppProps = {}) {
  const [session, setSession] = useState<TokenPairResponse | undefined>(
    initialSession,
  );
  const [workOrders, setWorkOrders] = useState<WorkOrderListItem[]>([]);
  const [approvalWorkOrders, setApprovalWorkOrders] = useState<
    WorkOrderListItem[]
  >([]);
  const [kpiReport, setKpiReport] = useState<KpiReport>();
  const [kpiPeriod, setKpiPeriod] = useState(getDefaultKpiPeriod);
  const [readState, setReadState] = useState<ReadState>(
    initialSession ? "loading" : "idle",
  );
  const [managementNo, setManagementNo] = useState("");
  const [equipmentSuggestions, setEquipmentSuggestions] = useState<
    EquipmentLookupResponse[]
  >([]);
  const [equipmentLookupState, setEquipmentLookupState] =
    useState<EquipmentLookupState>({ status: "idle" });
  const api = useMemo(
    () => createConsoleApiClient(session?.access_token),
    [session?.access_token],
  );
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? window.location.origin;

  useEffect(() => {
    document.title = ko.app.title;
  }, []);

  const loadDashboardData = useCallback(async () => {
    const responses = await Promise.all([
      api.GET("/api/v1/work-orders", {
        params: { query: { limit: 100, offset: 0 } },
      }),
      api.GET("/api/v1/work-orders", {
        params: {
          query: { status: approvalStatuses, limit: 100, offset: 0 },
        },
      }),
      api.GET("/api/v1/kpi", {
        params: { query: { period: kpiPeriod } },
      }),
    ]).catch(() => undefined);

    if (!responses) {
      setReadState("error");
      return;
    }

    const [listResponse, approvalResponse, kpiResponse] = responses;

    if (!listResponse.data || !approvalResponse.data || !kpiResponse.data) {
      setReadState("error");
      return;
    }

    setWorkOrders(listResponse.data.items);
    setApprovalWorkOrders(approvalResponse.data.items);
    setKpiReport(kpiResponse.data);
    setReadState("idle");
  }, [api, kpiPeriod]);

  useEffect(() => {
    if (!session) {
      return undefined;
    }
    void Promise.resolve().then(loadDashboardData);
    return undefined;
  }, [loadDashboardData, session]);

  useEffect(() => {
    const query = managementNo.trim();
    let ignore = false;

    if (!query || !session) {
      return undefined;
    }

    async function loadEquipment() {
      const [autocompleteResponse, lookupResponse] = await Promise.all([
        api.GET("/api/v1/equipment", {
          params: { query: { q: query, limit: 5 } },
        }),
        api.GET("/api/v1/equipment/lookup", {
          params: { query: { management_no: query } },
        }),
      ]);

      if (ignore) {
        return;
      }

      setEquipmentSuggestions(autocompleteResponse.data?.items ?? []);
      if (lookupResponse.data) {
        setEquipmentLookupState({
          status: "ready",
          equipment: mapEquipmentLookup(lookupResponse.data),
        });
        return;
      }

      setEquipmentLookupState({ status: "notFound" });
    }

    loadEquipment().catch(() => {
      if (!ignore) {
        setEquipmentSuggestions([]);
        setEquipmentLookupState({ status: "error" });
      }
    });

    return () => {
      ignore = true;
    };
  }, [api, managementNo, session]);

  function handleSessionChange(nextSession?: TokenPairResponse) {
    setSession(nextSession);
    if (!nextSession) {
      setWorkOrders([]);
      setApprovalWorkOrders([]);
      setKpiReport(undefined);
      setReadState("idle");
      setEquipmentSuggestions([]);
      setEquipmentLookupState({ status: "idle" });
      return;
    }
    setReadState("loading");
  }

  function handleManagementNoChange(nextManagementNo: string) {
    setManagementNo(nextManagementNo);
    if (nextManagementNo.trim().length === 0 || !session) {
      setEquipmentSuggestions([]);
      setEquipmentLookupState({ status: "idle" });
      return;
    }
    setEquipmentLookupState({ status: "loading" });
  }

  function handleKpiPeriodChange(nextPeriod: string) {
    setKpiPeriod(nextPeriod);
    if (session) {
      setReadState("loading");
    }
  }

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
      await loadDashboardData();
    }
  }

  async function approveWorkOrder(workOrderId: string) {
    const response = await api.POST("/api/work-orders/{workOrderId}/approve", {
      params: { path: { workOrderId } },
    });
    if (response.data) {
      await loadDashboardData();
    }
  }

  async function rejectWorkOrder(workOrderId: string, memo: string) {
    const response = await api.POST("/api/v1/work-orders/{workOrderId}/reject", {
      params: { path: { workOrderId } },
      body: { memo },
    });
    if (response.data) {
      await loadDashboardData();
    }
  }

  if (window.location.pathname === "/wallboard") {
    return (
      <WallBoard
        isLoading={readState === "loading"}
        refreshIntervalMs={getWallboardRefreshIntervalMs()}
        report={kpiReport}
        workOrders={workOrders}
        onRefresh={loadDashboardData}
      />
    );
  }

  return (
    <main className="mx-auto grid max-w-7xl gap-5 px-4 py-5 sm:px-6 lg:px-8">
      <header className="grid gap-2">
        <h1 className="text-2xl font-bold text-slate-950">{ko.app.title}</h1>
        <p className="max-w-4xl text-sm leading-6 text-slate-700">
          {ko.app.readSurfaceReady}
        </p>
      </header>
      <section className="grid gap-5 xl:grid-cols-[minmax(280px,360px)_1fr]">
        <div className="grid content-start gap-5">
          <PasskeyLoginPage
            api={api}
            session={session}
            onSessionChange={handleSessionChange}
          />
          <LocationConsentPanel
            api={api}
            branchId={defaultBranchId}
            session={session}
          />
          <IntakeForm
            branchId={defaultBranchId}
            equipmentLookupState={equipmentLookupState}
            equipmentSuggestions={equipmentSuggestions}
            onManagementNoChange={handleManagementNoChange}
            onCreateWorkOrder={createWorkOrder}
            onCreated={() => {
              void loadDashboardData();
            }}
          />
        </div>
        <div className="grid content-start gap-5">
          {readState === "loading" ? (
            <p role="status" className="text-sm font-medium text-slate-700">
              {ko.common.loading}
            </p>
          ) : null}
          {readState === "error" ? (
            <p role="alert" className="text-sm font-semibold text-red-700">
              {ko.common.loadFailed}
            </p>
          ) : null}
          <WorkOrderList workOrders={workOrders} />
          <KpiDashboard
            isLoading={readState === "loading"}
            period={kpiPeriod}
            report={kpiReport}
            onPeriodChange={handleKpiPeriodChange}
          />
          <DispatchBoard
            workOrders={workOrders}
            selectedMechanicId={defaultMechanicId}
            onAssignWorkOrder={assignWorkOrder}
          />
          <MessengerPanel
            api={api}
            accessToken={session?.access_token}
            apiBaseUrl={apiBaseUrl}
          />
          <ApprovalQueue
            workOrders={approvalWorkOrders}
            onApprove={approveWorkOrder}
            onReject={rejectWorkOrder}
          />
        </div>
      </section>
    </main>
  );
}

function mapEquipmentLookup(
  equipment: EquipmentLookupResponse,
): ReadyEquipmentLookup {
  return {
    managementNo: equipment.management_no ?? equipment.equipment_no,
    model: equipment.model ?? ko.common.unknown,
    customerName: equipment.customer.name,
    siteName: equipment.site.name,
  };
}
