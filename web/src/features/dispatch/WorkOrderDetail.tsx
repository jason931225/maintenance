import { useState } from "react";

import type { components } from "@maintenance/api-client-ts";
import type { WorkOrderDetail as WorkOrderDetailData } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { priorityClass, priorityLabel, safeLabel } from "../../lib/utils";
import { SUCCESS_DISMISS_MS, useAutoDismiss } from "../../lib/useAutoDismiss";
import { EvidenceUpload } from "./EvidenceUpload";
import { WorkOrderEvidenceList } from "./WorkOrderEvidenceList";

type WorkResultType = components["schemas"]["WorkResultType"];

const RESULT_TYPES: WorkResultType[] = [
  "COMPLETED",
  "TEMPORARY_ACTION",
  "INCOMPLETE",
  "REVISIT_REQUIRED",
  "UNKNOWN",
];

interface WorkOrderDetailProps {
  workOrder: WorkOrderDetailData;
  /** Whether the viewer may start work on / report this order (assigned mechanic). */
  canAct: boolean;
  /** Whether the viewer may attach evidence (assigned mechanic). */
  canUploadEvidence: boolean;
  onStartWork: (workOrderId: string) => Promise<boolean>;
  onSubmitReport: (
    workOrderId: string,
    resultType: WorkResultType,
    diagnosis: string,
    actionTaken: string,
  ) => Promise<boolean>;
}

type ReportFormState = {
  resultType: WorkResultType;
  diagnosis: string;
  actionTaken: string;
};

/**
 * Work-order detail view rendered from GET /api/v1/work-orders/{id}. The mechanic
 * finally sees the reported SYMPTOM + customer_request alongside the diagnose /
 * report controls (the previously broken loop). Read-only for any WorkOrderReadAll
 * holder; the start/report/EvidenceUpload write controls only render when `canAct`
 * / `canUploadEvidence` (the assigned mechanic), so the read view never widens
 * write access.
 */
