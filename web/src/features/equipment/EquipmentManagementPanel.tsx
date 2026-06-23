import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type {
  CreateEquipmentRequest,
  EquipmentStatus,
  EquipmentSummary,
  UpdateEquipmentRequest,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { ko } from "../../i18n/ko";

interface EquipmentManagementPanelProps {
  api: ConsoleApiClient;
  /** Equipment rows surfaced by the autocomplete search on the page. */
  results: EquipmentSummary[];
  /** Re-runs the page search so the list reflects the latest writes. */
  onMutated: () => void;
}

type Mode = "idle" | "create" | "edit";
type WriteState = "idle" | "saving" | "error";

const STATUS_OPTIONS: EquipmentStatus[] = [
  "rented",
  "spare",
  "disposed",
  "replacement",
  "sold",
];

interface FormState {
  equipment_no: string;
  customer_name: string;
  site_name: string;
  status: EquipmentStatus;
  specification: string;
  ton_text: string;
  management_no: string;
  model: string;
  maker: string;
  acquisition_cost_won: string;
  acquisition_date: string;
  note: string;
}

function emptyForm(): FormState {
  return {
    equipment_no: "",
    customer_name: "",
    site_name: "",
    status: "rented",
    specification: "",
    ton_text: "",
    management_no: "",
    model: "",
    maker: "",
    acquisition_cost_won: "",
    acquisition_date: "",
    note: "",
  };
}

function seedFromSummary(summary: EquipmentSummary): FormState {
  return {
    ...emptyForm(),
    equipment_no: summary.equipment_no,
    status: normalizeStatus(summary.status),
    specification: summary.specification,
    ton_text: summary.ton_text,
    management_no: summary.management_no ?? "",
    model: summary.model ?? "",
  };
}

/** The list endpoints return `status` as a free string; clamp to the enum. */
function normalizeStatus(raw: string): EquipmentStatus {
  return (STATUS_OPTIONS as string[]).includes(raw)
    ? (raw as EquipmentStatus)
    : "rented";
}

function nullableTrim(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse an acquisition-cost input. Empty -> `undefined` (omit the key, leaving
 * the column unchanged); a non-negative integer string -> that number. Any other
 * input is treated as empty so we never send a malformed body.
 */
function parseAcquisitionCost(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function EquipmentManagementPanel({
  api,
  results,
  onMutated,
}: EquipmentManagementPanelProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [notice, setNotice] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<EquipmentSummary>();
  const [deleting, setDeleting] = useState(false);

  function startCreate() {
    setMode("create");
    setEditingId(undefined);
    setForm(emptyForm());
    setWriteState("idle");
    setNotice(undefined);
  }

  function startEdit(summary: EquipmentSummary) {
    setMode("edit");
    setEditingId(summary.id);
    setForm(seedFromSummary(summary));
    setWriteState("idle");
    setNotice(undefined);
  }

  function closeForm() {
    setMode("idle");
    setEditingId(undefined);
    setWriteState("idle");
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit() {
    setWriteState("saving");
    try {
      if (mode === "create") {
        const body: CreateEquipmentRequest = {
          equipment_no: form.equipment_no.trim(),
          customer_name: form.customer_name.trim(),
          site_name: form.site_name.trim(),
          status: form.status,
          specification: form.specification.trim(),
          ton_text: form.ton_text.trim(),
          management_no: nullableTrim(form.management_no),
          model: nullableTrim(form.model),
          maker: nullableTrim(form.maker),
          note: nullableTrim(form.note),
        };
        const response = await api.POST("/api/v1/equipment", { body });
        if (!response.data) {
          throw new Error("create equipment response missing data");
        }
        setNotice(ko.equipment.createSuccess);
      } else if (mode === "edit" && editingId) {
        const body: UpdateEquipmentRequest = {
          customer_name: form.customer_name.trim() || undefined,
          site_name: form.site_name.trim() || undefined,
          status: form.status,
          specification: form.specification.trim() || undefined,
          ton_text: form.ton_text.trim() || undefined,
          management_no: nullableTrim(form.management_no),
          model: nullableTrim(form.model),
          maker: nullableTrim(form.maker),
          note: nullableTrim(form.note),
        };
        // Acquisition is a master-level accounting fact. A non-empty value sets
        // it; left empty, the key is omitted so the existing value is untouched
        // (the search summary does not carry the current acquisition figure, so
        // we never blindly clear it).
        const acquisitionCost = parseAcquisitionCost(form.acquisition_cost_won);
        if (acquisitionCost !== undefined) {
          body.acquisition_cost_won = acquisitionCost;
        }
        const acquisitionDate = form.acquisition_date.trim();
        if (acquisitionDate.length > 0) {
          body.acquisition_date = acquisitionDate;
        }
        const response = await api.PATCH("/api/v1/equipment/{id}", {
          params: { path: { id: editingId } },
          body,
        });
        if (response.error) {
          throw new Error("update equipment failed");
        }
        setNotice(ko.equipment.updateSuccess);
      }
      closeForm();
      onMutated();
    } catch {
      setWriteState("error");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await api.DELETE("/api/v1/equipment/{id}", {
        params: { path: { id: deleteTarget.id } },
      });
      if (response.error) {
        throw new Error("delete equipment failed");
      }
      setNotice(ko.equipment.deleteSuccess);
      setDeleteTarget(undefined);
      onMutated();
    } catch {
      setNotice(ko.equipment.deleteFailed);
    } finally {
      setDeleting(false);
    }
  }

  const submitDisabled =
    writeState === "saving" ||
    (mode === "create" &&
      (!form.equipment_no.trim() ||
        !form.customer_name.trim() ||
        !form.site_name.trim() ||
        !form.specification.trim() ||
        !form.ton_text.trim()));

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {ko.equipment.manageTitle}
          </h2>
          <p className="text-sm text-steel">
            {ko.equipment.manageDescription}
          </p>
        </div>
        <Button type="button" onClick={startCreate}>
          <Plus aria-hidden="true" size={16} />
          {ko.equipment.create}
        </Button>
      </div>

      {notice ? (
        <p role="status" className="text-sm font-medium text-brand-teal">
          {notice}
        </p>
      ) : null}

      {mode !== "idle" ? (
        <form
          className="grid gap-3 rounded-md border border-line p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <h3 className="text-base font-semibold text-ink">
            {mode === "create" ? ko.equipment.create : ko.equipment.edit}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="eq-equipment-no"
              label={ko.equipment.fields.equipmentNo}
              value={form.equipment_no}
              onChange={(v) => {
                setField("equipment_no", v);
              }}
              disabled={mode === "edit"}
            />
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="eq-status"
              >
                {ko.equipment.fields.status}
              </label>
              <Select
                id="eq-status"
                value={form.status}
                onChange={(event) => {
                  setField(
                    "status",
                    event.currentTarget.value as EquipmentStatus,
                  );
                }}
              >
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {ko.equipment.statuses[status]}
                  </option>
                ))}
              </Select>
            </div>
            <Field
              id="eq-customer-name"
              label={ko.equipment.fields.customerName}
              value={form.customer_name}
              onChange={(v) => {
                setField("customer_name", v);
              }}
            />
            <Field
              id="eq-site-name"
              label={ko.equipment.fields.siteName}
              value={form.site_name}
              onChange={(v) => {
                setField("site_name", v);
              }}
            />
            <Field
              id="eq-specification"
              label={ko.equipment.fields.specification}
              value={form.specification}
              onChange={(v) => {
                setField("specification", v);
              }}
            />
            <Field
              id="eq-ton-text"
              label={ko.equipment.fields.tonText}
              value={form.ton_text}
              onChange={(v) => {
                setField("ton_text", v);
              }}
            />
            <Field
              id="eq-management-no"
              label={ko.equipment.fields.managementNo}
              value={form.management_no}
              onChange={(v) => {
                setField("management_no", v);
              }}
            />
            <Field
              id="eq-model"
              label={ko.equipment.fields.model}
              value={form.model}
              onChange={(v) => {
                setField("model", v);
              }}
            />
            <Field
              id="eq-maker"
              label={ko.equipment.fields.maker}
              value={form.maker}
              onChange={(v) => {
                setField("maker", v);
              }}
            />
            {mode === "edit" ? (
              <>
                <Field
                  id="eq-acquisition-cost"
                  label={ko.equipment.fields.acquisitionCost}
                  value={form.acquisition_cost_won}
                  onChange={(v) => {
                    setField("acquisition_cost_won", v);
                  }}
                />
                <Field
                  id="eq-acquisition-date"
                  label={ko.equipment.fields.acquisitionDate}
                  value={form.acquisition_date}
                  onChange={(v) => {
                    setField("acquisition_date", v);
                  }}
                />
              </>
            ) : null}
          </div>
          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="eq-note"
            >
              {ko.equipment.fields.note}
            </label>
            <Textarea
              id="eq-note"
              value={form.note}
              onChange={(event) => {
                setField("note", event.currentTarget.value);
              }}
            />
          </div>
          {writeState === "error" ? (
            <p role="alert" className="text-sm font-semibold text-red-700">
              {mode === "create"
                ? ko.equipment.createFailed
                : ko.equipment.updateFailed}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={writeState === "saving"}
              onClick={closeForm}
            >
              {ko.equipment.cancel}
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {writeState === "saving" ? ko.equipment.saving : ko.equipment.save}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="grid gap-2">
        {results.length === 0 ? (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
            {ko.equipment.searchToManage}
          </p>
        ) : (
          results.map((eq) => (
            <div
              key={eq.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3"
            >
              <div className="grid gap-1">
                <span className="font-semibold text-ink">
                  {eq.management_no ?? eq.equipment_no}
                </span>
                <span className="text-sm text-steel">
                  {eq.model ?? ko.common.unknown} · {eq.ton_text}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge>{ko.equipment.statuses[normalizeStatus(eq.status)]}</Badge>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label={`${eq.equipment_no} ${ko.equipment.edit}`}
                  onClick={() => {
                    startEdit(eq);
                  }}
                >
                  <Pencil aria-hidden="true" size={14} />
                  {ko.equipment.edit}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  aria-label={`${eq.equipment_no} ${ko.equipment.delete}`}
                  onClick={() => {
                    setDeleteTarget(eq);
                  }}
                >
                  <Trash2 aria-hidden="true" size={14} />
                  {ko.equipment.delete}
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      {deleteTarget ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={ko.equipment.deleteTitle}
          className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
        >
          <Card className="grid w-full max-w-md gap-4">
            <h2 className="text-lg font-semibold text-ink">
              {ko.equipment.deleteTitle}
            </h2>
            <p className="text-sm text-steel">
              {ko.equipment.deleteConfirm.replace(
                "{equipmentNo}",
                deleteTarget.equipment_no,
              )}
            </p>
            <p className="text-sm font-medium text-amber-800">
              {ko.equipment.deleteWarning}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={deleting}
                onClick={() => {
                  setDeleteTarget(undefined);
                }}
              >
                {ko.equipment.cancel}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={deleting}
                onClick={() => {
                  void handleDelete();
                }}
              >
                {deleting ? ko.equipment.deleting : ko.equipment.delete}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </Card>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

function Field({ id, label, value, onChange, disabled }: FieldProps) {
  return (
    <div className="grid gap-2">
      <label className="text-sm font-medium text-steel" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
    </div>
  );
}
