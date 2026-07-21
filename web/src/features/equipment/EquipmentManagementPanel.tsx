import { ChevronsUpDown, Pencil, Plus, Trash2 } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { createConsoleApiClient, type ConsoleApiClient } from "../../api/client";
import type { RefreshAuthority } from "../../api/refresh";
import {
  exitGroupTenantContext,
  startGroupTenantContext,
} from "../../api/groupAdmin";
import type {
  CreateEquipmentRequest,
  EquipmentLookupResponse,
  EquipmentStatus,
  UpdateEquipmentRequest,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";

export interface EquipmentOwnerOrgOption {
  id: string;
  name: string;
  slug: string;
  groupName?: string;
}

interface EquipmentManagementPanelProps {
  api: ConsoleApiClient;
  /** Equipment rows surfaced by the autocomplete search on the page. */
  results: EquipmentLookupResponse[];
  /** Re-runs the page search so the list reflects the latest writes. */
  onMutated: () => void;
  /**
   * Group-admin safe write surface. A selected owner org is realized by minting
   * a short-lived tenant context token for that org, not by trusting an `org_id`
   * body field on the equipment write request.
   */
  ownerOrgOptions?: EquipmentOwnerOrgOption[];
  ownerSelectionRequired?: boolean;
  selectedOwnerOrgId?: string;
  onSelectedOwnerOrgIdChange?: (orgId: string) => void;
  activeOrgId?: string;
  groupAdminSourceToken?: string;
  /** Exact provider/source capability for group-admin control-plane calls. */
  groupAdminRefreshAuthority?: RefreshAuthority;
}

type Mode = "idle" | "create" | "edit";
type WriteState = "idle" | "saving" | "error";
type TransferState = "idle" | "saving" | "error";

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

function seedFromSummary(summary: EquipmentLookupResponse): FormState {
  return {
    ...emptyForm(),
    equipment_no: summary.equipment_no,
    customer_name: summary.customer.name,
    site_name: summary.site.name,
    status: normalizeStatus(summary.status),
    specification: summary.specification,
    ton_text: summary.ton_text,
    management_no: summary.management_no ?? "",
    model: summary.model ?? "",
    maker: summary.maker ?? "",
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

function ownerOrgLabel(option: EquipmentOwnerOrgOption): string {
  return option.groupName ? `${option.groupName} / ${option.name}` : option.name;
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
  ownerOrgOptions = [],
  ownerSelectionRequired = false,
  selectedOwnerOrgId,
  onSelectedOwnerOrgIdChange,
  activeOrgId,
  groupAdminSourceToken,
  groupAdminRefreshAuthority,
}: EquipmentManagementPanelProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [notice, setNotice] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<EquipmentLookupResponse>();
  const [deleting, setDeleting] = useState(false);
  const [ownershipConfirmed, setOwnershipConfirmed] = useState(false);
  const [transferTargetOwner, setTransferTargetOwner] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [transferConfirmed, setTransferConfirmed] = useState(false);
  const [transferState, setTransferState] = useState<TransferState>("idle");
  const [transferNotice, setTransferNotice] = useState<string>();
  const referenceOptions = useMemo(() => {
    const customerMatches = form.customer_name.trim()
      ? results.filter((row) => row.customer.name === form.customer_name.trim())
      : results;
    return {
      customers: uniqueStrings(results.map((row) => row.customer.name)),
      sites: uniqueStrings(customerMatches.map((row) => row.site.name)),
      makers: uniqueStrings(results.map((row) => row.maker)),
      models: uniqueStrings(results.map((row) => row.model)),
      specifications: uniqueStrings(results.map((row) => row.specification)),
    };
  }, [form.customer_name, results]);
  const modelProfiles = useMemo(() => {
    const models = uniqueStrings(results.map((row) => row.model));
    return new Map(
      models.map((model) => {
        const rows = results.filter((row) => row.model === model);
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
  }, [results]);
  const selectedOwnerOrg = useMemo(
    () => ownerOrgOptions.find((option) => option.id === selectedOwnerOrgId),
    [ownerOrgOptions, selectedOwnerOrgId],
  );
  const shouldPromptOwnerSignoff = mode === "create" && ownerSelectionRequired;

  function startCreate() {
    setMode("create");
    setEditingId(undefined);
    setForm(emptyForm());
    setWriteState("idle");
    setNotice(undefined);
    setOwnershipConfirmed(false);
    resetTransferForm();
  }

  function startEdit(summary: EquipmentLookupResponse) {
    setMode("edit");
    setEditingId(summary.id);
    setForm(seedFromSummary(summary));
    setWriteState("idle");
    setNotice(undefined);
    setOwnershipConfirmed(false);
    resetTransferForm();
  }

  function closeForm() {
    setMode("idle");
    setEditingId(undefined);
    setWriteState("idle");
    setOwnershipConfirmed(false);
    resetTransferForm();
  }

  function resetTransferForm() {
    setTransferTargetOwner("");
    setTransferReason("");
    setTransferConfirmed(false);
    setTransferState("idle");
    setTransferNotice(undefined);
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setModel(value: string) {
    setForm((prev) => {
      const profile = modelProfiles.get(value.trim());
      return {
        ...prev,
        model: value,
        maker:
          prev.maker.trim().length > 0 || profile?.maker === undefined
            ? prev.maker
            : profile.maker,
        specification:
          prev.specification.trim().length > 0 ||
          profile?.specification === undefined
            ? prev.specification
            : profile.specification,
        ton_text:
          prev.ton_text.trim().length > 0 || profile?.tonText === undefined
            ? prev.ton_text
            : profile.tonText,
      };
    });
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled && mode === "create") setOwnershipConfirmed(false);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, selectedOwnerOrgId]);

  async function handleSubmit() {
    setWriteState("saving");
    let delegatedOrgId: string | undefined;
    try {
      if (mode === "create") {
        const targetOwnerOrgId = selectedOwnerOrgId?.trim();
        let writeApi = api;
        if (ownerSelectionRequired) {
          if (!targetOwnerOrgId || !selectedOwnerOrg || !ownershipConfirmed) {
            throw new Error("equipment owner organization confirmation missing");
          }
          const needsDelegatedContext =
            !activeOrgId || targetOwnerOrgId !== activeOrgId;
          if (needsDelegatedContext) {
            if (!groupAdminSourceToken) {
              throw new Error("group-admin source token missing");
            }
            const context = await startGroupTenantContext(
              groupAdminSourceToken,
              targetOwnerOrgId,
              groupAdminRefreshAuthority,
            );
            delegatedOrgId = context.acting_org_id;
            // Intentionally non-refreshable: the cookie refresh ceremony mints
            // the source group-admin identity, never this delegated tenant.
            writeApi = createConsoleApiClient(context.access_token);
          }
        }
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
        const response = await writeApi.POST("/api/v1/equipment", { body });
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
    } finally {
      if (delegatedOrgId && groupAdminSourceToken) {
        await exitGroupTenantContext(
          groupAdminSourceToken,
          delegatedOrgId,
          groupAdminRefreshAuthority,
        ).catch(
          () => {},
        );
      }
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

  async function handleOwnershipTransferRequest() {
    if (!editingId) return;
    setTransferState("saving");
    setTransferNotice(undefined);
    try {
      const toOwner = transferTargetOwner.trim();
      const reason = transferReason.trim();
      if (!toOwner || !reason || !transferConfirmed) {
        throw new Error("ownership transfer request is incomplete");
      }
      const response = await api.POST(
        "/api/v1/equipment/{id}/ownership-transfer-requests",
        {
          params: { path: { id: editingId } },
          body: { to_owner: toOwner, reason },
        },
      );
      if (!response.data) {
        throw new Error("ownership transfer request failed");
      }
      setTransferNotice(ko.equipment.transfer.requestSuccess);
      setTransferTargetOwner("");
      setTransferReason("");
      setTransferConfirmed(false);
      setTransferState("idle");
      onMutated();
    } catch {
      setTransferState("error");
    }
  }

  const submitDisabled =
    writeState === "saving" ||
    (mode === "create" &&
      (!form.equipment_no.trim() ||
        !form.customer_name.trim() ||
        !form.site_name.trim() ||
        !form.specification.trim() ||
        !form.ton_text.trim() ||
        (ownerSelectionRequired &&
          (!selectedOwnerOrgId ||
            ownerOrgOptions.length === 0 ||
            !ownershipConfirmed))));
  const transferDisabled =
    transferState === "saving" ||
    !transferTargetOwner.trim() ||
    !transferReason.trim() ||
    !transferConfirmed;

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
            {shouldPromptOwnerSignoff ? (
              <div className="grid gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 sm:col-span-2">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-start">
                  <div>
                    <label
                      className="text-sm font-semibold text-amber-950"
                      htmlFor="eq-owner-org"
                    >
                      {ko.equipment.fields.ownerOrg}
                    </label>
                    <p className="mt-1 text-xs leading-5 text-amber-900">
                      {ko.equipment.ownerOrgHelp}
                    </p>
                  </div>
                  <Select
                    id="eq-owner-org"
                    value={selectedOwnerOrgId ?? ""}
                    disabled={ownerOrgOptions.length === 0}
                    onChange={(event) => {
                      onSelectedOwnerOrgIdChange?.(event.currentTarget.value);
                    }}
                  >
                    {ownerOrgOptions.length === 0 ? (
                      <option value="">{ko.equipment.ownerOrgUnavailable}</option>
                    ) : null}
                    {ownerOrgOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {ownerOrgLabel(option)}
                      </option>
                    ))}
                  </Select>
                </div>
                <label className="flex items-start gap-2 text-sm font-medium text-amber-950">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-amber-400"
                    checked={ownershipConfirmed}
                    onChange={(event) => {
                      setOwnershipConfirmed(event.currentTarget.checked);
                    }}
                  />
                  <span>{ko.equipment.ownerOrgSignoff}</span>
                </label>
              </div>
            ) : null}
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
            <SuggestionField
              id="eq-customer-name"
              label={ko.equipment.fields.customerName}
              value={form.customer_name}
              options={referenceOptions.customers}
              onChange={(v) => {
                setField("customer_name", v);
              }}
            />
            <SuggestionField
              id="eq-site-name"
              label={ko.equipment.fields.siteName}
              value={form.site_name}
              options={referenceOptions.sites}
              onChange={(v) => {
                setField("site_name", v);
              }}
            />
            <SuggestionField
              id="eq-specification"
              label={ko.equipment.fields.specification}
              value={form.specification}
              options={referenceOptions.specifications}
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
            <SuggestionField
              id="eq-model"
              label={ko.equipment.fields.model}
              value={form.model}
              options={referenceOptions.models}
              help={ko.equipment.reference.derivedFromModel}
              onChange={setModel}
            />
            <SuggestionField
              id="eq-maker"
              label={ko.equipment.fields.maker}
              value={form.maker}
              options={referenceOptions.makers}
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
              rows={2}
              className="min-h-9"
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
          {mode === "edit" ? (
            <section
              aria-label={ko.equipment.transfer.title}
              className="grid gap-3 rounded-md border border-line bg-muted-panel/50 p-3"
            >
              <div>
                <h4 className="text-sm font-semibold text-ink">
                  {ko.equipment.transfer.title}
                </h4>
                <p className="text-xs leading-5 text-steel">
                  {ko.equipment.transfer.description}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label
                    className="text-sm font-medium text-steel"
                    htmlFor="eq-transfer-owner"
                  >
                    {ko.equipment.transfer.targetOwner}
                  </label>
                  {ownerOrgOptions.length > 0 ? (
                    <Select
                      id="eq-transfer-owner"
                      value={transferTargetOwner}
                      onChange={(event) => {
                        setTransferTargetOwner(event.currentTarget.value);
                      }}
                    >
                      <option value="">
                        {ko.equipment.transfer.targetOwnerPlaceholder}
                      </option>
                      {ownerOrgOptions.map((option) => (
                        <option key={option.id} value={option.name}>
                          {ownerOrgLabel(option)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      id="eq-transfer-owner"
                      value={transferTargetOwner}
                      placeholder={ko.equipment.transfer.targetOwnerPlaceholder}
                      onChange={(event) => {
                        setTransferTargetOwner(event.currentTarget.value);
                      }}
                    />
                  )}
                </div>
                <div className="grid gap-2">
                  <label
                    className="text-sm font-medium text-steel"
                    htmlFor="eq-transfer-reason"
                  >
                    {ko.equipment.transfer.reason}
                  </label>
                  <Textarea
                    id="eq-transfer-reason"
                    rows={2}
                    className="min-h-9"
                    value={transferReason}
                    onChange={(event) => {
                      setTransferReason(event.currentTarget.value);
                    }}
                  />
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm font-medium text-steel">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-line"
                  checked={transferConfirmed}
                  onChange={(event) => {
                    setTransferConfirmed(event.currentTarget.checked);
                  }}
                />
                <span>{ko.equipment.transfer.signoffAcknowledgement}</span>
              </label>
              {transferNotice ? (
                <p role="status" className="text-sm font-medium text-brand-teal">
                  {transferNotice}
                </p>
              ) : null}
              {transferState === "error" ? (
                <p role="alert" className="text-sm font-semibold text-red-700">
                  {ko.equipment.transfer.requestFailed}
                </p>
              ) : null}
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={transferDisabled}
                  onClick={() => {
                    void handleOwnershipTransferRequest();
                  }}
                >
                  {transferState === "saving"
                    ? ko.equipment.saving
                    : ko.equipment.transfer.requestAction}
                </Button>
              </div>
            </section>
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

      <ConfirmDialog
        open={deleteTarget !== undefined}
        title={ko.equipment.deleteTitle}
        message={
          deleteTarget
            ? ko.equipment.deleteConfirm.replace(
                "{equipmentNo}",
                deleteTarget.equipment_no,
              )
            : ""
        }
        warning={ko.equipment.deleteWarning}
        confirmLabel={ko.equipment.delete}
        busyLabel={ko.equipment.deleting}
        cancelLabel={ko.equipment.cancel}
        destructive
        busy={deleting}
        onConfirm={() => {
          void handleDelete();
        }}
        onCancel={() => {
          setDeleteTarget(undefined);
        }}
      />
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

interface SuggestionFieldProps extends FieldProps {
  options: string[];
  help?: string;
}

function SuggestionField({
  id,
  label,
  value,
  options,
  help = ko.equipment.reference.help,
  onChange,
  disabled = false,
}: SuggestionFieldProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const query = value.trim();
  const filtered = useMemo(() => {
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.length === 0) return options;
    return options.filter((option) => option.toLowerCase().includes(lowerQuery));
  }, [options, query]);
  const hasExactMatch = options.some(
    (option) => option.toLowerCase() === query.toLowerCase(),
  );
  const canCreate = query.length > 0 && !hasExactMatch;
  const rowCount = filtered.length + (canCreate ? 1 : 0);
  const safeActiveIndex =
    rowCount === 0 ? 0 : Math.min(activeIndex, rowCount - 1);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function commit(nextValue: string) {
    onChange(nextValue);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
        if (rowCount === 0) return;
        event.preventDefault();
        setOpen(true);
        setActiveIndex((current) => (current + 1) % rowCount);
        break;
      case "ArrowUp":
        if (rowCount === 0) return;
        event.preventDefault();
        setOpen(true);
        setActiveIndex((current) => (current - 1 + rowCount) % rowCount);
        break;
      case "Enter":
        if (open && rowCount > 0) {
          event.preventDefault();
          const selected =
            safeActiveIndex < filtered.length
              ? filtered[safeActiveIndex]
              : query;
          commit(selected);
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      default:
        break;
    }
  }

  const newValueLabel = ko.equipment.reference.useNewValue.replace(
    "{value}",
    query,
  );
  const activeOptionId =
    open && rowCount > 0
      ? `${listboxId}-opt-${String(safeActiveIndex)}`
      : undefined;

  return (
    <div ref={containerRef} className="relative grid gap-2">
      <label className="text-sm font-medium text-steel" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          aria-describedby={`${id}-help`}
          autoComplete="off"
          value={value}
          disabled={disabled}
          className="pr-10"
          onChange={(event) => {
            onChange(event.currentTarget.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        <ChevronsUpDown
          aria-hidden="true"
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-steel"
        />
      </div>
      <p id={`${id}-help`} className="text-xs text-steel">
        {help}
      </p>
      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="absolute left-0 right-0 top-[72px] z-20 max-h-64 overflow-y-auto rounded-md border border-line bg-white py-1 shadow-lg"
        >
          {filtered.map((option, index) => (
            <li
              key={option}
              id={`${listboxId}-opt-${String(index)}`}
              role="option"
              aria-selected={option === value}
              className={cn(
                "cursor-pointer px-3 py-2 text-sm",
                index === safeActiveIndex ? "bg-muted-panel" : "bg-white",
              )}
              onPointerDown={(event) => {
                event.preventDefault();
                commit(option);
              }}
              onMouseEnter={() => {
                setActiveIndex(index);
              }}
            >
              <span className="block truncate font-medium text-ink">
                {option}
              </span>
            </li>
          ))}
          {canCreate ? (
            <li
              id={`${listboxId}-opt-${String(filtered.length)}`}
              role="option"
              aria-selected={false}
              className={cn(
                "cursor-pointer px-3 py-2 text-sm",
                safeActiveIndex === filtered.length
                  ? "bg-muted-panel"
                  : "bg-white",
              )}
              onPointerDown={(event) => {
                event.preventDefault();
                commit(query);
              }}
              onMouseEnter={() => {
                setActiveIndex(filtered.length);
              }}
            >
              <span className="block truncate font-semibold text-brand-teal">
                {newValueLabel}
              </span>
            </li>
          ) : null}
          {rowCount === 0 ? (
            <li className="px-3 py-2 text-sm text-steel" role="presentation">
              {ko.combobox.empty}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