export function WorkOrderDetail({
  workOrder,
  canAct,
  canUploadEvidence,
  onStartWork,
  onSubmitReport,
}: WorkOrderDetailProps) {
  const t = ko.workOrder.detail;
  const primary = workOrder.assignments.find((a) => a.role === "PRIMARY");

  const [startPending, setStartPending] = useState(false);
  const [startDone, setStartDone] = useState<string | null>(null);
  const [startError, setStartError] = useState(false);
  const [reportForm, setReportForm] = useState<ReportFormState | null>(null);
  const [reportPending, setReportPending] = useState(false);
  const [reportDone, setReportDone] = useState<string | null>(null);
  const [reportError, setReportError] = useState(false);
  const [formErrors, setFormErrors] = useState<{
    diagnosis?: string;
    actionTaken?: string;
  }>({});

  // `useAutoDismiss` holds the clear callback in a ref, so a fresh function
  // identity each render is harmless — no useCallback needed (and avoids the
  // React Compiler manual-memoization mismatch on the stable setState setters).
  useAutoDismiss(
    startDone,
    () => {
      setStartDone(null);
    },
    SUCCESS_DISMISS_MS,
  );
  useAutoDismiss(
    reportDone,
    () => {
      setReportDone(null);
    },
    SUCCESS_DISMISS_MS,
  );

  async function handleStartWork() {
    setStartPending(true);
    setStartDone(null);
    setStartError(false);
    const ok = await onStartWork(workOrder.id);
    setStartPending(false);
    if (ok) setStartDone(workOrder.id);
    else setStartError(true);
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
    setReportError(false);
    const ok = await onSubmitReport(
      workOrder.id,
      reportForm.resultType,
      reportForm.diagnosis.trim(),
      reportForm.actionTaken.trim(),
    );
    setReportPending(false);
    if (ok) {
      setReportDone(workOrder.id);
      setReportForm(null);
    } else {
      setReportError(true);
    }
  }

  return (
    <div className="grid gap-5">
      <Card className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-steel">{t.requestNo}</p>
            <p className="text-xl font-semibold text-ink">
              {workOrder.request_no}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={priorityClass(workOrder.priority)}>
              {priorityLabel(workOrder.priority)}
            </Badge>
            <Badge>{ko.status[workOrder.status]}</Badge>
          </div>
        </div>

        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label={t.equipment}>
            {workOrder.equipment.model ?? ko.common.unknown}
            {workOrder.equipment.management_no
              ? ` (#${workOrder.equipment.management_no})`
              : ""}
          </Field>
          <Field label={t.targetDueAt}>
            {workOrder.target_due_at
              ? formatKoreanDateTime(workOrder.target_due_at)
              : ko.common.notSet}
          </Field>
          <Field label={t.customer}>{safeLabel(workOrder.customer.name)}</Field>
          <Field label={t.site}>{safeLabel(workOrder.site.name)}</Field>
          <Field label={t.assignee}>
            {primary ? safeLabel(primary.mechanic_name) : t.noAssignee}
          </Field>
        </dl>

        {/* Site contact + directions. The work-order/site payload (NamedEntity)
            carries no address/coordinates, so the directions (gilchatgi) link is
            deferred with a note until the backend adds a geocoded site
            address/lat-lon. */}
        {workOrder.site_contact?.phone ? (
          <p className="text-sm text-steel">
            {ko.dispatch.siteContact}:{" "}
            {safeLabel(workOrder.site_contact.name)}{" "}
            <a
              className="text-steel underline-offset-2 hover:underline"
              href={`tel:${workOrder.site_contact.phone}`}
            >
              {workOrder.site_contact.phone}
            </a>
          </p>
        ) : null}
        <p className="text-xs text-steel">{t.directionsUnavailable}</p>
      </Card>

      {/* The reported symptom + customer request — the data the mechanic was
          previously diagnosing without. */}
      <Card className="grid gap-3">
        <div>
          <p className="text-sm font-semibold text-steel">{t.symptom}</p>
          <p className="whitespace-pre-wrap text-ink">{workOrder.symptom}</p>
        </div>
        {workOrder.customer_request ? (
          <div>
            <p className="text-sm font-semibold text-steel">
              {t.customerRequest}
            </p>
            <p className="whitespace-pre-wrap text-ink">
              {workOrder.customer_request}
            </p>
          </div>
        ) : null}
        {workOrder.diagnosis ? (
          <div>
            <p className="text-sm font-semibold text-steel">{t.diagnosis}</p>
            <p className="whitespace-pre-wrap text-ink">{workOrder.diagnosis}</p>
          </div>
        ) : null}
        {workOrder.action_taken ? (
          <div>
            <p className="text-sm font-semibold text-steel">{t.actionTaken}</p>
            <p className="whitespace-pre-wrap text-ink">
              {workOrder.action_taken}
            </p>
          </div>
        ) : null}
      </Card>

      {/* Write controls — only the assigned mechanic. Read-only viewers
          (receptionist, admin) never see these. */}
      {canAct ? (
        <Card className="grid gap-3">
          <h2 className="text-lg font-semibold text-ink">
            {ko.workOrder.startWork} / {ko.workOrder.submitReport}
          </h2>
          <div className="flex flex-wrap gap-2">
            {workOrder.status === "ASSIGNED" ? (
              <Button
                type="button"
                size="sm"
                disabled={startPending}
                onClick={() => {
                  void handleStartWork();
                }}
              >
                {startPending
                  ? ko.workOrder.startWorking
                  : ko.workOrder.startWork}
              </Button>
            ) : null}
            {workOrder.status === "IN_PROGRESS" ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setReportForm({
                    resultType: "COMPLETED",
                    diagnosis: "",
                    actionTaken: "",
                  });
                  setReportDone(null);
                  setReportError(false);
                  setFormErrors({});
                }}
              >
                {ko.workOrder.submitReport}
              </Button>
            ) : null}
          </div>
          {startDone ? (
            <p role="status" className="text-sm font-medium text-brand-teal">
              {ko.workOrder.startWorkDone}
            </p>
          ) : null}
          {startError ? (
            <p role="alert" className="text-sm font-medium text-red-700">
              {ko.workOrder.startWorkFailed}
            </p>
          ) : null}
          {reportDone ? (
            <p role="status" className="text-sm font-medium text-brand-teal">
              {ko.workOrder.submitReportDone}
            </p>
          ) : null}

          {reportForm ? (
            <div className="grid gap-3 rounded-md border border-line p-4">
              <h3 className="text-sm font-semibold text-ink">
                {ko.workOrder.submitReport}
              </h3>
              <div className="grid gap-1">
                <label
                  className="text-sm font-medium text-steel"
                  htmlFor="detail-result-type"
                >
                  {ko.workOrder.resultTypeLabel}
                </label>
                <select
                  id="detail-result-type"
                  className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-signal"
                  value={reportForm.resultType}
                  onChange={(e) => {
                    setReportForm((f) =>
                      f
                        ? { ...f, resultType: e.target.value as WorkResultType }
                        : f,
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
                  htmlFor="detail-diagnosis"
                >
                  {ko.workOrder.diagnosisLabel}
                </label>
                <textarea
                  id="detail-diagnosis"
                  rows={3}
                  className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-steel focus:outline-none focus:ring-2 focus:ring-signal"
                  placeholder={ko.workOrder.diagnosisPlaceholder}
                  aria-invalid={formErrors.diagnosis ? true : undefined}
                  aria-describedby={
                    formErrors.diagnosis ? "detail-diagnosis-error" : undefined
                  }
                  value={reportForm.diagnosis}
                  onChange={(e) => {
                    setReportForm((f) =>
                      f ? { ...f, diagnosis: e.target.value } : f,
                    );
                    setFormErrors((err) => ({ ...err, diagnosis: undefined }));
                  }}
                />
                {formErrors.diagnosis ? (
                  <p
                    id="detail-diagnosis-error"
                    role="alert"
                    className="text-sm font-medium text-red-700"
                  >
                    {formErrors.diagnosis}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1">
                <label
                  className="text-sm font-medium text-steel"
                  htmlFor="detail-action-taken"
                >
                  {ko.workOrder.actionTakenLabel}
                </label>
                <textarea
                  id="detail-action-taken"
                  rows={3}
                  className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-steel focus:outline-none focus:ring-2 focus:ring-signal"
                  placeholder={ko.workOrder.actionTakenPlaceholder}
                  aria-invalid={formErrors.actionTaken ? true : undefined}
                  aria-describedby={
                    formErrors.actionTaken
                      ? "detail-action-taken-error"
                      : undefined
                  }
                  value={reportForm.actionTaken}
                  onChange={(e) => {
                    setReportForm((f) =>
                      f ? { ...f, actionTaken: e.target.value } : f,
                    );
                    setFormErrors((err) => ({ ...err, actionTaken: undefined }));
                  }}
                />
                {formErrors.actionTaken ? (
                  <p
                    id="detail-action-taken-error"
                    role="alert"
                    className="text-sm font-medium text-red-700"
                  >
                    {formErrors.actionTaken}
                  </p>
                ) : null}
              </div>
              {reportError ? (
                <p role="alert" className="text-sm font-medium text-red-700">
                  {ko.workOrder.submitReportFailed}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={reportPending}
                  onClick={() => {
                    void handleSubmitReport();
                  }}
                >
                  {reportPending
                    ? ko.workOrder.submittingReport
                    : ko.workOrder.submitReport}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={reportPending}
                  onClick={() => {
                    setReportForm(null);
                  }}
                >
                  {ko.dispatch.controls.cancel}
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* Evidence: read-only list for everyone; the upload affordance only for
          the assigned mechanic, surfaced WITH the symptom in view. */}
      <Card className="grid gap-3">
        <h2 className="text-lg font-semibold text-ink">{t.evidenceTitle}</h2>
        <WorkOrderEvidenceList evidence={workOrder.evidence} />
        {canUploadEvidence ? <EvidenceUpload workOrderId={workOrder.id} /> : null}
      </Card>

      {/* Status-history timeline (KST). */}
      <Card className="grid gap-3">
        <h2 className="text-lg font-semibold text-ink">{t.historyTitle}</h2>
        {workOrder.status_history.length === 0 ? (
          <p className="text-sm text-steel">{t.historyEmpty}</p>
        ) : (
          <ol className="grid gap-2">
            {workOrder.status_history.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line p-2 text-sm"
              >
                <span className="font-medium text-ink">
                  {ko.status[entry.to_status]}
                </span>
                <span className="text-steel">
                  {formatKoreanDateTime(entry.occurred_at)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-semibold text-steel">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
