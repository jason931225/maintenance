import { useState } from "react";

import type { UserSummary, WorkOrderListItem } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { FeedbackBanner } from "../../components/states/FeedbackBanner";
import { ko } from "../../i18n/ko";
import { useFeedback } from "../../lib/useAutoDismiss";
import { priorityLabel } from "../../lib/utils";

type PriorityLevel = WorkOrderListItem["priority"];

const PRIORITY_OPTIONS: PriorityLevel[] = [
  "P1",
  "P2",
  "P3",
  "OUTSOURCE",
  "UNSET",
];
const COMPACT_FIELD_CLASS = "min-h-8 px-2 py-1 text-xs";
const COMPACT_TEXTAREA_CLASS = "min-h-8 resize-none px-2 py-1 text-xs";
const COMPACT_SECTION_CLASS =
  "grid gap-1 rounded-lg border border-line bg-muted-panel/30 p-2";
const COMPACT_LABEL_CLASS = "text-xs font-medium text-steel";

export interface MechanicAssignmentInput {
  mechanic_id: string;
  role: "PRIMARY" | "SECONDARY";
}

export interface WorkOrderDispatchControlsProps {
  workOrder: WorkOrderListItem;
  mechanics: UserSummary[];
  /** Whether a P1 dispatch is awaiting a manager force-assign for this order. */
  forceAssignDispatchId?: string;
  onSetPriority: (
    workOrderId: string,
    priority: PriorityLevel,
  ) => Promise<boolean>;
  onRequestSchedule: (
    workOrderId: string,
    targetDueAt: string,
    reason: string,
  ) => Promise<boolean>;
  onAssign: (
    workOrderId: string,
    assignments: MechanicAssignmentInput[],
  ) => Promise<boolean>;
  onForceAssign: (dispatchId: string, mechanicId: string) => Promise<boolean>;
  /** Start a P1 emergency dispatch broadcast for this work order. */
  onStartP1Dispatch: (workOrderId: string) => Promise<boolean>;
  onCreateOutsourceWork: (
    workOrderId: string,
    vendorName: string,
    vendorContact: string,
    reason: string,
  ) => Promise<boolean>;
}

/**
 * Manager-only dispatch controls for a single work order: set priority,
 * request a schedule (target-due) change, assign one or many mechanics, and
 * force-assign an escalated P1 dispatch. Rendered only for ADMIN / SUPER_ADMIN;
 * the backend re-checks authorization on every call.
 */
