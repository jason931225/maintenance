import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import type { components } from "@maintenance/api-client-ts";
import type {
  UpdateWorkOrderIntakeRequest,
  UserSummary,
  WorkOrderDetail as WorkOrderDetailData,
} from "../api/types";
import { useAuth } from "../context/auth";
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { WorkOrderDetail } from "../features/dispatch/WorkOrderDetail";
import { WorkOrderDispatchControls } from "../features/dispatch/WorkOrderDispatchControls";
import type { MechanicAssignmentInput } from "../features/dispatch/WorkOrderDispatchControls";
import { ko } from "../i18n/ko";

type WorkResultType = components["schemas"]["WorkResultType"];
type P1DispatchSummary = components["schemas"]["P1DispatchSummary"];
type PriorityLevel = WorkOrderDetailData["priority"];

type LoadState =
  | { status: "loading" }
  | { status: "ready"; workOrder: WorkOrderDetailData }
  | { status: "notFound" }
  | { status: "forbidden" }
  | { status: "error" };

const ADMIN_ROLES = ["ADMIN", "SUPER_ADMIN"];
const INTAKE_EDIT_ROLES = ["RECEPTIONIST", "ADMIN", "EXECUTIVE", "SUPER_ADMIN"];

/**
 * Work-order detail page (`/work-orders/:id`). Fetches GET
 * /api/v1/work-orders/{id} so any WorkOrderReadAll holder (every authenticated
 * role) can open an order read-only — the receptionist/admin can finally answer
 * "is someone coming?" and the mechanic diagnoses WITH the reported symptom in
 * view. Write controls (start/report/evidence upload) only surface to the
 * assigned mechanic; the read view never widens write access.
 */
