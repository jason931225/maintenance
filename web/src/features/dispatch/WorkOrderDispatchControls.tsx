import { useState } from "react";

import type { UserSummary, WorkOrderListItem } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { ko } from "../../i18n/ko";

type PriorityLevel = WorkOrderListItem["priority"];

const PRIORITY_OPTIONS: PriorityLevel[] = [
  "P1",
  "P2",
  "P3",
  "OUTSOURCE",
  "UNSET",
];

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

  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  function reset(message: string) {
    setError(undefined);
    setFeedback(message);
  }

  async function handlePriority() {
    const ok = await onSetPriority(workOrder.id, priority);
    if (ok) reset(t.priorityUpdated);
    else setError(t.actionFailed);
  }

  async function handleSchedule() {
    setFeedback(undefined);
    if (!scheduleAt || !scheduleReason.trim()) {
      setError(t.actionFailed);
      return;
    }
    // datetime-local yields `YYYY-MM-DDTHH:mm`; send an RFC3339 instant.
    const iso = new Date(scheduleAt).toISOString();
    const ok = await onRequestSchedule(workOrder.id, iso, scheduleReason.trim());
    if (ok) {
      reset(t.scheduleRequested);
      setScheduleAt("");
      setScheduleReason("");
    } else {
      setError(t.actionFailed);
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
    setFeedback(undefined);
    const assignments: MechanicAssignmentInput[] = Object.entries(selected).map(
      ([mechanic_id, role]) => ({ mechanic_id, role }),
    );
    const hasPrimary = assignments.some((a) => a.role === "PRIMARY");
    if (!hasPrimary) {
      setError(t.selectPrimary);
      return;
    }
    const ok = await onAssign(workOrder.id, assignments);
    if (ok) {
      reset(t.assigned);
      setSelected({});
    } else {
      setError(t.actionFailed);
    }
  }

  async function handleForceAssign() {
    if (!forceAssignDispatchId || !forceMechanicId) return;
    setForcePending(true);
    setFeedback(undefined);
    const ok = await onForceAssign(forceAssignDispatchId, forceMechanicId);
    setForcePending(false);
    setConfirmingForce(false);
    if (ok) {
      reset(t.forceAssigned);
      setForceMechanicId("");
    } else {
      setError(t.actionFailed);
    }
  }

  const forceMechanicName =
    mechanics.find((m) => m.id === forceMechanicId)?.display_name ?? "";

  return (
    <Card className="grid gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-950">
          {t.title} · {workOrder.request_no}
        </h3>
        <span className="text-xs font-medium text-slate-500">
          {t.managerOnly}
        </span>
      </div>

      {feedback ? (
        <p role="status" className="text-sm font-medium text-emerald-700">
          {feedback}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}

      {/* priority */}
      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-slate-700"
          htmlFor={`priority-${workOrder.id}`}
        >
          {t.priorityLabel}
        </label>
        <div className="flex gap-2">
          <Select
            id={`priority-${workOrder.id}`}
            aria-label={t.priorityLabel}
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value as PriorityLevel);
            }}
          >
            {PRIORITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void handlePriority();
            }}
          >
            {t.setPriority}
          </Button>
        </div>
      </div>

      {/* schedule (target-due change request) */}
      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-slate-700"
          htmlFor={`schedule-${workOrder.id}`}
        >
          {t.scheduleLabel}
        </label>
        <Input
          id={`schedule-${workOrder.id}`}
          type="datetime-local"
          aria-label={t.scheduleLabel}
          value={scheduleAt}
          onChange={(event) => {
            setScheduleAt(event.target.value);
          }}
        />
        <Textarea
          aria-label={t.scheduleReason}
          placeholder={t.scheduleReasonPlaceholder}
          value={scheduleReason}
          onChange={(event) => {
            setScheduleReason(event.target.value);
          }}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void handleSchedule();
          }}
        >
          {t.requestSchedule}
        </Button>
      </div>

      {/* assign one or many mechanics */}
      <div className="grid gap-2">
        <p className="text-sm font-medium text-slate-700">{t.assignMultiLabel}</p>
        <p className="text-xs text-slate-500">{t.assignMultiHint}</p>
        {mechanics.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 p-3 text-sm text-slate-600">
            {t.noMechanics}
          </p>
        ) : (
          <ul className="grid gap-1">
            {mechanics.map((mechanic) => (
              <li
                key={mechanic.id}
                className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2"
              >
                <span className="text-sm text-slate-800">
                  {mechanic.display_name}
                </span>
                <span className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
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
                    size="sm"
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
        <Button
          type="button"
          onClick={() => {
            void handleAssign();
          }}
          disabled={mechanics.length === 0}
        >
          {t.assign}
        </Button>
      </div>

      {/* Current assignments */}
      <div className="grid gap-1">
        <p className="text-sm font-medium text-slate-700">
          {t.currentAssignments}
        </p>
        {workOrder.assignments.length === 0 ? (
          <p className="text-sm text-slate-500">{t.noAssignments}</p>
        ) : (
          <ul className="grid gap-1">
            {workOrder.assignments.map((assignment) => (
              <li key={assignment.id} className="text-sm text-slate-700">
                {assignment.mechanic_name} ·{" "}
                {assignment.role === "PRIMARY"
                  ? t.rolePrimary
                  : t.roleSecondary}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* force-assign an escalated P1 dispatch */}
      <div className="grid gap-2 border-t border-slate-200 pt-3">
        <label
          className="text-sm font-medium text-slate-700"
          htmlFor={`force-${workOrder.id}`}
        >
          {t.forceAssign}
        </label>
        {forceAssignDispatchId ? (
          <>
            <div className="flex gap-2">
              <Select
                id={`force-${workOrder.id}`}
                aria-label={t.forceAssign}
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
                variant="destructive"
                disabled={!forceMechanicId}
                onClick={() => {
                  setConfirmingForce(true);
                }}
              >
                {t.forceAssign}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-500">{t.forceAssignNeedsDispatch}</p>
        )}
      </div>

      {confirmingForce ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t.forceAssignTitle}
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/40 p-4"
        >
          <Card className="grid w-full max-w-md gap-4">
            <h2 className="text-lg font-semibold text-slate-950">
              {t.forceAssignTitle}
            </h2>
            <p className="text-sm text-slate-600">
              {t.forceAssignConfirm
                .replace("{mechanic}", forceMechanicName)
                .replace("{requestNo}", workOrder.request_no)}
            </p>
            <p className="text-sm font-medium text-amber-800">
              {t.forceAssignWarning}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={forcePending}
                onClick={() => {
                  setConfirmingForce(false);
                }}
              >
                {t.cancel}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={forcePending}
                onClick={() => {
                  void handleForceAssign();
                }}
              >
                {forcePending ? t.forceAssigning : t.forceAssignApply}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </Card>
  );
}
