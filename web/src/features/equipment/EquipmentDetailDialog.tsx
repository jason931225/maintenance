import { Pencil } from "lucide-react";
import { useId, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type {
  EquipmentListItem,
  EquipmentStatus,
  UpdateEquipmentRequest,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { FeedbackBanner } from "../../components/states/FeedbackBanner";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { equipmentStatusBadgeClass } from "./equipment-format";
import { formatKoreanDate } from "../../lib/datetime";
import { Mono } from "../../lib/format";
import { safeLabel } from "../../lib/utils";
import { ko } from "../../i18n/ko";

const STATUS_OPTIONS: EquipmentStatus[] = [
  "rented",
  "spare",
  "disposed",
  "replacement",
  "sold",
];

interface EquipmentDetailDialogProps {
  /** The equipment row to inspect; `undefined` keeps the dialog closed. */
  item: EquipmentListItem | undefined;
  /** Whether the viewer holds EquipmentManage (drives the inline edit affordance). */
  canManage: boolean;
  api: ConsoleApiClient;
  onClose: () => void;
  /** Called with the patched row after a successful edit so the list refreshes. */
  onUpdated: (item: EquipmentListItem) => void;
  /** Current page rows: enough reference data for native dropdown suggestions. */
  referenceItems?: EquipmentListItem[];
}

type EditState = "idle" | "saving" | "error";

interface FormState {
  status: EquipmentStatus;
  management_no: string;
  model: string;
  maker: string;
  specification: string;
  ton_text: string;
  customer_name: string;
  site_name: string;
  vin: string;
}

function seedForm(item: EquipmentListItem): FormState {
  return {
    status: item.status,
    management_no: item.management_no ?? "",
    model: item.model ?? "",
    maker: item.maker ?? "",
    specification: item.specification,
    ton_text: item.ton_text,
    customer_name: item.customer_name,
    site_name: item.site_name,
    vin: item.vin ?? "",
  };
}

/** Empty string -> null (clear the column); a trimmed value otherwise. */
function nullableTrim(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort((a, b) => a.localeCompare(b, "ko"));
}

function onlyValue(values: Array<string | null | undefined>): string | undefined {
  const unique = uniqueStrings(values);
  return unique.length === 1 ? unique[0] : undefined;
}


/**
 * In-list equipment detail popup opened from the equipment browse list. Shows
 * the full details already carried by the list row (the API exposes no by-id
 * detail read), and — for EquipmentManage holders — lets them edit the row in
 * place via PATCH /api/v1/equipment/{id} without leaving the browse page.
 * Non-managers see a read-only view.
 */
export function EquipmentDetailDialog({
  item,
  canManage,
  api,
  onClose,
  onUpdated,
  referenceItems = [],
}: EquipmentDetailDialogProps) {
  const titleId = useId();
  const [editing, setEditing] = useState(false);
  // Seed the edit form from the opened row. The parent remounts this component
  // per row (keyed on the equipment id), so a lazy initializer is sufficient —
  // no reset effect, and switching rows always starts from a clean read-only
  // view with fresh field values.
  const [form, setForm] = useState<FormState | undefined>(() =>
    item ? seedForm(item) : undefined,
  );
  const [editState, setEditState] = useState<EditState>("idle");

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSubmit() {
    if (!item || !form) return;
    setEditState("saving");
    const body: UpdateEquipmentRequest = {
      status: form.status,
      customer_name: form.customer_name.trim() || undefined,
      site_name: form.site_name.trim() || undefined,
      specification: form.specification.trim() || undefined,
      ton_text: form.ton_text.trim() || undefined,
      management_no: nullableTrim(form.management_no),
      model: nullableTrim(form.model),
      maker: nullableTrim(form.maker),
      vin: nullableTrim(form.vin),
    };
    const response = await api
      .PATCH("/api/v1/equipment/{id}", {
        params: { path: { id: item.equipment_id } },
        body,
      })
      .catch(() => undefined);

    if (!response || response.error) {
      setEditState("error");
      return;
    }

    // The PATCH returns no body; reflect the submitted fields onto the row so the
    // list updates without a full refetch.
    onUpdated({
      ...item,
      status: form.status,
      management_no: body.management_no ?? null,
      model: body.model ?? null,
      maker: body.maker ?? null,
      specification: body.specification ?? item.specification,
      ton_text: body.ton_text ?? item.ton_text,
      vin: body.vin ?? null,
      customer_name: body.customer_name ?? item.customer_name,
      site_name: body.site_name ?? item.site_name,
    });
    setEditState("idle");
    setEditing(false);
  }

  if (!item) return null;
  const currentItem = item;

  const suggestions = {
    customers: uniqueStrings(referenceItems.map((row) => row.customer_name)),
    sites: uniqueStrings(referenceItems.map((row) => row.site_name)),
    makers: uniqueStrings(referenceItems.map((row) => row.maker)),
    models: uniqueStrings(referenceItems.map((row) => row.model)),
    specifications: uniqueStrings(referenceItems.map((row) => row.specification)),
  };
  const modelProfiles = new Map(
    suggestions.models.map((model) => {
      const rows = referenceItems.filter((row) => row.model === model);
      return [
        model,
        {
          maker: onlyValue(rows.map((row) => row.maker)),
          specification: onlyValue(rows.map((row) => row.specification)),
          tonText: onlyValue(rows.map((row) => row.ton_text)),
        },
      ] as const;
    }),
  );

  function setModel(value: string) {
    setForm((prev) => {
      if (!prev) return prev;
      const profile = modelProfiles.get(value.trim());
      const originalMaker = currentItem.maker ?? "";
      return {
        ...prev,
        model: value,
        maker:
          (prev.maker.trim().length === 0 || prev.maker === originalMaker) &&
          profile?.maker !== undefined
            ? profile.maker
            : prev.maker,
        specification:
          (prev.specification.trim().length === 0 ||
            prev.specification === currentItem.specification) &&
          profile?.specification !== undefined
            ? profile.specification
            : prev.specification,
        ton_text:
          (prev.ton_text.trim().length === 0 || prev.ton_text === currentItem.ton_text) &&
          profile?.tonText !== undefined
            ? profile.tonText
            : prev.ton_text,
      };
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      titleId={titleId}
      closeOnScrimClick={editState !== "saving"}
      className="max-w-lg"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {editing ? ko.equipment.detail.edit : ko.equipment.detail.view}
        </h2>
        <Badge className={equipmentStatusBadgeClass(form?.status ?? item.status)}>
          {ko.equipment.statuses[form?.status ?? item.status]}
        </Badge>
      </div>

      {editing && form ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <ReadOnlyRow
              label={ko.equipment.detail.fields.equipmentNo}
              value={item.equipment_no}
            />
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor={`${titleId}-status`}
              >
                {ko.equipment.detail.fields.status}
              </label>
              <Select
                id={`${titleId}-status`}
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
            <EditField
              id={`${titleId}-management-no`}
              label={ko.equipment.detail.fields.managementNo}
              value={form.management_no}
              onChange={(v) => {
                setField("management_no", v);
              }}
            />
            <EditField
              id={`${titleId}-model`}
              label={ko.equipment.detail.fields.model}
              value={form.model}
              suggestions={suggestions.models}
              onChange={(v) => {
                setModel(v);
              }}
            />
            <EditField
              id={`${titleId}-maker`}
              label={ko.equipment.detail.fields.maker}
              value={form.maker}
              suggestions={suggestions.makers}
              onChange={(v) => {
                setField("maker", v);
              }}
            />
            <EditField
              id={`${titleId}-specification`}
              label={ko.equipment.detail.fields.specification}
              value={form.specification}
              suggestions={suggestions.specifications}
              onChange={(v) => {
                setField("specification", v);
              }}
            />
            <EditField
              id={`${titleId}-ton-text`}
              label={ko.equipment.detail.fields.tonText}
              value={form.ton_text}
              onChange={(v) => {
                setField("ton_text", v);
              }}
            />
            <EditField
              id={`${titleId}-vin`}
              label={ko.equipment.detail.fields.vin}
              value={form.vin}
              onChange={(v) => {
                setField("vin", v);
              }}
            />
            <EditField
              id={`${titleId}-customer-name`}
              label={ko.equipment.detail.fields.customerName}
              value={form.customer_name}
              suggestions={suggestions.customers}
              onChange={(v) => {
                setField("customer_name", v);
              }}
            />
            <EditField
              id={`${titleId}-site-name`}
              label={ko.equipment.detail.fields.siteName}
              value={form.site_name}
              suggestions={suggestions.sites}
              onChange={(v) => {
                setField("site_name", v);
              }}
            />
          </div>

          <FeedbackBanner
            message={
              editState === "error"
                ? ko.equipment.detail.updateFailed
                : undefined
            }
            kind="error"
          />

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={editState === "saving"}
              onClick={() => {
                setEditing(false);
                setEditState("idle");
                setForm(seedForm(item));
              }}
            >
              {ko.equipment.detail.back}
            </Button>
            <Button type="submit" disabled={editState === "saving"}>
              {editState === "saving"
                ? ko.equipment.saving
                : ko.equipment.save}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-2">
            <DetailRow
              label={ko.equipment.detail.fields.equipmentNo}
              value={item.equipment_no}
              mono
            />
            <DetailRow
              label={ko.equipment.detail.fields.managementNo}
              value={item.management_no}
            />
            <DetailRow
              label={ko.equipment.detail.fields.model}
              value={item.model}
            />
            <DetailRow
              label={ko.equipment.detail.fields.maker}
              value={item.maker}
            />
            <DetailRow
              label={ko.equipment.detail.fields.specification}
              value={item.specification}
            />
            <DetailRow
              label={ko.equipment.detail.fields.tonText}
              value={item.ton_text}
            />
            <DetailRow
              label={ko.equipment.detail.fields.assetOwner}
              value={item.asset_owner}
            />
            <DetailRow
              label={ko.equipment.detail.fields.customerName}
              value={item.customer_name}
            />
            <DetailRow
              label={ko.equipment.detail.fields.siteName}
              value={item.site_name}
            />
            <DetailRow
              label={ko.equipment.detail.fields.vin}
              value={item.vin}
              mono
            />
            <DetailRow
              label={ko.equipment.detail.fields.updatedAt}
              value={formatKoreanDate(item.updated_at)}
            />
          </dl>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {ko.equipment.detail.close}
            </Button>
            {canManage ? (
              <Button
                type="button"
                onClick={() => {
                  setEditing(true);
                  setEditState("idle");
                }}
              >
                <Pencil aria-hidden="true" size={16} />
                {ko.equipment.detail.editButton}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </Dialog>
  );
}

interface DetailRowProps {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}

function DetailRow({ label, value, mono }: DetailRowProps) {
  const text =
    value && value.trim() ? value : ko.equipment.detail.empty;
  return (
    <div className="grid gap-1">
      <dt className="text-xs font-medium text-steel">{label}</dt>
      <dd
        className={
          mono
            ? "font-mono tabular-nums tracking-tight text-sm text-ink"
            : "text-sm text-ink"
        }
      >
        {mono ? safeLabel(text, ko.equipment.detail.empty) : text}
      </dd>
    </div>
  );
}

interface EditFieldProps {
  id: string;
  label: string;
  value: string;
  suggestions?: string[];
  onChange: (value: string) => void;
}

function EditField({ id, label, value, suggestions = [], onChange }: EditFieldProps) {
  const listId = suggestions.length > 0 ? `${id}-suggestions` : undefined;
  return (
    <div className="grid gap-2">
      <label className="text-sm font-medium text-steel" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        list={listId}
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
      {listId ? (
        <datalist id={listId}>
          {suggestions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

interface ReadOnlyRowProps {
  label: string;
  value: string;
}

function ReadOnlyRow({ label, value }: ReadOnlyRowProps) {
  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium text-steel">{label}</span>
      <Mono className="text-sm text-ink">{value}</Mono>
    </div>
  );
}