export function WorkOrderDispatchControls({
  workOrder,
  mechanics,
  forceAssignDispatchId,
  onSetPriority,
  onRequestSchedule,
  onAssign,
  onForceAssign,
  onStartP1Dispatch,
  onCreateOutsourceWork,
}: WorkOrderDispatchControlsProps) {
  const t = ko.dispatch.controls;

  const [priority, setPriority] = useState<PriorityLevel>(workOrder.priority);
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleReason, setScheduleReason] = useState("");
  // Selected mechanics keyed by id -> role. A single PRIMARY plus any number of
  // SECONDARY entries is the multi-assign shape sent as the full Vec.
  const [selected, setSelected] = useState<Record<string, "PRIMARY" | "SECONDARY">>(
    {},
  );
  const [forceMechanicId, setForceMechanicId] = useState("");
  const [confirmingForce, setConfirmingForce] = useState(false);
  const [forcePending, setForcePending] = useState(false);
  const [startingP1, setStartingP1] = useState(false);
  const [outsourceVendor, setOutsourceVendor] = useState("");
  const [outsourceContact, setOutsourceContact] = useState("");
  const [outsourceReason, setOutsourceReason] = useState("");
  const [creatingOutsource, setCreatingOutsource] = useState(false);
  const [savingAll, setSavingAll] = useState(false);

  const { feedback, error, showFeedback, showError, clearFeedback, clearError } =
    useFeedback();

  const selectedAssignments: MechanicAssignmentInput[] = Object.entries(
    selected,
  ).map(([mechanic_id, role]) => ({ mechanic_id, role }));
  const hasSelectedAssignments = selectedAssignments.length > 0;
  const hasPrimaryAssignment = selectedAssignments.some(
    (assignment) => assignment.role === "PRIMARY",
  );
  const hasPriorityChange = priority !== workOrder.priority;
  const hasCompleteSchedule = Boolean(scheduleAt && scheduleReason.trim());
  const hasPartialSchedule =
    Boolean(scheduleAt || scheduleReason.trim()) && !hasCompleteSchedule;
  const controlsHeadingId = `dispatch-controls-${workOrder.id}`;

  async function handlePriority() {
    const ok = await onSetPriority(workOrder.id, priority);
    if (ok) showFeedback(t.priorityUpdated);
    else showError(t.actionFailed);
  }

  async function handleSchedule() {
    clearFeedback();
    if (!scheduleAt || !scheduleReason.trim()) {
      showError(t.actionFailed);
      return;
    }
    // datetime-local yields `YYYY-MM-DDTHH:mm`; send an RFC3339 instant.
    const iso = new Date(scheduleAt).toISOString();
    const ok = await onRequestSchedule(workOrder.id, iso, scheduleReason.trim());
    if (ok) {
      showFeedback(t.scheduleRequested);
      setScheduleAt("");
      setScheduleReason("");
    } else {
      showError(t.actionFailed);
    }
  }

  function toggleMechanic(id: string, role: "PRIMARY" | "SECONDARY") {
    setSelected((current) => {
      // Toggling the same role off clears this mechanic's selection.
      if (current[id] === role) {
        return Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== id),
        );
      }
      // Only one PRIMARY at a time: drop any existing PRIMARY when picking one.
      const cleared =
        role === "PRIMARY"
          ? Object.fromEntries(
              Object.entries(current).filter(([, value]) => value !== "PRIMARY"),
            )
          : { ...current };
      return { ...cleared, [id]: role };
    });
  }

  async function handleAssign() {
    clearFeedback();
    if (!hasPrimaryAssignment) {
      showError(t.selectPrimary);
      return;
    }
    const ok = await onAssign(workOrder.id, selectedAssignments);
    if (ok) {
      showFeedback(t.assigned);
      setSelected({});
    } else {
      showError(t.actionFailed);
    }
  }

  async function handleForceAssign() {
    if (!forceAssignDispatchId || !forceMechanicId) return;
    setForcePending(true);
    clearFeedback();
    const ok = await onForceAssign(forceAssignDispatchId, forceMechanicId);
    setForcePending(false);
    setConfirmingForce(false);
    if (ok) {
      showFeedback(t.forceAssigned);
      setForceMechanicId("");
    } else {
      showError(t.actionFailed);
    }
  }

  async function handleStartP1() {
    setStartingP1(true);
    clearFeedback();
    const ok = await onStartP1Dispatch(workOrder.id);
    setStartingP1(false);
    if (ok) showFeedback(t.startP1Done);
    else showError(t.actionFailed);
  }

  async function handleCreateOutsource() {
    clearFeedback();
    if (!outsourceVendor.trim() || !outsourceReason.trim()) {
      showError(t.actionFailed);
      return;
    }
    setCreatingOutsource(true);
    const ok = await onCreateOutsourceWork(
      workOrder.id,
      outsourceVendor.trim(),
      outsourceContact.trim(),
      outsourceReason.trim(),
    );
    setCreatingOutsource(false);
    if (ok) {
      showFeedback(t.outsourceDone);
      setOutsourceVendor("");
      setOutsourceContact("");
      setOutsourceReason("");
    } else {
      showError(t.actionFailed);
    }
  }

  async function handleSaveAll() {
    clearFeedback();

    if (hasPartialSchedule) {
      showError(t.scheduleIncomplete);
      return;
    }

    if (hasSelectedAssignments && !hasPrimaryAssignment) {
      showError(t.selectPrimary);
      return;
    }

    if (!hasPriorityChange && !hasCompleteSchedule && !hasSelectedAssignments) {
      showError(t.noBatchChanges);
      return;
    }

    setSavingAll(true);
    try {
      if (hasPriorityChange) {
        const ok = await onSetPriority(workOrder.id, priority);
        if (!ok) {
          showError(t.actionFailed);
          return;
        }
      }

      if (hasCompleteSchedule) {
        const iso = new Date(scheduleAt).toISOString();
        const ok = await onRequestSchedule(
          workOrder.id,
          iso,
          scheduleReason.trim(),
        );
        if (!ok) {
          showError(t.actionFailed);
          return;
        }
      }

      if (hasSelectedAssignments) {
        const ok = await onAssign(workOrder.id, selectedAssignments);
        if (!ok) {
          showError(t.actionFailed);
          return;
        }
      }

      if (hasCompleteSchedule) {
        setScheduleAt("");
        setScheduleReason("");
      }
      if (hasSelectedAssignments) {
        setSelected({});
      }
      showFeedback(t.saveAllDone);
    } catch {
      showError(t.actionFailed);
    } finally {
      setSavingAll(false);
    }
  }

  const forceMechanicName =
    mechanics.find((m) => m.id === forceMechanicId)?.display_name ?? "";

  return (
    <Card
      aria-labelledby={controlsHeadingId}
      className="grid gap-3 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id={controlsHeadingId}
            className="truncate text-sm font-semibold text-ink"
          >
            {t.title} · {workOrder.request_no}
          </h3>
          <p className="text-xs font-medium text-steel">{t.managerOnly}</p>
        </div>
        <Button
          type="button"
          size="xs"
          variant="secondary"
          disabled={savingAll}
          onClick={() => {
            void handleSaveAll();
          }}
        >
          {savingAll ? t.savingAll : t.saveAll}
        </Button>
      </div>

      <FeedbackBanner
        kind="success"
        message={feedback}
        onDismiss={clearFeedback}
      />
      <FeedbackBanner kind="error" message={error} onDismiss={clearError} />

      <div className="grid gap-2 xl:grid-cols-4">
        <div className={COMPACT_SECTION_CLASS}>
          <label
            className={COMPACT_LABEL_CLASS}
            htmlFor={`priority-${workOrder.id}`}
          >
            {t.priorityLabel}
          </label>
          <div className="flex gap-1">
            <Select
              id={`priority-${workOrder.id}`}
              aria-label={t.priorityLabel}
              className={COMPACT_FIELD_CLASS}
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value as PriorityLevel);
              }}
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {priorityLabel(option)}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => {
                void handlePriority();
              }}
            >
              {t.setPriority}
            </Button>
          </div>
        </div>

        <div className={COMPACT_SECTION_CLASS}>
          <p className={COMPACT_LABEL_CLASS}>{t.startP1Label}</p>
          <p className="text-xs leading-snug text-steel">{t.startP1Hint}</p>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={startingP1}
            onClick={() => {
              void handleStartP1();
            }}
          >
            {startingP1 ? t.startingP1 : t.startP1}
          </Button>
        </div>

        <div className={`${COMPACT_SECTION_CLASS} xl:col-span-2`}>
          <label
            className={COMPACT_LABEL_CLASS}
            htmlFor={`schedule-${workOrder.id}`}
          >
            {t.scheduleLabel}
          </label>
          <div className="grid gap-1 sm:grid-cols-[minmax(0,13rem)_1fr_auto]">
            <Input
              id={`schedule-${workOrder.id}`}
              type="datetime-local"
              aria-label={t.scheduleLabel}
              className={COMPACT_FIELD_CLASS}
              value={scheduleAt}
              onChange={(event) => {
                setScheduleAt(event.target.value);
              }}
            />
            <Textarea
              aria-label={t.scheduleReason}
              placeholder={t.scheduleReasonPlaceholder}
              rows={1}
              className={COMPACT_TEXTAREA_CLASS}
              value={scheduleReason}
              onChange={(event) => {
                setScheduleReason(event.target.value);
              }}
            />
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => {
                void handleSchedule();
              }}
            >
              {t.requestSchedule}
            </Button>
          </div>
        </div>

        <div className={`${COMPACT_SECTION_CLASS} xl:col-span-2`}>
          <div className="flex flex-wrap items-center justify-between gap-1">
            <div>
              <p className={COMPACT_LABEL_CLASS}>{t.assignMultiLabel}</p>
              <p className="text-xs text-steel">{t.assignMultiHint}</p>
            </div>
            <Button
              type="button"
              size="xs"
              disabled={mechanics.length === 0}
              onClick={() => {
                void handleAssign();
              }}
            >
              {t.assign}
            </Button>
          </div>
          {mechanics.length === 0 ? (
            <p className="rounded-md border border-dashed border-line p-2 text-xs text-steel">
              {t.noMechanics}
            </p>
          ) : (
            <ul className="grid max-h-40 gap-1 overflow-y-auto sm:grid-cols-2">
              {mechanics.map((mechanic) => (
                <li
                  key={mechanic.id}
                  className="flex items-center justify-between gap-1 rounded-md border border-line bg-white px-2 py-1"
                >
                  <span className="truncate text-xs text-steel">
                    {mechanic.display_name}
                  </span>
                  <span className="flex gap-1">
                    <Button
                      type="button"
                      size="xs"
                      variant={
                        selected[mechanic.id] === "PRIMARY"
                          ? "default"
                          : "ghost"
                      }
                      aria-pressed={selected[mechanic.id] === "PRIMARY"}
                      aria-label={`${mechanic.display_name} ${t.rolePrimary}`}
                      onClick={() => {
                        toggleMechanic(mechanic.id, "PRIMARY");
                      }}
                    >
                      {t.rolePrimary}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant={
                        selected[mechanic.id] === "SECONDARY"
                          ? "default"
                          : "ghost"
                      }
                      aria-pressed={selected[mechanic.id] === "SECONDARY"}
                      aria-label={`${mechanic.display_name} ${t.roleSecondary}`}
                      onClick={() => {
                        toggleMechanic(mechanic.id, "SECONDARY");
                      }}
                    >
                      {t.roleSecondary}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={COMPACT_SECTION_CLASS}>
          <p className={COMPACT_LABEL_CLASS}>{t.currentAssignments}</p>
          {workOrder.assignments.length === 0 ? (
            <p className="text-xs text-steel">{t.noAssignments}</p>
          ) : (
            <ul className="grid gap-1">
              {workOrder.assignments.map((assignment) => (
                <li key={assignment.id} className="text-xs text-steel">
                  {assignment.mechanic_name} ·{" "}
                  {assignment.role === "PRIMARY"
                    ? t.rolePrimary
                    : t.roleSecondary}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={COMPACT_SECTION_CLASS}>
          <label
            className={COMPACT_LABEL_CLASS}
            htmlFor={`force-${workOrder.id}`}
          >
            {t.forceAssign}
          </label>
          {forceAssignDispatchId ? (
            <div className="flex gap-1">
              <Select
                id={`force-${workOrder.id}`}
                aria-label={t.forceAssign}
                className={COMPACT_FIELD_CLASS}
                value={forceMechanicId}
                onChange={(event) => {
                  setForceMechanicId(event.target.value);
                }}
              >
                <option value="">{t.assignPlaceholder}</option>
                {mechanics.map((mechanic) => (
                  <option key={mechanic.id} value={mechanic.id}>
                    {mechanic.display_name}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={!forceMechanicId}
                onClick={() => {
                  setConfirmingForce(true);
                }}
              >
                {t.forceAssign}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-steel">{t.forceAssignNeedsDispatch}</p>
          )}
        </div>

        <div className={`${COMPACT_SECTION_CLASS} xl:col-span-4`}>
          <div>
            <p className={COMPACT_LABEL_CLASS}>{t.outsourceLabel}</p>
            <p className="text-xs text-steel">{t.outsourceHint}</p>
          </div>
          <div className="grid gap-1 lg:grid-cols-[minmax(0,12rem)_minmax(0,12rem)_1fr_auto]">
            <Input
              id={`outsource-vendor-${workOrder.id}`}
              aria-label={t.outsourceVendor}
              placeholder={t.outsourceVendorPlaceholder}
              className={COMPACT_FIELD_CLASS}
              value={outsourceVendor}
              onChange={(event) => {
                setOutsourceVendor(event.target.value);
              }}
            />
            <Input
              id={`outsource-contact-${workOrder.id}`}
              aria-label={t.outsourceContact}
              placeholder={t.outsourceContactPlaceholder}
              className={COMPACT_FIELD_CLASS}
              value={outsourceContact}
              onChange={(event) => {
                setOutsourceContact(event.target.value);
              }}
            />
            <Textarea
              aria-label={t.outsourceReason}
              placeholder={t.outsourceReasonPlaceholder}
              rows={1}
              className={COMPACT_TEXTAREA_CLASS}
              value={outsourceReason}
              onChange={(event) => {
                setOutsourceReason(event.target.value);
              }}
            />
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={
                creatingOutsource ||
                !outsourceVendor.trim() ||
                !outsourceReason.trim()
              }
              onClick={() => {
                void handleCreateOutsource();
              }}
            >
              {creatingOutsource ? t.creatingOutsource : t.createOutsource}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmingForce}
        title={t.forceAssignTitle}
        message={t.forceAssignConfirm
          .replace("{mechanic}", forceMechanicName)
          .replace("{requestNo}", workOrder.request_no)}
        warning={t.forceAssignWarning}
        confirmLabel={t.forceAssignApply}
        busyLabel={t.forceAssigning}
        cancelLabel={t.cancel}
        destructive
        busy={forcePending}
        onConfirm={() => {
          void handleForceAssign();
        }}
        onCancel={() => {
          setConfirmingForce(false);
        }}
      />
    </Card>
  );
}
