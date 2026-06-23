import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import type { components } from "@maintenance/api-client-ts";
import type { UserSummary, WorkOrderListItem } from "../api/types";
type WorkResultType = components["schemas"]["WorkResultType"];
import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { DispatchBoard } from "../features/dispatch/DispatchBoard";
import { WorkOrderList } from "../features/dispatch/WorkOrderList";
import { WorkOrderFilters } from "../features/dispatch/WorkOrderFilters";
import {
  EMPTY_WORK_ORDER_FILTERS,
  matchesWorkOrderQuery,
} from "../features/dispatch/workOrderQuery";
import type { WorkOrderFilterState } from "../features/dispatch/workOrderQuery";
import { WorkOrderDispatchControls } from "../features/dispatch/WorkOrderDispatchControls";
import type { MechanicAssignmentInput } from "../features/dispatch/WorkOrderDispatchControls";
import { MechanicDispatchOffers } from "../features/dispatch/MechanicDispatchOffers";
import { WorkOrderActions } from "../features/dispatch/WorkOrderActions";
import { ko } from "../i18n/ko";

type P1DispatchSummary = components["schemas"]["P1DispatchSummary"];
type DispatchResponseKind = components["schemas"]["DispatchResponseKind"];
type PriorityLevel = WorkOrderListItem["priority"];

type ReadState = "idle" | "loading" | "error";
type WriteState = "idle" | "error";

const ADMIN_ROLES = ["ADMIN", "SUPER_ADMIN"];

const WORK_ORDER_PAGE_SIZE = 100;

