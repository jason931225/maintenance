import { useState } from "react";

import type { components } from "@maintenance/api-client-ts";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";
import type { WorkOrderListItem } from "../../api/types";

type WorkResultType = components["schemas"]["WorkResultType"];

interface WorkOrderActionsProps {
  workOrders: WorkOrderListItem[];
  /** Called when the user starts work on a work order they are assigned to. */
  onStartWork: (workOrderId: string) => Promise<boolean>;
  /** Called when the user submits a report for an in-progress work order. */
  onSubmitReport: (
    workOrderId: string,
    resultType: WorkResultType,
    diagnosis: string,
    actionTaken: string,
  ) => Promise<boolean>;
  /** The current user's id — used to filter to orders assigned to this mechanic. */
  currentUserId?: string;
}

type ReportFormState = {
  workOrderId: string;
  resultType: WorkResultType;
  diagnosis: string;
  actionTaken: string;
};

const RESULT_TYPES: WorkResultType[] = [
  "COMPLETED",
  "TEMPORARY_ACTION",
  "INCOMPLETE",
  "REVISIT_REQUIRED",
  "UNKNOWN",
];

/**
 * Mechanic work-order action panel: start work (ASSIGNED → IN_PROGRESS) and
 * submit report (IN_PROGRESS → REPORT_SUBMITTED). Only shows work orders where
 * the current mechanic is the assigned primary worker.
 */
