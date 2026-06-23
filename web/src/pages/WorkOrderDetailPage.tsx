import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import type { components } from "@maintenance/api-client-ts";
import type { WorkOrderDetail as WorkOrderDetailData } from "../api/types";
import { useAuth } from "../context/auth";
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { WorkOrderDetail } from "../features/dispatch/WorkOrderDetail";
import { ko } from "../i18n/ko";

type WorkResultType = components["schemas"]["WorkResultType"];

type LoadState =
  | { status: "loading" }
  | { status: "ready"; workOrder: WorkOrderDetailData }
  | { status: "notFound" }
  | { status: "forbidden" }
  | { status: "error" };

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

  const roles = session?.roles ?? [];
  const isMechanic = roles.includes("MECHANIC");

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
        />
      ) : null}
    </>
  );
}