export function DispatchPage() {
  const { api, session } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [workOrders, setWorkOrders] = useState<WorkOrderListItem[]>([]);
  const [workOrderTotal, setWorkOrderTotal] = useState<number | undefined>(
    undefined,
  );
  const [filters, setFilters] = useState<WorkOrderFilterState>(
    EMPTY_WORK_ORDER_FILTERS,
  );
  const [mechanics, setMechanics] = useState<UserSummary[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [selectedWorkOrderId, setSelectedWorkOrderId] = useState<
    string | undefined
  >(undefined);
  // The most recently looked-up dispatch. Shared so a manager can force-assign
  // the same dispatch the offers panel surfaced (there is no list endpoint).
  const [activeDispatch, setActiveDispatch] = useState<
    P1DispatchSummary | undefined
  >(undefined);

  const roles = session?.roles ?? [];
  const isManager = roles.some((role) => ADMIN_ROLES.includes(role));
  const isMechanic = roles.includes("MECHANIC");

  // The list endpoint accepts `status[]` / `priority[]` server-side; the free-text
  // query is applied client-side over the loaded rows (no such backend param).
  const serverFilterQuery = useMemo(
    () => ({
      ...(filters.status ? { status: [filters.status] } : {}),
      ...(filters.priority ? { priority: [filters.priority] } : {}),
    }),
    [filters.status, filters.priority],
  );

  const loadData = useCallback(async () => {
    setReadState("loading");
    const response = await api
      .GET("/api/v1/work-orders", {
        params: {
          query: {
            limit: WORK_ORDER_PAGE_SIZE,
            offset: 0,
            ...serverFilterQuery,
          },
        },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setReadState("error");
      return;
    }
    setWorkOrders(response.data.items);
    setWorkOrderTotal(response.data.total);
    setReadState("idle");
  }, [api, serverFilterQuery]);

  const loadMoreWorkOrders = useCallback(async () => {
    setLoadingMore(true);
    const response = await api
      .GET("/api/v1/work-orders", {
        params: {
          query: {
            limit: WORK_ORDER_PAGE_SIZE,
            offset: workOrders.length,
            ...serverFilterQuery,
          },
        },
      })
      .catch(() => undefined);
    if (response?.data) {
      setWorkOrders((current) => [...current, ...response.data.items]);
      setWorkOrderTotal(response.data.total);
    }
    setLoadingMore(false);
  }, [api, workOrders.length, serverFilterQuery]);

  const loadMechanics = useCallback(async () => {
    // Managers pick a specific mechanic to assign; only they can read the roster
    // and only they need it for the controls panel.
    if (!isManager) return;
    const response = await api
      .GET("/api/v1/users", { params: { query: { include_inactive: false } } })
      .catch(() => undefined);
    if (response?.data) {
      setMechanics(
        response.data.items.filter((user) => user.roles.includes("MECHANIC")),
      );
    }
  }, [api, isManager]);

  useEffect(() => {
    void Promise.resolve().then(loadData);
  }, [loadData]);

  // Deep-link support: `/dispatch?wo={id}` (e.g. the intake success link) opens
  // the work-order detail view directly.
  const deepLinkWorkOrderId = searchParams.get("wo");
  useEffect(() => {
    if (deepLinkWorkOrderId) {
      void navigate(`/work-orders/${deepLinkWorkOrderId}`, { replace: true });
    }
  }, [deepLinkWorkOrderId, navigate]);

  useEffect(() => {
    void Promise.resolve().then(loadMechanics);
  }, [loadMechanics]);

  async function assignWorkOrder(
    workOrderId: string,
    mechanicId: string,
  ): Promise<boolean> {
    setWriteState("idle");
    // A mechanic without manager authority cannot use the manager-only
    // assignment endpoint (AssigneeManage is denied to MECHANIC). The authorized
    // self-service action on an unassigned order is claim-and-start: starting the
    // work records the mechanic as the primary assignee (RECEIVED → IN_PROGRESS).
    if (isMechanic && !isManager) {
      return startWork(workOrderId);
    }
    // Never issue an assignment with an empty mechanic id (no signed-in user id).
    if (!mechanicId) {
      setWriteState("error");
      return false;
    }
    return assignMechanics(workOrderId, [
      { mechanic_id: mechanicId, role: "PRIMARY" },
    ]);
  }

  async function assignMechanics(
    workOrderId: string,
    assignments: MechanicAssignmentInput[],
  ): Promise<boolean> {
    setWriteState("idle");
    if (assignments.length === 0) {
      setWriteState("error");
      return false;
    }
    try {
      const response = await api.PUT(
        "/api/work-orders/{workOrderId}/assignments",
        {
          params: { path: { workOrderId } },
          body: { assignments },
        },
      );
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

  async function setPriority(
    workOrderId: string,
    priority: PriorityLevel,
  ): Promise<boolean> {
    setWriteState("idle");
    try {
      const response = await api.PATCH(
        "/api/work-orders/{workOrderId}/priority",
        {
          params: { path: { workOrderId } },
          body: { priority },
        },
      );
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

  async function requestSchedule(
    workOrderId: string,
    targetDueAt: string,
    reason: string,
  ): Promise<boolean> {
    setWriteState("idle");
    try {
      const response = await api.POST(
        "/api/work-orders/{workOrderId}/target-change-requests",
        {
          params: { path: { workOrderId } },
          body: { requested_target_due_at: targetDueAt, reason },
        },
      );
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

  async function startWork(workOrderId: string): Promise<boolean> {
    setWriteState("idle");
    try {
      const response = await api.POST("/api/work-orders/{workOrderId}/start", {
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

  async function submitReport(
    workOrderId: string,
    resultType: WorkResultType,
    diagnosis: string,
    actionTaken: string,
  ): Promise<boolean> {
    setWriteState("idle");
    try {
      const response = await api.POST(
        "/api/work-orders/{workOrderId}/report",
        {
          params: { path: { workOrderId } },
          body: { result_type: resultType, diagnosis, action_taken: actionTaken },
        },
      );
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

  async function forceAssign(
    dispatchId: string,
    mechanicId: string,
  ): Promise<boolean> {
    setWriteState("idle");
    try {
      const response = await api.POST(
        "/api/v1/p1-dispatches/{dispatchId}/force-assign",
        {
          params: { path: { dispatchId } },
          body: { mechanic_id: mechanicId },
        },
      );
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

  async function startP1Dispatch(workOrderId: string): Promise<boolean> {
    setWriteState("idle");
    try {
      const response = await api.POST(
        "/api/v1/work-orders/{workOrderId}/p1-dispatch",
        {
          params: { path: { workOrderId } },
          body: { include_region: false },
        },
      );
      if (!response.data) {
        setWriteState("error");
        return false;
      }
      setActiveDispatch(response.data);
      await loadData();
      return true;
    } catch {
      setWriteState("error");
      return false;
    }
  }

  async function createOutsourceWork(
    workOrderId: string,
    vendorName: string,
    vendorContact: string,
    reason: string,
  ): Promise<boolean> {
    setWriteState("idle");
    try {
      const response = await api.POST(
        "/api/work-orders/{workOrderId}/outsource-works",
        {
          params: { path: { workOrderId } },
          body: {
            vendor_name: vendorName,
            vendor_contact: vendorContact || undefined,
            reason,
          },
        },
      );
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

  const lookupDispatch = useCallback(
    async (dispatchId: string): Promise<P1DispatchSummary | undefined> => {
      const response = await api
        .GET("/api/v1/p1-dispatches/{dispatchId}", {
          params: { path: { dispatchId } },
        })
        .catch(() => undefined);
      setActiveDispatch(response?.data);
      return response?.data;
    },
    [api],
  );

  const respondDispatch = useCallback(
    async (
      dispatchId: string,
      response: DispatchResponseKind,
    ): Promise<P1DispatchSummary | undefined> => {
      const result = await api
        .POST("/api/v1/p1-dispatches/{dispatchId}/responses", {
          params: { path: { dispatchId } },
          body: { response },
        })
        .catch(() => undefined);
      return result?.data;
    },
    [api],
  );

  const selectedWorkOrder = useMemo(
    () => workOrders.find((order) => order.id === selectedWorkOrderId),
    [workOrders, selectedWorkOrderId],
  );

  // Client-side free-text filter (request_no / customer / equipment-no) over the
  // loaded rows for the searchable list view. Status/priority are already
  // applied server-side via the list query params.
  const filteredWorkOrders = useMemo(
    () =>
      workOrders.filter((order) => matchesWorkOrderQuery(order, filters.query)),
    [workOrders, filters.query],
  );

  // A dispatch can be force-assigned while it is still resolving (broadcasting)
  // or escalated to a manager. Only surface it for the matching work order.
  const forceAssignDispatchId =
    activeDispatch &&
    activeDispatch.work_order_id === selectedWorkOrderId &&
    activeDispatch.status !== "AUTO_ASSIGNED"
      ? activeDispatch.id
      : undefined;

  return (
    <>
      <PageHeader
        title={ko.dispatch.title}
        description={ko.dispatch.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadData();
            }}
            isLoading={readState === "loading"}
          />
        }
      />
      <div className="grid gap-5">
        {readState === "error" ? (
          <PageError onRetry={() => { void loadData(); }} />
        ) : null}
        {writeState === "error" ? (
          <PageError message={ko.common.writeFailed} />
        ) : null}
        <WorkOrderFilters
          value={filters}
          onChange={setFilters}
          onReset={() => {
            setFilters(EMPTY_WORK_ORDER_FILTERS);
          }}
        />
        <WorkOrderList
          workOrders={filteredWorkOrders}
          isLoading={readState === "loading"}
          // While a free-text query is active the loaded rows are filtered
          // client-side, so the server total / load-more no longer describe the
          // visible set — hide them to keep the count honest.
          total={filters.query.trim() ? undefined : workOrderTotal}
          onLoadMore={
            filters.query.trim()
              ? undefined
              : () => {
                  void loadMoreWorkOrders();
                }
          }
          isLoadingMore={loadingMore}
          emptyMessage={
            filters.query.trim() ? ko.dispatch.search.noMatches : undefined
          }
        />
        <DispatchBoard
          workOrders={filteredWorkOrders}
          selectedMechanicId={session?.user_id ?? ""}
          selectedMechanicName={session?.display_name}
          isLoading={readState === "loading"}
          onAssignWorkOrder={assignWorkOrder}
          onSelectWorkOrder={isManager ? setSelectedWorkOrderId : undefined}
          selectedWorkOrderId={selectedWorkOrderId}
        />

        {isManager && selectedWorkOrder ? (
          <WorkOrderDispatchControls
            workOrder={selectedWorkOrder}
            mechanics={mechanics}
            forceAssignDispatchId={forceAssignDispatchId}
            onSetPriority={setPriority}
            onRequestSchedule={requestSchedule}
            onAssign={assignMechanics}
            onForceAssign={forceAssign}
            onStartP1Dispatch={startP1Dispatch}
            onCreateOutsourceWork={createOutsourceWork}
          />
        ) : null}

        {isMechanic ? (
          <WorkOrderActions
            workOrders={workOrders}
            onStartWork={startWork}
            onSubmitReport={submitReport}
            currentUserId={session?.user_id}
          />
        ) : null}

        {isMechanic || isManager ? (
          <MechanicDispatchOffers
            onLookup={lookupDispatch}
            onRespond={respondDispatch}
            readOnly={!isMechanic}
          />
        ) : null}
      </div>
    </>
  );
}