export function WorkOrderActions({
  workOrders,
  onStartWork,
  onSubmitReport,
  currentUserId,
}: WorkOrderActionsProps) {
  const [startPending, setStartPending] = useState<string | null>(null);
  const [startDone, setStartDone] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const [reportForm, setReportForm] = useState<ReportFormState | null>(null);
  const [reportPending, setReportPending] = useState(false);
  const [reportDone, setReportDone] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<{
    diagnosis?: string;
    actionTaken?: string;
  }>({});

  // Filter to orders the mechanic can act on:
  // - ASSIGNED: can start work
  // - IN_PROGRESS: can submit report
  // Show all actionable orders when no currentUserId is set; otherwise filter
  // to orders where this mechanic appears in the assignments list.
  const actionableOrders = workOrders.filter(
    (wo) =>
      (wo.status === "ASSIGNED" || wo.status === "IN_PROGRESS") &&
      (!currentUserId ||
        wo.assignments.some((a) => a.mechanic_id === currentUserId)),
  );

  // Keep the panel mounted while a report-submit confirmation is pending, even
  // if the submitted order has already left the actionable list.
  if (actionableOrders.length === 0 && !reportDone) return null;

  async function handleStartWork(workOrderId: string) {
    setStartPending(workOrderId);
    setStartDone(null);
    setStartError(null);
    const ok = await onStartWork(workOrderId);
    setStartPending(null);
    if (ok) {
      setStartDone(workOrderId);
    } else {
      setStartError(workOrderId);
    }
  }

  function openReportForm(workOrderId: string) {
    setReportForm({
      workOrderId,
      resultType: "COMPLETED",
      diagnosis: "",
      actionTaken: "",
    });
    setReportDone(null);
    setReportError(null);
    setFormErrors({});
  }

  async function handleSubmitReport() {
    if (!reportForm) return;
    const errors: { diagnosis?: string; actionTaken?: string } = {};
    if (!reportForm.diagnosis.trim()) {
      errors.diagnosis = ko.workOrder.requiredDiagnosis;
    }
    if (!reportForm.actionTaken.trim()) {
      errors.actionTaken = ko.workOrder.requiredActionTaken;
    }
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }
    setReportPending(true);
    setReportError(null);
    const ok = await onSubmitReport(
      reportForm.workOrderId,
      reportForm.resultType,
      reportForm.diagnosis.trim(),
      reportForm.actionTaken.trim(),
    );
    setReportPending(false);
    if (ok) {
      setReportDone(reportForm.workOrderId);
      setReportForm(null);
    } else {
      setReportError(reportForm.workOrderId);
    }
  }

  return (
    <Card className="grid gap-4">
      <h2 className="text-lg font-semibold text-ink">
        {ko.workOrder.startWork} / {ko.workOrder.submitReport}
      </h2>
      <div className="grid gap-3">
        {actionableOrders.map((wo) => (
          <div
            key={wo.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3"
          >
            <div>
              <p className="font-semibold text-ink">{wo.request_no}</p>
              <p className="text-sm text-steel">
                {ko.status[wo.status]} · {wo.equipment.model ?? ko.common.unknown}
              </p>
            </div>
            <div className="flex gap-2">
              {wo.status === "ASSIGNED" && (
                <Button
                  type="button"
                  size="sm"
                  disabled={startPending === wo.id}
                  onClick={() => { void handleStartWork(wo.id); }}
                >
                  {startPending === wo.id
                    ? ko.workOrder.startWorking
                    : ko.workOrder.startWork}
                </Button>
              )}
              {wo.status === "IN_PROGRESS" && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => { openReportForm(wo.id); }}
                >
                  {ko.workOrder.submitReport}
                </Button>
              )}
            </div>
            {startDone === wo.id && (
              <p role="status" className="w-full text-sm font-medium text-brand-teal">
                {ko.workOrder.startWorkDone}
              </p>
            )}
            {startError === wo.id && (
              <p role="alert" className="w-full text-sm font-medium text-red-700">
                {ko.workOrder.startWorkFailed}
              </p>
            )}
            {reportError === wo.id && (
              <p role="alert" className="w-full text-sm font-medium text-red-700">
                {ko.workOrder.submitReportFailed}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Report-submit confirmation lives at the panel level: a submitted order
          transitions to REPORT_SUBMITTED and leaves the actionable list, so a
          per-card message would unmount before the user (or a test) can see it. */}
      {reportDone && (
        <p role="status" className="text-sm font-medium text-brand-teal">
          {ko.workOrder.submitReportDone}
        </p>
      )}

      {/* Inline report form */}
      {reportForm && (
        <div className="grid gap-3 rounded-md border border-line p-4">
          <h3 className="text-sm font-semibold text-ink">
            {ko.workOrder.submitReport}
          </h3>

          <div className="grid gap-1">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="report-result-type"
            >
              {ko.workOrder.resultTypeLabel}
            </label>
            <select
              id="report-result-type"
              className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-signal"
              value={reportForm.resultType}
              onChange={(e) => {
                setReportForm((f) =>
                  f ? { ...f, resultType: e.target.value as WorkResultType } : f,
                );
              }}
            >
              {RESULT_TYPES.map((rt) => (
                <option key={rt} value={rt}>
                  {ko.workOrder.resultTypes[rt]}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-1">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="report-diagnosis"
            >
              {ko.workOrder.diagnosisLabel}
            </label>
            <textarea
              id="report-diagnosis"
              rows={3}
              className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-steel focus:outline-none focus:ring-2 focus:ring-signal"
              placeholder={ko.workOrder.diagnosisPlaceholder}
              aria-invalid={formErrors.diagnosis ? true : undefined}
              aria-describedby={
                formErrors.diagnosis ? "report-diagnosis-error" : undefined
              }
              value={reportForm.diagnosis}
              onChange={(e) => {
                setReportForm((f) =>
                  f ? { ...f, diagnosis: e.target.value } : f,
                );
                setFormErrors((err) => ({ ...err, diagnosis: undefined }));
              }}
            />
            {formErrors.diagnosis && (
              <p
                id="report-diagnosis-error"
                role="alert"
                className="text-sm font-medium text-red-700"
              >
                {formErrors.diagnosis}
              </p>
            )}
          </div>

          <div className="grid gap-1">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="report-action-taken"
            >
              {ko.workOrder.actionTakenLabel}
            </label>
            <textarea
              id="report-action-taken"
              rows={3}
              className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-steel focus:outline-none focus:ring-2 focus:ring-signal"
              placeholder={ko.workOrder.actionTakenPlaceholder}
              aria-invalid={formErrors.actionTaken ? true : undefined}
              aria-describedby={
                formErrors.actionTaken ? "report-action-taken-error" : undefined
              }
              value={reportForm.actionTaken}
              onChange={(e) => {
                setReportForm((f) =>
                  f ? { ...f, actionTaken: e.target.value } : f,
                );
                setFormErrors((err) => ({ ...err, actionTaken: undefined }));
              }}
            />
            {formErrors.actionTaken && (
              <p
                id="report-action-taken-error"
                role="alert"
                className="text-sm font-medium text-red-700"
              >
                {formErrors.actionTaken}
              </p>
            )}
          </div>

          {reportError && (
            <p role="alert" className="text-sm font-medium text-red-700">
              {ko.workOrder.submitReportFailed}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              disabled={reportPending}
              onClick={() => { void handleSubmitReport(); }}
            >
              {reportPending
                ? ko.workOrder.submittingReport
                : ko.workOrder.submitReport}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={reportPending}
              onClick={() => { setReportForm(null); }}
            >
              {ko.dispatch.controls.cancel}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