export function WorkOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { api, session } = useAuth();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [mechanics, setMechanics] = useState<UserSummary[]>([]);
  const [activeDispatch, setActiveDispatch] = useState<
    P1DispatchSummary | undefined
  >(undefined);

  const roles = session?.roles ?? [];
  const isMechanic = roles.includes("MECHANIC");
  const isManager = roles.some((role) => ADMIN_ROLES.includes(role));
  const canEditIntake = roles.some((role) => INTAKE_EDIT_ROLES.includes(role));

  const loadDetail = useCallback(async () => {
    if (!id) {
      setState({ status: "notFound" });
      return;
    }
    setState({ status: "loading" });
    const response = await api
      .GET("/api/v1/work-orders/{workOrderId}", {
        params: { path: { workOrderId: id } },
      })
      .catch(() => undefined);
    if (response?.data) {
      setState({ status: "ready", workOrder: response.data });
      return;
    }
    const httpStatus = response?.response.status;
    if (httpStatus === 403) {
      setState({ status: "forbidden" });
    } else if (httpStatus === 404) {
      setState({ status: "notFound" });
    } else {
      setState({ status: "error" });
    }
  }, [api, id]);

  useEffect(() => {
    // Defer the fetch off the render-effect tick so the initial setState
    // (loading) is not applied synchronously within the effect body.
    void Promise.resolve().then(loadDetail);
  }, [loadDetail]);

  const loadMechanics = useCallback(async () => {
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
    void Promise.resolve().then(loadMechanics);
  }, [loadMechanics]);

  async function startWork(workOrderId: string): Promise<boolean> {
    try {
      const response = await api.POST("/api/work-orders/{workOrderId}/start", {
        params: { path: { workOrderId } },
      });
      if (!response.data) return false;
      await loadDetail();
      return true;
    } catch {
      return false;
    }
  }

  async function submitReport(
    workOrderId: string,
    resultType: WorkResultType,
    diagnosis: string,
    actionTaken: string,
  ): Promise<boolean> {
    try {
      const response = await api.POST("/api/work-orders/{workOrderId}/report", {
        params: { path: { workOrderId } },
        body: { result_type: resultType, diagnosis, action_taken: actionTaken },
      });
      if (!response.data) return false;
      await loadDetail();
      return true;
    } catch {
      return false;
    }
  }

  async function updateWorkOrderIntake(
    workOrderId: string,
    symptom: string,
    customerRequest: string,
  ): Promise<boolean> {
    try {
      const body: UpdateWorkOrderIntakeRequest = {
        symptom,
        customer_request: customerRequest,
      };
      const response = await api.PATCH("/api/work-orders/{workOrderId}", {
        params: { path: { workOrderId } },
        body,
      });
      if (!response.data) return false;
      await loadDetail();
      return true;
    } catch {
      return false;
    }
  }

  async function setPriority(
    workOrderId: string,
    priority: PriorityLevel,
  ): Promise<boolean> {
    try {
      const response = await api.PATCH(
        "/api/work-orders/{workOrderId}/priority",
        {
          params: { path: { workOrderId } },
          body: { priority },
        },
      );
      if (!response.data) return false;
      if (priority === "P1") {
        const dispatchResponse = await api.POST(
          "/api/v1/work-orders/{workOrderId}/p1-dispatch",
          {
            params: { path: { workOrderId } },
            body: { include_region: false },
          },
        );
        if (!dispatchResponse.data) return false;
        setActiveDispatch(dispatchResponse.data);
      }
      await loadDetail();
      return true;
    } catch {
      return false;
    }
  }

  async function requestSchedule(
    workOrderId: string,
    targetDueAt: string,
    reason: string,
  ): Promise<boolean> {
    try {
      const response = await api.POST(
        "/api/work-orders/{workOrderId}/target-change-requests",
        {
          params: { path: { workOrderId } },
          body: { requested_target_due_at: targetDueAt, reason },
        },
      );
      if (!response.data) return false;
      await loadDetail();
      return true;
    } catch {
      return false;
    }
  }

  async function assignMechanics(
    workOrderId: string,
    assignments: MechanicAssignmentInput[],
  ): Promise<boolean> {
    if (assignments.length === 0) return false;
    try {
      const response = await api.PUT(
        "/api/work-orders/{workOrderId}/assignments",
        {
          params: { path: { workOrderId } },
          body: { assignments },
        },
      );
      if (!response.data) return false;
      await loadDetail();
      return true;
    } catch {
      return false;
    }
  }

  async function forceAssign(
    dispatchId: string,
    mechanicId: string,
  ): Promise<boolean> {
    try {
      const response = await api.POST(
        "/api/v1/p1-dispatches/{dispatchId}/force-assign",
        {
          params: { path: { dispatchId } },
          body: { mechanic_id: mechanicId },
        },
      );
      if (!response.data) return false;
      await loadDetail();
      return true;
    } catch {
      return false;
    }
  }

  async function startP1Dispatch(workOrderId: string): Promise<boolean> {
    try {
      const response = await api.POST(
        "/api/v1/work-orders/{workOrderId}/p1-dispatch",
        {
          params: { path: { workOrderId } },
          body: { include_region: false },
        },
      );
      if (!response.data) return false;
      setActiveDispatch(response.data);
      await loadDetail();
      return true;
    } catch {
      return false;
    }
  }

  async function createOutsourceWork(
    workOrderId: string,
    vendorName: string,
    vendorContact: string,
    reason: string,
  ): Promise<boolean> {
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
      if (!response.data) return false;
      await loadDetail();
      return true;
    } catch {
      return false;
    }
  }

  const t = ko.workOrder.detail;

  const backLink = (
    <Button variant="ghost" size="sm" asChild>
      <Link to="/dispatch">
        <ArrowLeft size={14} aria-hidden="true" />
        {t.back}
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <div className="flex items-center gap-2">
            {backLink}
            <RefreshButton
              onClick={() => {
                void loadDetail();
              }}
              isLoading={state.status === "loading"}
            />
          </div>
        }
      />

      {state.status === "loading" ? (
        <SkeletonTable rows={6} cols={2} />
      ) : null}

      {state.status === "error" ? (
        <PageError
          message={t.loadFailed}
          onRetry={() => {
            void loadDetail();
          }}
        />
      ) : null}

      {state.status === "forbidden" ? (
        <PageError message={t.forbidden} />
      ) : null}

      {state.status === "notFound" ? (
        <PageError message={t.notFound} />
      ) : null}

      {state.status === "ready" ? (
        <WorkOrderDetail
          workOrder={state.workOrder}
          // The assigned mechanic gets the start/report + upload controls. We
          // gate on MECHANIC role AND being in the assignment list so a manager
          // viewing the order does not get the mechanic self-service actions.
          canAct={
            isMechanic &&
            state.workOrder.assignments.some(
              (a) => a.mechanic_id === session?.user_id,
            )
          }
          canUploadEvidence={
            isMechanic &&
            state.workOrder.assignments.some(
              (a) => a.mechanic_id === session?.user_id,
            )
          }
          onStartWork={startWork}
          onSubmitReport={submitReport}
          canEditIntake={canEditIntake}
          onUpdateIntake={updateWorkOrderIntake}
          managerControls={
            isManager ? (
              <WorkOrderDispatchControls
                workOrder={state.workOrder}
                mechanics={mechanics}
                forceAssignDispatchId={
                  activeDispatch &&
                  activeDispatch.work_order_id === state.workOrder.id &&
                  activeDispatch.status !== "AUTO_ASSIGNED"
                    ? activeDispatch.id
                    : undefined
                }
                onSetPriority={setPriority}
                onRequestSchedule={requestSchedule}
                onAssign={assignMechanics}
                onForceAssign={forceAssign}
                onStartP1Dispatch={startP1Dispatch}
                onCreateOutsourceWork={createOutsourceWork}
              />
            ) : null
          }
        />
      ) : null}
    </>
  );
}
