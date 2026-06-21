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
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { ko } from "../../i18n/ko";

/**
 * Intake-time maintenance classification. The work-order backend has no
 * first-class category column, so the selection is recorded as a structured
 * prefix on `customer_request` (an existing free-text field) rather than a
 * dedicated API field. See the gap note in the P2 report.
 */
type ServiceCategory = keyof typeof ko.intake.serviceCategories;

const SERVICE_CATEGORIES = Object.keys(
  ko.intake.serviceCategories,
) as ServiceCategory[];

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
  requestedOn?: string;
  symptom?: string;
  contactPhone?: string;
}

// Visual required-field indicator. Kept out of the accessible name (aria-hidden);
// required-ness is conveyed to assistive tech via aria-required on each input.
function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-0.5 text-red-600">
      *
    </span>
  );
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
  const [requestedOn, setRequestedOn] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [symptom, setSymptom] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [customerRequest, setCustomerRequest] = useState("");
  const [serviceCategory, setServiceCategory] = useState<ServiceCategory | "">(
    "",
  );
  const [targetDueAt, setTargetDueAt] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [status, setStatus] = useState<
    "idle" | "saving" | "created" | "error"
  >("idle");

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
    if (requestedOn.trim().length === 0) {
      nextErrors.requestedOn = ko.intake.requiredRequestedOn;
    }
    if (symptom.trim().length === 0) {
      nextErrors.symptom = ko.intake.requiredSymptom;
    }
    if (contactPhone.trim().length === 0) {
      nextErrors.contactPhone = ko.intake.requiredContactPhone;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setStatus("saving");
    try {
      // The backend work-order has no first-class columns for the request date,
      // maintenance-contact phone, or category, so they are recorded as structured
      // prefixes on the existing customer_request free-text field (the form's
      // documented convention — see the ServiceCategory note above).
      const requestedOnTag = `[${ko.intake.requestedOn}: ${requestedOn}]`;
      const contactTag = `[${ko.intake.contactPhone}: ${contactPhone.trim()}]`;
      const categoryTag = serviceCategory
        ? `[${ko.intake.serviceCategory}: ${ko.intake.serviceCategories[serviceCategory]}]`
        : "";
      const trimmedRequest = customerRequest.trim();
      const customerRequestValue =
        [requestedOnTag, contactTag, categoryTag, trimmedRequest]
          .filter(Boolean)
          .join(" ") || undefined;
      const created = await onCreateWorkOrder({
        branch_id: branchId,
        management_no: managementNo.trim(),
        symptom: symptom.trim(),
        customer_request: customerRequestValue,
        target_due_at: targetDueAt
          ? new Date(targetDueAt).toISOString()
          : undefined,
      });
      setStatus("created");
      onCreated?.(created);
    } catch {
      setStatus("error");
    }
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
            <RequiredMark />
          </label>
          <Input
            id="management-no"
            aria-required="true"
            value={managementNo}
            placeholder={ko.intake.managementNoPlaceholder}
            onChange={(event) => {
              const nextManagementNo = event.currentTarget.value;
              setManagementNo(nextManagementNo);
              onManagementNoChange?.(nextManagementNo);
            }}
            list="equipment-suggestions"
            aria-invalid={Boolean(errors.managementNo)}
            aria-describedby={
              errors.managementNo ? "management-no-error" : undefined
            }
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
            <p
              id="management-no-error"
              className="text-sm font-medium text-red-700"
            >
              {errors.managementNo}
            </p>
          ) : null}
        </div>

        <EquipmentLookupPanel state={equipmentLookupState} />

        <div className="grid gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="requested-on">
            {ko.intake.requestedOn}
            <RequiredMark />
          </label>
          <Input
            id="requested-on"
            type="date"
            aria-required="true"
            value={requestedOn}
            onChange={(event) => {
              setRequestedOn(event.currentTarget.value);
            }}
            aria-invalid={Boolean(errors.requestedOn)}
            aria-describedby={
              errors.requestedOn ? "requested-on-error" : undefined
            }
          />
          {errors.requestedOn ? (
            <p
              id="requested-on-error"
              className="text-sm font-medium text-red-700"
            >
              {errors.requestedOn}
            </p>
          ) : null}
        </div>

        <div className="grid gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="symptom">
            {ko.intake.symptom}
            <RequiredMark />
          </label>
          <Textarea
            id="symptom"
            aria-required="true"
            value={symptom}
            placeholder={ko.intake.symptomPlaceholder}
            onChange={(event) => {
              setSymptom(event.currentTarget.value);
            }}
            aria-invalid={Boolean(errors.symptom)}
            aria-describedby={errors.symptom ? "symptom-error" : undefined}
          />
          {errors.symptom ? (
            <p id="symptom-error" className="text-sm font-medium text-red-700">
              {errors.symptom}
            </p>
          ) : null}
        </div>

        <div className="grid gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="contact-phone">
            {ko.intake.contactPhone}
            <RequiredMark />
          </label>
          <Input
            id="contact-phone"
            type="tel"
            inputMode="tel"
            aria-required="true"
            value={contactPhone}
            placeholder={ko.intake.contactPhonePlaceholder}
            onChange={(event) => {
              setContactPhone(event.currentTarget.value);
            }}
            aria-invalid={Boolean(errors.contactPhone)}
            aria-describedby={
              errors.contactPhone ? "contact-phone-error" : undefined
            }
          />
          {errors.contactPhone ? (
            <p
              id="contact-phone-error"
              className="text-sm font-medium text-red-700"
            >
              {errors.contactPhone}
            </p>
          ) : null}
        </div>

        <div className="grid gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="service-category">
            {ko.intake.serviceCategory}
          </label>
          <Select
            id="service-category"
            value={serviceCategory}
            onChange={(event) => {
              setServiceCategory(
                event.currentTarget.value as ServiceCategory | "",
              );
            }}
          >
            <option value="">{ko.intake.serviceCategoryNone}</option>
            {SERVICE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {ko.intake.serviceCategories[category]}
              </option>
            ))}
          </Select>
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
        {status === "error" ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {ko.intake.saveFailed}
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

  const { equipment } = state;
  return (
    <dl className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm sm:grid-cols-3">
      <div>
        <dt className="font-semibold text-slate-600">{ko.intake.model}</dt>
        <dd className="text-slate-950">{equipment.model}</dd>
      </div>
      <div>
        <dt className="font-semibold text-slate-600">{ko.intake.customer}</dt>
        <dd className="text-slate-950">{equipment.customerName}</dd>
      </div>
      <div>
        <dt className="font-semibold text-slate-600">{ko.intake.site}</dt>
        <dd className="text-slate-950">{equipment.siteName}</dd>
      </div>
      <div>
        <dt className="font-semibold text-slate-600">{ko.intake.maker}</dt>
        <dd className="text-slate-950">
          {equipment.maker ?? ko.intake.vehicleUnknown}
        </dd>
      </div>
      <div>
        <dt className="font-semibold text-slate-600">{ko.intake.vin}</dt>
        <dd className="text-slate-950">
          {equipment.vin ?? ko.intake.vehicleUnknown}
        </dd>
      </div>
      <div>
        <dt className="font-semibold text-slate-600">
          {ko.intake.vehicleRegistrationNo}
        </dt>
        <dd className="text-slate-950">
          {equipment.vehicleRegistrationNo ?? ko.intake.vehicleUnknown}
        </dd>
      </div>
    </dl>
  );
}
