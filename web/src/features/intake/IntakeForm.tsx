import { Save } from "lucide-react";
import type { SyntheticEvent } from "react";
import { useState } from "react";

import type {
  CreateWorkOrderRequest,
  EquipmentLookupResponse,
  EquipmentLookupState,
  WorkOrderSummary,
} from "../../api/types";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { ko } from "../../i18n/ko";

interface IntakeFormProps {
  branchId: string;
  equipmentLookupState: EquipmentLookupState;
  equipmentSuggestions?: EquipmentLookupResponse[];
  onManagementNoChange?: (managementNo: string) => void;
  onCreateWorkOrder: (
    request: CreateWorkOrderRequest,
  ) => Promise<WorkOrderSummary>;
  onCreated?: (workOrder: WorkOrderSummary) => void;
}

interface Errors {
  managementNo?: string;
  symptom?: string;
}

export function IntakeForm({
  branchId,
  equipmentLookupState,
  equipmentSuggestions = [],
  onManagementNoChange,
  onCreateWorkOrder,
  onCreated,
}: IntakeFormProps) {
  const [managementNo, setManagementNo] = useState("");
  const [symptom, setSymptom] = useState("");
  const [customerRequest, setCustomerRequest] = useState("");
  const [targetDueAt, setTargetDueAt] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [status, setStatus] = useState<"idle" | "saving" | "created">("idle");

  const priorityHint = ko.intake.priorityTriggers.some((trigger) =>
    symptom.includes(trigger),
  )
    ? ko.intake.priorityHintP1
    : ko.intake.priorityHintP2;

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: Errors = {};
    if (managementNo.trim().length === 0) {
      nextErrors.managementNo = ko.intake.requiredManagementNo;
    }
    if (symptom.trim().length === 0) {
      nextErrors.symptom = ko.intake.requiredSymptom;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setStatus("saving");
    const created = await onCreateWorkOrder({
      branch_id: branchId,
      management_no: managementNo.trim(),
      symptom: symptom.trim(),
      customer_request: customerRequest.trim() || undefined,
      target_due_at: targetDueAt ? new Date(targetDueAt).toISOString() : undefined,
    });
    setStatus("created");
    onCreated?.(created);
  }

  return (
    <Card>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-950">{ko.intake.title}</h2>
          <span className="rounded-md bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900">
            {priorityHint}
          </span>
        </div>

        <div className="grid gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="management-no">
            {ko.intake.managementNo}
          </label>
          <Input
            id="management-no"
            value={managementNo}
            placeholder={ko.intake.managementNoPlaceholder}
            onChange={(event) => {
              const nextManagementNo = event.currentTarget.value;
              setManagementNo(nextManagementNo);
              onManagementNoChange?.(nextManagementNo);
            }}
            list="equipment-suggestions"
            aria-invalid={Boolean(errors.managementNo)}
          />
          {equipmentSuggestions.length > 0 ? (
            <datalist id="equipment-suggestions">
              {equipmentSuggestions.map((equipment) => (
                <option
                  key={equipment.id}
                  value={equipment.management_no ?? equipment.equipment_no}
                  label={`${equipment.model ?? ko.common.unknown} / ${equipment.customer.name}`}
                />
              ))}
            </datalist>
          ) : null}
          {errors.managementNo ? (
            <p className="text-sm font-medium text-red-700">{errors.managementNo}</p>
          ) : null}
        </div>

        <EquipmentLookupPanel state={equipmentLookupState} />

        <div className="grid gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="symptom">
            {ko.intake.symptom}
          </label>
          <Textarea
            id="symptom"
            value={symptom}
            placeholder={ko.intake.symptomPlaceholder}
            onChange={(event) => {
              setSymptom(event.currentTarget.value);
            }}
            aria-invalid={Boolean(errors.symptom)}
          />
          {errors.symptom ? (
            <p className="text-sm font-medium text-red-700">{errors.symptom}</p>
          ) : null}
        </div>

        <div className="grid gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="customer-request">
            {ko.intake.customerRequest}
          </label>
          <Input
            id="customer-request"
            value={customerRequest}
            onChange={(event) => {
              setCustomerRequest(event.currentTarget.value);
            }}
          />
        </div>

        <div className="grid gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="target-due-at">
            {ko.intake.targetDueAt}
          </label>
          <Input
            id="target-due-at"
            type="datetime-local"
            value={targetDueAt}
            onChange={(event) => {
              setTargetDueAt(event.currentTarget.value);
            }}
          />
        </div>

        <Button type="submit" disabled={status === "saving"}>
          <Save aria-hidden="true" size={18} />
          {status === "saving" ? ko.intake.saving : ko.intake.save}
        </Button>
        {status === "created" ? (
          <p role="status" className="text-sm font-semibold text-emerald-800">
            {ko.intake.created}
          </p>
        ) : null}
      </form>
    </Card>
  );
}

function EquipmentLookupPanel({ state }: { state: EquipmentLookupState }) {
  if (state.status === "idle") {
    return (
      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">
        {ko.intake.lookupPrompt}
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div
        className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-700"
        role="status"
      >
        {ko.intake.lookupLoading}
      </div>
    );
  }

  if (state.status === "notFound" || state.status === "error") {
    return (
      <div className="rounded-md border border-dashed border-red-300 bg-red-50 p-3 text-sm font-medium text-red-800">
        {state.status === "notFound"
          ? ko.intake.lookupNotFound
          : ko.intake.lookupFailed}
      </div>
    );
  }

  return (
    <dl className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm sm:grid-cols-3">
      <div>
        <dt className="font-semibold text-slate-600">{ko.intake.model}</dt>
        <dd className="text-slate-950">{state.equipment.model}</dd>
      </div>
      <div>
        <dt className="font-semibold text-slate-600">{ko.intake.customer}</dt>
        <dd className="text-slate-950">{state.equipment.customerName}</dd>
      </div>
      <div>
        <dt className="font-semibold text-slate-600">{ko.intake.site}</dt>
        <dd className="text-slate-950">{state.equipment.siteName}</dd>
      </div>
    </dl>
  );
}
