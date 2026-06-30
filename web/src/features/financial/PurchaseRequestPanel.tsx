import { Plus, Trash2, UploadCloud } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type {
  CreatePurchaseRequest,
  PurchaseRequestSummary,
  PurchaseStatus,
} from "../../api/types";
import { hasAnyRole } from "../../components/shell/nav";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useActiveBranchId, useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { SUCCESS_DISMISS_MS, useAutoDismiss } from "../../lib/useAutoDismiss";
import {
  DEFAULT_FINANCIAL_CONFIG,
  formatWon,
  PURCHASE_APPROVE_ROLES,
  PURCHASE_CREATE_ROLES,
  PURCHASE_EXECUTE_ROLES,
  PURCHASE_FINAL_APPROVE_ROLES,
  PURCHASE_REJECT_ROLES,
} from "./config";
import { EquipmentSelector } from "./EquipmentSelector";
import type { SelectedEquipment } from "./EquipmentSelector";

interface PurchaseRequestPanelProps {
  api: ConsoleApiClient;
  roles: readonly string[] | undefined;
}

type WriteState = "idle" | "saving" | "error";
type Dialog = "expenditure" | "reject" | "restart" | "execute" | undefined;
type PurchaseTypeValue = CreatePurchaseRequest["purchase_type"];
type Density = "compact" | "comfortable";

interface PurchaseLineForm {
  id: string;
  item: string;
  quantity: string;
  unitSupplyPriceWon: string;
  vatWon: string;
  vatManual: boolean;
}

interface QuoteAttachmentForm {
  id: string;
  fileName: string;
  uploadState: string;
}

interface CreateForm {
  vendorName: string;
  purchaseType: PurchaseTypeValue;
  equipmentScoped: boolean;
  statementEvidenceId: string;
  memo: string;
  lines: PurchaseLineForm[];
  quoteAttachments: QuoteAttachmentForm[];
}

interface PurchasePreferences {
  density?: Density;
  sidebar_collapsed?: boolean;
  line_column_order?: string[];
  default_purchase_type?: PurchaseTypeValue;
  quote_panel?: "sidebar" | "inline";
}

const PURCHASE_TYPE_LABELS: Record<PurchaseTypeValue, string> = ko.financial.purchase.types;
const PURCHASE_TEXT = ko.financial.purchase.optionA;
let lineIdCounter = 0;
const KNL_ORG_ID = "00000000-0000-0000-0000-0000000000a1";


function newLineId() {
  lineIdCounter += 1;
  return `line-${String(lineIdCounter)}`;
}

function emptyLine(): PurchaseLineForm {
  return {
    id: newLineId(),
    item: "",
    quantity: "1",
    unitSupplyPriceWon: "",
    vatWon: "",
    vatManual: false,
  };
}

function emptyCreateForm(
  defaultPurchaseType: PurchaseTypeValue = "ONE_OFF",
  equipmentScoped = false,
): CreateForm {
  return {
    vendorName: "",
    purchaseType: defaultPurchaseType,
    equipmentScoped,
    statementEvidenceId: "",
    memo: "",
    lines: [emptyLine()],
    quoteAttachments: [],
  };
}

function numeric(value: string): number {
  const normalized = value.replaceAll(",", "").trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function lineSupplyTotal(line: PurchaseLineForm): number {
  return numeric(line.quantity) * numeric(line.unitSupplyPriceWon);
}

function lineVat(line: PurchaseLineForm): number {
  if (line.vatManual) return numeric(line.vatWon);
  return Math.floor(lineSupplyTotal(line) / 10);
}

function lineTotal(line: PurchaseLineForm): number {
  return lineSupplyTotal(line) + lineVat(line);
}

function linesTotal(lines: PurchaseLineForm[]): number {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0);
}

function lineValid(line: PurchaseLineForm): boolean {
  return (
    line.item.trim().length > 0 &&
    numeric(line.quantity) > 0 &&
    numeric(line.unitSupplyPriceWon) >= 0 &&
    lineTotal(line) > 0 &&
    (!line.vatManual || numeric(line.vatWon) >= 0)
  );
}

/** Merge a fetched/created summary into the session list (newest first, deduped). */
function upsert(
  list: PurchaseRequestSummary[],
  next: PurchaseRequestSummary,
): PurchaseRequestSummary[] {
  return [next, ...list.filter((item) => item.id !== next.id)];
}

/**
 * Pull the caller-facing reason out of an `{ error: { code, message } }` body so
 * a 4xx renders the server's actual message (e.g. quote/update policy gates)
 * rather than a generic "won't create".
 */
function errorMessage(error: unknown, fallback: string = ko.financial.purchase.createFailed): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "object" &&
    error.error !== null
  ) {
    const inner = (error as { error: { message?: unknown } }).error;
    if (typeof inner.message === "string" && inner.message.trim().length > 0) {
      return inner.message;
    }
  }
  return fallback;
}
function parsePurchasePreferences(value: unknown): PurchasePreferences {
  if (typeof value === "object" && value !== null) {
    return value;
  }
  return {};
}


export function PurchaseRequestPanel({ api, roles }: PurchaseRequestPanelProps) {
  const canCreate = hasAnyRole(roles, PURCHASE_CREATE_ROLES);
  const canApprove = hasAnyRole(roles, PURCHASE_APPROVE_ROLES);
  const canFinalApprove = hasAnyRole(roles, PURCHASE_FINAL_APPROVE_ROLES);
  const canExecute = hasAnyRole(roles, PURCHASE_EXECUTE_ROLES);
  const canReject = hasAnyRole(roles, PURCHASE_REJECT_ROLES);
  const activeBranchId = useActiveBranchId();
  const { session } = useAuth();
  const requesterLabel = session?.display_name ?? session?.email ?? PURCHASE_TEXT.requesterFallback;
  const isKnlOrg = session?.org_id === KNL_ORG_ID;

  const [requests, setRequests] = useState<PurchaseRequestSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = requests.find((item) => item.id === selectedId);

  const [creating, setCreating] = useState(false);
  const [equipment, setEquipment] = useState<SelectedEquipment>();
  const [density, setDensity] = useState<Density>("compact");
  const [preferencesSaved, setPreferencesSaved] = useState(false);
  const [form, setForm] = useState<CreateForm>(() =>
    emptyCreateForm("ONE_OFF", isKnlOrg),
  );
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [createError, setCreateError] = useState<string>();
  const [quoteState, setQuoteState] = useState<WriteState>("idle");
  const [quoteError, setQuoteError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const clearNotice = useCallback(() => {
    setNotice(undefined);
  }, []);
  useAutoDismiss(notice, clearNotice, SUCCESS_DISMISS_MS);

  const [lookupId, setLookupId] = useState("");
  const [lookupError, setLookupError] = useState(false);

  const [dialog, setDialog] = useState<Dialog>();
  const [dialogValue, setDialogValue] = useState("");
  const [actionState, setActionState] = useState<WriteState>("idle");
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    let ignore = false;
    async function loadPreferences() {
      if (typeof api.GET !== "function") return;
      const response = await api
        .GET("/api/v1/financial/purchase-requests/preferences")
        .catch(() => undefined);
      if (ignore || !response?.data) return;
      const preferences = parsePurchasePreferences(response.data.preferences);
      if (preferences.density === "compact" || preferences.density === "comfortable") {
        setDensity(preferences.density);
      }
      const preferredType = preferences.default_purchase_type;
      if (preferredType && preferredType !== "LEGACY_MANUAL") {
        setForm((prev) => ({
          ...prev,
          purchaseType: preferredType,
        }));
      }
    }
    void loadPreferences();
    return () => {
      ignore = true;
    };
  }, [api]);



  const totalWon = useMemo(() => linesTotal(form.lines), [form.lines]);
  const equipmentScoped = isKnlOrg || form.equipmentScoped;
  const branchId = equipmentScoped ? equipment?.branchId : activeBranchId;
  const attachmentIds = form.quoteAttachments.map((attachment) => attachment.id);
  const equipmentRequiredHint = PURCHASE_TEXT.equipmentRequiredHint;
  const policyMessages = [
    equipmentScoped ? PURCHASE_TEXT.policyEquipment : PURCHASE_TEXT.policyExpense,
    form.purchaseType === "REGULAR" ? PURCHASE_TEXT.policyRegular : PURCHASE_TEXT.policyOptionalQuote,
  ];

  function resetCreate() {
    setCreating(false);
    setEquipment(undefined);
    setForm(
      emptyCreateForm(
        form.purchaseType === "LEGACY_MANUAL" ? "ONE_OFF" : form.purchaseType,
        isKnlOrg,
      ),
    );
    setWriteState("idle");
    setCreateError(undefined);
    setQuoteError(undefined);
    setQuoteState("idle");
  }

  function setField<K extends keyof CreateForm>(key: K, value: CreateForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateLine(id: string, patch: Partial<PurchaseLineForm>) {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    }));
  }

  async function uploadQuote(file: File) {
    if (!branchId) {
      setQuoteError(PURCHASE_TEXT.uploadBranchRequired);
      setQuoteState("error");
      return;
    }
    setQuoteState("saving");
    setQuoteError(undefined);
    try {
      const ticket = await api.POST(
        "/api/v1/financial/purchase-requests/attachments/presign",
        {
          body: {
            branch_id: branchId,
            file_name: file.name,
            content_type: file.type || "application/pdf",
            size_bytes: file.size,
            checksum_sha256: null,
            role: "QUOTE",
          },
        },
      );
      if (ticket.error) {
        setQuoteError(errorMessage(ticket.error, PURCHASE_TEXT.uploadPresignFailed));
        setQuoteState("error");
        return;
      }
      const uploadHeaders = new Headers(
        ticket.data.upload.headers.map((header): [string, string] => {
          const [name, value] = header;
          if (name.length === 0) throw new Error("invalid upload header");
          return [name, value];
        }),
      );
      const uploaded = await fetch(ticket.data.upload.url, {
        method: ticket.data.upload.method,
        headers: uploadHeaders,
        body: file,
      });
      if (!uploaded.ok) throw new Error("quote upload failed");
      const confirmed = await api.POST(
        "/api/v1/financial/purchase-requests/attachments/{attachmentId}/confirm",
        { params: { path: { attachmentId: ticket.data.attachment_id } } },
      );
      if (confirmed.error) {
        setQuoteError(errorMessage(confirmed.error, PURCHASE_TEXT.uploadConfirmFailed));
        setQuoteState("error");
        return;
      }
      setForm((prev) => ({
        ...prev,
        quoteAttachments: [
          ...prev.quoteAttachments,
          {
            id: confirmed.data.id,
            fileName: confirmed.data.file_name,
            uploadState: confirmed.data.upload_state,
          },
        ],
      }));
      setQuoteState("idle");
    } catch {
      setQuoteError(PURCHASE_TEXT.uploadFailed);
      setQuoteState("error");
    }
  }

  async function savePreferences() {
    const response = await api.PUT("/api/v1/financial/purchase-requests/preferences", {
      body: {
        schema_version: 1,
        preferences: {
          density,
          quote_panel: "sidebar",
          line_column_order: ["item", "quantity", "unit", "vat", "total"],
          default_purchase_type: form.purchaseType,
        },
      },
    });
    if (!response.error) {
      setPreferencesSaved(true);
      setNotice(PURCHASE_TEXT.preferencesSavedToast);
    }
  }

  async function handleCreate() {
    if (!branchId) return;
    setWriteState("saving");
    setCreateError(undefined);
    try {
      const body: CreatePurchaseRequest = {
        branch_id: branchId,
        equipment_id: equipmentScoped ? equipment?.id ?? null : null,
        work_order_id: null,
        statement_evidence_id: equipmentScoped
          ? form.statementEvidenceId.trim() || null
          : null,
        purchase_type: form.purchaseType,
        vendor_name: form.vendorName.trim(),
        amount_won: totalWon,
        lines: form.lines.map((line) => ({
          item: line.item.trim(),
          quantity: Math.trunc(numeric(line.quantity)),
          unit_supply_price_won: Math.trunc(numeric(line.unitSupplyPriceWon)),
          vat_won: line.vatManual ? Math.trunc(numeric(line.vatWon)) : null,
        })),
        quote_attachment_ids: attachmentIds,
        memo: form.memo.trim(),
        config: DEFAULT_FINANCIAL_CONFIG,
      };
      const response = await api.POST("/api/v1/financial/purchase-requests", {
        body,
      });
      if (response.error) {
        setCreateError(errorMessage(response.error));
        setWriteState("error");
        return;
      }
      setRequests((prev) => upsert(prev, response.data));
      setSelectedId(response.data.id);
      setNotice(ko.financial.purchase.createSuccess);
      resetCreate();
    } catch {
      setCreateError(undefined);
      setWriteState("error");
    }
  }

  async function handleLookup() {
    const id = lookupId.trim();
    if (!id) return;
    setLookupError(false);
    try {
      const response = await api.GET(
        "/api/v1/financial/purchase-requests/{purchaseRequestId}",
        { params: { path: { purchaseRequestId: id } } },
      );
      if (!response.data) throw new Error("purchase request not found");
      setRequests((prev) => upsert(prev, response.data));
      setSelectedId(response.data.id);
      setLookupId("");
    } catch {
      setLookupError(true);
    }
  }

  function applyResult(next: PurchaseRequestSummary, message?: string) {
    setRequests((prev) => upsert(prev, next));
    setSelectedId(next.id);
    if (message) setNotice(message);
  }

  async function runAction(
    fn: () => Promise<{ data?: PurchaseRequestSummary; error?: unknown }>,
    failureMessage: string,
  ) {
    setActionState("saving");
    setActionError(undefined);
    try {
      const response = await fn();
      if (response.error) {
        setActionState("error");
        setActionError(errorMessage(response.error, failureMessage));
        return;
      }
      if (!response.data) throw new Error("action response missing data");
      applyResult(response.data);
      setActionState("idle");
      setDialog(undefined);
      setDialogValue("");
    } catch {
      setActionState("error");
      setActionError(failureMessage);
    }
  }

  function closeDialog() {
    setDialog(undefined);
    setDialogValue("");
    setActionState("idle");
    setActionError(undefined);
  }

  const createDisabled =
    writeState === "saving" ||
    !branchId ||
    !form.vendorName.trim() ||
    !form.memo.trim() ||
    form.lines.some((line) => !lineValid(line)) ||
    (equipmentScoped && (!equipment || !form.statementEvidenceId.trim()));

  const densityClass = density === "compact" ? "gap-3 p-3" : "gap-4 p-4";

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {ko.financial.purchase.listTitle}
          </h2>
          <p className="text-sm text-steel">
            {ko.financial.purchase.listDescription}
          </p>
        </div>
        {canCreate ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setCreating(true);
              setNotice(undefined);
            }}
          >
            <Plus aria-hidden="true" size={16} />
            {ko.financial.purchase.create}
          </Button>
        ) : null}
      </div>

      {notice ? (
        <p role="status" className="text-sm font-medium text-brand-teal">
          {notice}
        </p>
      ) : null}

      {creating && canCreate ? (
        <form
          aria-label={PURCHASE_TEXT.formAria}
          data-testid="purchase-request-compact-layout"
          className={`grid ${densityClass} rounded-md border border-line bg-white lg:grid-cols-[minmax(0,1fr)_22rem]`}
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <section aria-label={PURCHASE_TEXT.coreAria} className="grid gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-ink">
                  {ko.financial.purchase.createTitle}
                </h3>
                <p className="text-xs text-steel">
                  {PURCHASE_TEXT.createHelp}
                </p>
              </div>
              <div className="rounded-md bg-muted-panel px-3 py-2 text-right">
                <p className="text-xs text-steel">{PURCHASE_TEXT.totalLabel}</p>
                <p className="text-lg font-bold text-ink">
                  {formatWon(totalWon)} {ko.financial.wonUnit}
                </p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-[1fr_12rem_10rem]">
              <Field
                id="pr-vendor"
                label={ko.financial.purchase.fields.vendorName}
                placeholder={ko.financial.purchase.fields.vendorNamePlaceholder}
                value={form.vendorName}
                onChange={(value) => { setField("vendorName", value); }}
              />
              <SelectField
                id="pr-purchase-type"
                label={PURCHASE_TEXT.purchaseType}
                value={form.purchaseType}
                onChange={(value) => {
                  if (value !== "LEGACY_MANUAL") setField("purchaseType", value);
                }}
                options={[
                  ["REGULAR", PURCHASE_TYPE_LABELS.REGULAR],
                  ["ONE_OFF", PURCHASE_TYPE_LABELS.ONE_OFF],
                  ["OTHER", PURCHASE_TYPE_LABELS.OTHER],
                ]}
              />
              <Field
                id="pr-amount"
                label={ko.financial.purchase.fields.amountWon}
                value={String(totalWon)}
                onChange={() => {}}
                inputMode="numeric"
                readOnly
              />
            </div>

            <div className="grid gap-2 rounded-md border border-line bg-muted-panel p-3">
              <label className="flex items-center gap-2 text-sm font-semibold text-ink">
                <input
                  type="checkbox"
                  checked={equipmentScoped}
                  disabled={isKnlOrg}
                  onChange={(event) => {
                    setField("equipmentScoped", event.currentTarget.checked);
                    if (!event.currentTarget.checked) {
                      setEquipment(undefined);
                      setField("statementEvidenceId", "");
                    }
                  }}
                />
                {PURCHASE_TEXT.equipmentScoped}
              </label>
              <p className="text-xs text-steel">{equipmentRequiredHint}</p>
              {equipmentScoped ? (
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)]">
                  <EquipmentSelector
                    api={api}
                    selected={equipment}
                    onSelect={setEquipment}
                  />
                  <Field
                    id="pr-evidence"
                    label={ko.financial.purchase.fields.statementEvidenceId}
                    placeholder={ko.financial.purchase.fields.statementEvidenceIdPlaceholder}
                    value={form.statementEvidenceId}
                    onChange={(value) => { setField("statementEvidenceId", value); }}
                  />
                </div>
              ) : null}
            </div>

            <LineItemGrid
              lines={form.lines}
              density={density}
              onChange={updateLine}
              onAdd={() => {
                setForm((prev) => ({ ...prev, lines: [...prev.lines, emptyLine()] }));
              }}
              onRemove={(id) => {
                setForm((prev) => ({
                  ...prev,
                  lines:
                    prev.lines.length === 1
                      ? prev.lines
                      : prev.lines.filter((line) => line.id !== id),
                }));
              }}
            />

            <div className="grid gap-2">
              <label className="text-sm font-medium text-steel" htmlFor="pr-memo">
                {ko.financial.purchase.fields.memo}
              </label>
              <Textarea
                id="pr-memo"
                rows={2}
                className="min-h-9"
                value={form.memo}
                placeholder={ko.financial.purchase.fields.memoPlaceholder}
                onChange={(event) => { setField("memo", event.currentTarget.value); }}
              />
            </div>
          </section>

          <aside className="grid content-start gap-3 rounded-md border border-line bg-muted-panel p-3 lg:sticky lg:top-4">
            <section aria-label={PURCHASE_TEXT.requesterApprovalAria} className="grid gap-2">
              <h4 className="text-sm font-semibold text-ink">{PURCHASE_TEXT.requesterApprovalTitle}</h4>
              <div className="grid gap-1 text-sm">
                <span className="text-steel">{PURCHASE_TEXT.requester}</span>
                <strong className="text-ink">{requesterLabel}</strong>
                <span className="text-xs text-steel">
                  {branchId ? PURCHASE_TEXT.branchOk : PURCHASE_TEXT.branchRequired}
                </span>
              </div>
              <div className="rounded-md bg-white p-2 text-xs text-steel">
                {PURCHASE_TEXT.approvalFlow}
              </div>
            </section>

            <section aria-label={PURCHASE_TEXT.policyAria} className="grid gap-2">
              <h4 className="text-sm font-semibold text-ink">{PURCHASE_TEXT.policyTitle}</h4>
              <ul className="grid gap-1 text-xs text-steel">
                {policyMessages.map((message) => (
                  <li key={message} className="rounded bg-white px-2 py-1">
                    {message}
                  </li>
                ))}
              </ul>
            </section>

            <section aria-label={PURCHASE_TEXT.quoteAria} className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-ink">{PURCHASE_TEXT.quoteTitle}</h4>
                <Badge>{PURCHASE_TEXT.count(form.quoteAttachments.length)}</Badge>
              </div>
              <label className="grid cursor-pointer gap-1 rounded-md border border-dashed border-line bg-white p-3 text-center text-sm text-steel hover:bg-muted-panel">
                <UploadCloud className="mx-auto" aria-hidden="true" size={18} />
                <span>{PURCHASE_TEXT.quoteUpload}</span>
                <span className="text-xs">{PURCHASE_TEXT.quoteUploadHelp}</span>
                <input
                  type="file"
                  aria-label={PURCHASE_TEXT.quoteUpload}
                  className="sr-only"
                  accept="application/pdf,image/*"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void uploadQuote(file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              {quoteState === "saving" ? (
                <p className="text-xs font-medium text-steel">{PURCHASE_TEXT.quoteUploading}</p>
              ) : null}
              {quoteError ? (
                <p role="alert" className="text-xs font-semibold text-red-700">
                  {quoteError}
                </p>
              ) : null}
              <div className="grid gap-1">
                {form.quoteAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="flex items-center justify-between gap-2 rounded bg-white px-2 py-1 text-xs"
                  >
                    <span className="truncate text-ink">{attachment.fileName}</span>
                    <span className="text-steel">{attachment.uploadState}</span>
                  </div>
                ))}
              </div>
            </section>

            <section aria-label={PURCHASE_TEXT.workspaceAria} className="grid gap-2">
              <SelectField
                id="purchase-density"
                label={PURCHASE_TEXT.densityLabel}
                value={density}
                onChange={setDensity}
                options={[
                  ["compact", PURCHASE_TEXT.densityCompact],
                  ["comfortable", PURCHASE_TEXT.densityComfortable],
                ]}
              />
              <Button
                type="button"
                size="xs"
                variant="secondary"
                onClick={() => void savePreferences()}
              >
                {PURCHASE_TEXT.saveLayout}
              </Button>
              {preferencesSaved ? (
                <p className="text-xs text-brand-teal">{PURCHASE_TEXT.preferencesSavedInline}</p>
              ) : null}
            </section>

            {writeState === "error" ? (
              <p role="alert" className="text-sm font-semibold text-red-700">
                {createError ?? ko.financial.purchase.createFailed}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={writeState === "saving"}
                onClick={resetCreate}
              >
                {ko.financial.purchase.cancel}
              </Button>
              <Button type="submit" size="sm" disabled={createDisabled}>
                {writeState === "saving" ? ko.financial.purchase.saving : ko.financial.purchase.save}
              </Button>
            </div>
          </aside>
        </form>
      ) : null}

      <section aria-label={PURCHASE_TEXT.lookupAria} className="grid gap-2 rounded-md border border-line p-3">
        <label className="text-sm font-medium text-steel" htmlFor="pr-lookup">
          {ko.financial.purchase.lookupLabel}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="pr-lookup"
            value={lookupId}
            placeholder={ko.financial.purchase.lookupPlaceholder}
            onChange={(event) => { setLookupId(event.currentTarget.value); }}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={lookupId.trim().length === 0}
            onClick={() => void handleLookup()}
          >
            {ko.financial.purchase.lookup}
          </Button>
        </div>
        {lookupError ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {ko.financial.purchase.lookupFailed}
          </p>
        ) : null}
      </section>

      <section aria-label={PURCHASE_TEXT.recentAria} className="grid gap-2">
        {requests.length === 0 ? (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
            {ko.financial.purchase.empty}
          </p>
        ) : (
          requests.map((request) => (
            <button
              key={request.id}
              type="button"
              aria-pressed={request.id === selectedId}
              className={`grid gap-2 rounded-md border p-3 text-left md:grid-cols-[1fr_auto_auto] md:items-center ${
                request.id === selectedId
                  ? "border-ink bg-muted-panel"
                  : "border-line hover:bg-muted-panel"
              }`}
              onClick={() => {
                setSelectedId(request.id);
                setNotice(undefined);
              }}
            >
              <div className="grid gap-1">
                <span className="font-semibold text-ink">{request.vendor_name}</span>
                <span className="text-sm text-steel">
                  {PURCHASE_TEXT.requesterMeta(request.requester.display_name, PURCHASE_TYPE_LABELS[request.purchase_type])}
                </span>
              </div>
              <span className="font-bold text-ink">
                {formatWon(request.amount_won)} {ko.financial.wonUnit}
              </span>
              <Badge>{ko.financial.statuses[request.status]}</Badge>
            </button>
          ))
        )}
      </section>

      {selected ? (
        <PurchaseDetail
          api={api}
          request={selected}
          canCreate={canCreate}
          canApprove={canApprove}
          canFinalApprove={canFinalApprove}
          canExecute={canExecute}
          canReject={canReject}
          actionState={actionState}
          actionError={actionError}
          onOpenDialog={(next) => {
            setDialog(next);
            setDialogValue("");
            setActionError(undefined);
          }}
          onSubmit={() => {
            void runAction(
              () =>
                api.POST(
                  "/api/v1/financial/purchase-requests/{purchaseRequestId}/submit",
                  { params: { path: { purchaseRequestId: selected.id } } },
                ),
              ko.financial.purchase.submitFailed,
            );
          }}
          onApproveAdmin={() => {
            void runAction(
              () =>
                api.POST(
                  "/api/v1/financial/purchase-requests/{purchaseRequestId}/approve-admin",
                  { params: { path: { purchaseRequestId: selected.id } } },
                ),
              ko.financial.purchase.approveAdminFailed,
            );
          }}
          onApproveExecutive={() => {
            void runAction(
              () =>
                api.POST(
                  "/api/v1/financial/purchase-requests/{purchaseRequestId}/approve-executive",
                  { params: { path: { purchaseRequestId: selected.id } } },
                ),
              ko.financial.purchase.approveExecutiveFailed,
            );
          }}
        />
      ) : null}

      {dialog === "expenditure" && selected ? (
        <ActionDialog
          title={ko.financial.purchase.expenditure.title}
          label={ko.financial.purchase.expenditure.no}
          placeholder={ko.financial.purchase.expenditure.noPlaceholder}
          value={dialogValue}
          onChange={setDialogValue}
          confirmLabel={ko.financial.purchase.expenditure.confirm}
          confirmDisabled={dialogValue.trim().length === 0}
          state={actionState}
          error={actionError}
          onCancel={closeDialog}
          onConfirm={() => {
            void runAction(
              () =>
                api.POST(
                  "/api/v1/financial/purchase-requests/{purchaseRequestId}/prepare-expenditure",
                  {
                    params: { path: { purchaseRequestId: selected.id } },
                    body: { expenditure_no: dialogValue.trim() },
                  },
                ),
              ko.financial.purchase.expenditure.failed,
            );
          }}
        />
      ) : null}

      {dialog === "reject" && selected ? (
        <ActionDialog
          title={ko.financial.purchase.reject.title}
          label={ko.financial.purchase.reject.memo}
          placeholder={ko.financial.purchase.reject.memoPlaceholder}
          value={dialogValue}
          onChange={setDialogValue}
          confirmLabel={ko.financial.purchase.reject.confirm}
          confirmDisabled={dialogValue.trim().length === 0}
          confirmVariant="destructive"
          state={actionState}
          error={actionError}
          onCancel={closeDialog}
          onConfirm={() => {
            void runAction(
              () =>
                api.POST(
                  "/api/v1/financial/purchase-requests/{purchaseRequestId}/reject",
                  {
                    params: { path: { purchaseRequestId: selected.id } },
                    body: { memo: dialogValue.trim() },
                  },
                ),
              ko.financial.purchase.rejectFailed,
            );
          }}
        />
      ) : null}

      {dialog === "restart" && selected ? (
        <RestartDialog
          request={selected}
          state={actionState}
          error={actionError}
          onCancel={closeDialog}
          onConfirm={(statementEvidenceId, memo) => {
            void runAction(
              () =>
                api.POST(
                  "/api/v1/financial/purchase-requests/{purchaseRequestId}/restart",
                  {
                    params: { path: { purchaseRequestId: selected.id } },
                    body: {
                      statement_evidence_id: statementEvidenceId || null,
                      amount_won: null,
                      lines: selected.lines.map((line) => ({
                        item: line.item,
                        quantity: line.quantity,
                        unit_supply_price_won: line.unit_supply_price_won,
                        vat_won: line.vat_overridden ? line.vat_won : null,
                      })),
                      quote_attachment_ids: selected.quote_attachments.map((attachment) => attachment.id),
                      memo,
                    },
                  },
                ),
              ko.financial.purchase.restartFailed,
            );
          }}
        />
      ) : null}

      {dialog === "execute" && selected ? (
        <ConfirmDialog
          title={ko.financial.purchase.executeConfirm.title}
          body={
            selected.equipment_id
              ? ko.financial.purchase.executeConfirm.body
              : PURCHASE_TEXT.expenseExecuteBody
          }
          confirmLabel={ko.financial.purchase.executeConfirm.confirm}
          state={actionState}
          error={actionError}
          onCancel={closeDialog}
          onConfirm={() => {
            void runAction(
              () =>
                api.POST(
                  "/api/v1/financial/purchase-requests/{purchaseRequestId}/execute",
                  { params: { path: { purchaseRequestId: selected.id } } },
                ),
              ko.financial.purchase.executeFailed,
            );
          }}
        />
      ) : null}
    </Card>
  );
}

function LineItemGrid({
  lines,
  density,
  onChange,
  onAdd,
  onRemove,
}: {
  lines: PurchaseLineForm[];
  density: Density;
  onChange: (id: string, patch: Partial<PurchaseLineForm>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const rowPadding = density === "compact" ? "py-1" : "py-2";
  return (
    <section aria-label={PURCHASE_TEXT.lineItemsAria} className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">{PURCHASE_TEXT.lineItemsTitle}</h4>
        <Button type="button" size="xs" variant="secondary" onClick={onAdd}>
          {PURCHASE_TEXT.addLine}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="min-w-[760px] w-full border-collapse text-sm">
          <thead className="bg-muted-panel text-xs text-steel">
            <tr>
              <th className="px-2 py-2 text-left">{PURCHASE_TEXT.columns.item}</th>
              <th className="w-24 px-2 py-2 text-right">{PURCHASE_TEXT.columns.quantity}</th>
              <th className="w-36 px-2 py-2 text-right">{PURCHASE_TEXT.columns.unitSupplyPrice}</th>
              <th className="w-32 px-2 py-2 text-right">{PURCHASE_TEXT.columns.vat}</th>
              <th className="w-32 px-2 py-2 text-right">{PURCHASE_TEXT.columns.lineTotal}</th>
              <th className="w-12 px-2 py-2 text-right">{PURCHASE_TEXT.columns.delete}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const row = String(index + 1);
              const autoVat = Math.floor(lineSupplyTotal(line) / 10);
              return (
                <tr key={line.id} className="border-t border-line bg-white">
                  <td className={`px-2 ${rowPadding}`}>
                    <Input
                      aria-label={PURCHASE_TEXT.lineItemAria(row)}
                      value={line.item}
                      className="min-h-8"
                      onChange={(event) => { onChange(line.id, { item: event.currentTarget.value }); }}
                    />
                  </td>
                  <td className={`px-2 ${rowPadding}`}>
                    <Input
                      aria-label={PURCHASE_TEXT.quantityAria(row)}
                      inputMode="numeric"
                      value={line.quantity}
                      className="min-h-8 text-right"
                      onChange={(event) => { onChange(line.id, { quantity: event.currentTarget.value }); }}
                    />
                  </td>
                  <td className={`px-2 ${rowPadding}`}>
                    <Input
                      aria-label={PURCHASE_TEXT.unitSupplyAria(row)}
                      inputMode="numeric"
                      value={line.unitSupplyPriceWon}
                      className="min-h-8 text-right"
                      onChange={(event) =>
                        { onChange(line.id, { unitSupplyPriceWon: event.currentTarget.value }); }
                      }
                    />
                  </td>
                  <td className={`px-2 ${rowPadding}`}>
                    <Input
                      aria-label={PURCHASE_TEXT.vatAria(row)}
                      inputMode="numeric"
                      value={line.vatManual ? line.vatWon : String(autoVat)}
                      className="min-h-8 text-right"
                      onChange={(event) =>
                        { onChange(line.id, {
                          vatWon: event.currentTarget.value,
                          vatManual: true,
                        }); }
                      }
                    />
                    {!line.vatManual ? (
                      <span className="block text-right text-[11px] text-steel">{PURCHASE_TEXT.autoVat}</span>
                    ) : null}
                  </td>
                  <td className={`px-2 text-right font-semibold text-ink ${rowPadding}`}>
                    <output aria-label={PURCHASE_TEXT.lineTotalAria(row)}>
                      {formatWon(lineTotal(line))}
                    </output>
                  </td>
                  <td className={`px-2 text-right ${rowPadding}`}>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={PURCHASE_TEXT.deleteLineAria(row)}
                      onClick={() => { onRemove(line.id); }}
                    >
                      <Trash2 aria-hidden="true" size={14} />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface PurchaseDetailProps {
  api: ConsoleApiClient;
  request: PurchaseRequestSummary;
  canCreate: boolean;
  canApprove: boolean;
  canFinalApprove: boolean;
  canExecute: boolean;
  canReject: boolean;
  actionState: WriteState;
  actionError?: string;
  onOpenDialog: (dialog: Dialog) => void;
  onSubmit: () => void;
  onApproveAdmin: () => void;
  onApproveExecutive: () => void;
}

/** Status-driven action set, each control gated to its backend Feature. */
function availableActions(
  status: PurchaseStatus,
  perms: {
    canCreate: boolean;
    canApprove: boolean;
    canFinalApprove: boolean;
    canExecute: boolean;
    canReject: boolean;
  },
): {
  submit?: boolean;
  approveAdmin?: boolean;
  prepareExpenditure?: boolean;
  approveExecutive?: boolean;
  execute?: boolean;
  reject?: boolean;
  restart?: boolean;
} {
  switch (status) {
    case "STATEMENT_ATTACHED":
      return { submit: perms.canCreate };
    case "REQUEST_SUBMITTED":
      return { approveAdmin: perms.canApprove, reject: perms.canReject };
    case "ADMIN_APPROVED":
      return { prepareExpenditure: perms.canCreate, reject: perms.canReject };
    case "EXECUTIVE_PENDING":
      return { approveExecutive: perms.canFinalApprove, reject: perms.canReject };
    case "READY_TO_EXECUTE":
      return { execute: perms.canExecute };
    case "REJECTED":
      return { restart: perms.canCreate };
    case "EXECUTED":
    default:
      return {};
  }
}

function PurchaseDetail({
  api,
  request,
  canCreate,
  canApprove,
  canFinalApprove,
  canExecute,
  canReject,
  actionState,
  actionError,
  onOpenDialog,
  onSubmit,
  onApproveAdmin,
  onApproveExecutive,
}: PurchaseDetailProps) {
  const actions = availableActions(request.status, {
    canCreate,
    canApprove,
    canFinalApprove,
    canExecute,
    canReject,
  });
  const busy = actionState === "saving";
  const hasAction = Object.values(actions).some(Boolean);
  async function openQuoteAttachment(attachmentId: string) {
    const response = await api
      .GET(
        "/api/v1/financial/purchase-requests/{purchaseRequestId}/attachments/{attachmentId}/download",
        {
          params: { path: { purchaseRequestId: request.id, attachmentId } },
        },
      )
      .catch(() => undefined);
    if (response?.data?.url) {
      globalThis.open(response.data.url, "_blank", "noopener,noreferrer");
    }
  }


  return (
    <section aria-label={PURCHASE_TEXT.detailAria} className="grid gap-3 rounded-md border border-line bg-muted-panel p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-ink">{ko.financial.purchase.detailTitle}</h3>
          <p className="text-sm text-steel">
            {PURCHASE_TEXT.requesterMeta(request.requester.display_name, PURCHASE_TYPE_LABELS[request.purchase_type])}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{ko.financial.statuses[request.status]}</Badge>
          <strong className="text-ink">
            {formatWon(request.amount_won)} {ko.financial.wonUnit}
          </strong>
        </div>
      </div>

      {request.policy.messages.length > 0 || request.policy.quote_update_required ? (
        <div role="alert" className="grid gap-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>{PURCHASE_TEXT.policyRequired}</strong>
          {request.policy.messages.map((message) => (
            <span key={message}>{message}</span>
          ))}
          {request.policy.quote_update_required ? <span>{PURCHASE_TEXT.quoteUpdateRequired}</span> : null}
        </div>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <PurchaseApprovalLine request={request} />
        <FinanceControlBadges request={request} />
      </div>

      <SourceObjectRail request={request} />


      <dl className="grid gap-2 text-sm md:grid-cols-3">
        <Row label={ko.financial.purchase.vendor} value={request.vendor_name} />
        <Row label={PURCHASE_TEXT.requester} value={request.requester.display_name} />
        <Row label={PURCHASE_TEXT.purchaseType} value={PURCHASE_TYPE_LABELS[request.purchase_type]} />
        <Row label={PURCHASE_TEXT.processingLedger} value={request.equipment_id ? PURCHASE_TEXT.equipmentLedger : PURCHASE_TEXT.expenseLedger} />
        {request.statement_evidence_id ? (
          <Row label={ko.financial.purchase.statementEvidenceId} value={request.statement_evidence_id} />
        ) : null}
        {request.expenditure_no ? <Row label={ko.financial.purchase.expenditureNo} value={request.expenditure_no} /> : null}
        {request.rejection_memo ? <Row label={ko.financial.purchase.rejectionMemo} value={request.rejection_memo} /> : null}
      </dl>

      <section aria-label={PURCHASE_TEXT.detailLinesAria} className="overflow-x-auto rounded-md border border-line bg-white">
        <table className="min-w-[640px] w-full text-sm">
          <thead className="bg-muted-panel text-xs text-steel">
            <tr>
              <th className="px-2 py-2 text-left">{PURCHASE_TEXT.columns.item}</th>
              <th className="px-2 py-2 text-right">{PURCHASE_TEXT.columns.quantity}</th>
              <th className="px-2 py-2 text-right">{PURCHASE_TEXT.columns.unitSupplyPriceShort}</th>
              <th className="px-2 py-2 text-right">{PURCHASE_TEXT.columns.vat}</th>
              <th className="px-2 py-2 text-right">{PURCHASE_TEXT.columns.total}</th>
            </tr>
          </thead>
          <tbody>
            {request.lines.map((line) => (
              <tr key={`${line.id}-${String(line.line_no)}`} className="border-t border-line">
                <td className="px-2 py-2 text-ink">{line.item}</td>
                <td className="px-2 py-2 text-right">{line.quantity}</td>
                <td className="px-2 py-2 text-right">{formatWon(line.unit_supply_price_won)}</td>
                <td className="px-2 py-2 text-right">
                  {formatWon(line.vat_won)}{line.vat_overridden ? PURCHASE_TEXT.manualVatSuffix : ""}
                </td>
                <td className="px-2 py-2 text-right font-semibold">{formatWon(line.line_total_won)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label={PURCHASE_TEXT.quoteAttachmentsAria} className="grid gap-2 rounded-md border border-line bg-white p-3">
        <h4 className="text-sm font-semibold text-ink">{PURCHASE_TEXT.quoteAttachmentsTitle}</h4>
        {request.quote_attachments.length === 0 ? (
          <p className="text-sm text-steel">{PURCHASE_TEXT.noQuoteAttachments}</p>
        ) : (
          <div className="grid gap-1">
            {request.quote_attachments.map((attachment) => (
              <a
                key={attachment.id}
                href={attachment.download_url}
                onClick={(event) => {
                  event.preventDefault();
                  void openQuoteAttachment(attachment.id);
                }}
                className="flex items-center justify-between gap-2 rounded bg-muted-panel px-2 py-1 text-sm text-ink underline-offset-2 hover:underline"
              >
                <span>{attachment.file_name}</span>
                <span className="text-xs text-steel">{PURCHASE_TEXT.sizeKb(Math.ceil(attachment.size_bytes / 1024))}</span>
              </a>
            ))}
          </div>
        )}
      </section>

      <StatementEvidencePreview
        api={api}
        evidenceId={request.statement_evidence_id}
        loadThumbnail={canCreate || canApprove || canFinalApprove || canExecute}
      />

      <div className="flex flex-wrap items-center gap-2">
        {actions.submit ? (
          <Button type="button" size="sm" disabled={busy || request.policy.submit_blocked} onClick={onSubmit}>
            {busy ? ko.financial.purchase.actions.working : ko.financial.purchase.actions.submit}
          </Button>
        ) : null}
        {actions.approveAdmin ? (
          <Button type="button" size="sm" disabled={busy} onClick={onApproveAdmin}>
            {busy ? ko.financial.purchase.actions.working : ko.financial.purchase.actions.approveAdmin}
          </Button>
        ) : null}
        {actions.prepareExpenditure ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => { onOpenDialog("expenditure"); }}>
            {ko.financial.purchase.actions.prepareExpenditure}
          </Button>
        ) : null}
        {actions.approveExecutive ? (
          <Button type="button" size="sm" disabled={busy} onClick={onApproveExecutive}>
            {busy ? ko.financial.purchase.actions.working : ko.financial.purchase.actions.approveExecutive}
          </Button>
        ) : null}
        {actions.execute ? (
          <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => { onOpenDialog("execute"); }}>
            {ko.financial.purchase.actions.execute}
          </Button>
        ) : null}
        {actions.reject ? (
          <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => { onOpenDialog("reject"); }}>
            {ko.financial.purchase.actions.reject}
          </Button>
        ) : null}
        {actions.restart ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => { onOpenDialog("restart"); }}>
            {ko.financial.purchase.actions.restart}
          </Button>
        ) : null}
        {!hasAction ? <p className="text-sm text-steel">{ko.financial.purchase.actions.none}</p> : null}
      </div>
      {actionState === "error" && actionError ? (
        <p role="alert" className="text-sm font-semibold text-red-700">{actionError}</p>
      ) : null}
    </section>
  );
}

function purchaseApprovalStageIndex(status: PurchaseStatus): number {
  switch (status) {
    case "STATEMENT_ATTACHED":
      return 0;
    case "REQUEST_SUBMITTED":
      return 1;
    case "ADMIN_APPROVED":
      return 2;
    case "EXECUTIVE_PENDING":
      return 4;
    case "READY_TO_EXECUTE":
      return 5;
    case "EXECUTED":
      return 6;
    case "REJECTED":
    default:
      return 0;
  }
}

function PurchaseApprovalLine({ request }: { request: PurchaseRequestSummary }) {
  const currentStage = purchaseApprovalStageIndex(request.status);
  const stages = [
    PURCHASE_TEXT.approvalStageCreate,
    PURCHASE_TEXT.approvalStageSubmit,
    PURCHASE_TEXT.approvalStageAdmin,
    PURCHASE_TEXT.approvalStageExpenditure,
    PURCHASE_TEXT.approvalStageExecutive,
    PURCHASE_TEXT.approvalStageExecute,
  ];

  return (
    <section aria-label={PURCHASE_TEXT.approvalLineAria} className="grid gap-2 rounded-md border border-line bg-white p-3">
      <h4 className="text-sm font-semibold text-ink">{PURCHASE_TEXT.approvalLineTitle}</h4>
      <ol className="grid gap-1 sm:grid-cols-3 xl:grid-cols-6">
        {stages.map((label, index) => {
          const state =
            index < currentStage
              ? PURCHASE_TEXT.approvalStageDone
              : index === currentStage
                ? PURCHASE_TEXT.approvalStageCurrent
                : PURCHASE_TEXT.approvalStagePending;
          return (
            <li key={label} className="rounded bg-muted-panel px-2 py-1 text-xs text-steel">
              <span className="block font-semibold text-ink">{label}</span>
              <span>{state}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function FinanceControlBadges({ request }: { request: PurchaseRequestSummary }) {
  const controls = [
    PURCHASE_TEXT.controlPolicy,
    PURCHASE_TEXT.controlAudit,
    PURCHASE_TEXT.controlPasskey,
    request.policy.quote_update_required
      ? PURCHASE_TEXT.controlQuoteBlocked
      : PURCHASE_TEXT.controlQuoteReady,
  ];

  return (
    <section aria-label={PURCHASE_TEXT.controlBadgesAria} className="grid gap-2 rounded-md border border-line bg-white p-3">
      <h4 className="text-sm font-semibold text-ink">{PURCHASE_TEXT.controlBadgesTitle}</h4>
      <div className="flex flex-wrap gap-1">
        {controls.map((control) => (
          <Badge key={control}>{control}</Badge>
        ))}
      </div>
    </section>
  );
}

function SourceObjectRail({ request }: { request: PurchaseRequestSummary }) {
  const sources: Array<{ key: string; label: string; value: string; href?: string }> = [
    { key: "purchase", label: PURCHASE_TEXT.sourcePurchase, value: request.id },
  ];
  if (request.work_order_id) {
    sources.push({
      key: "workOrder",
      label: PURCHASE_TEXT.sourceWorkOrder,
      value: request.work_order_id,
      href: `/work-orders/${request.work_order_id}`,
    });
  }
  if (request.equipment_id) {
    sources.push({
      key: "equipment",
      label: PURCHASE_TEXT.sourceEquipment,
      value: request.equipment_id,
    });
  }
  if (request.statement_evidence_id) {
    sources.push({
      key: "evidence",
      label: PURCHASE_TEXT.sourceEvidence,
      value: request.statement_evidence_id,
    });
  }

  return (
    <section aria-label={PURCHASE_TEXT.sourceRailAria} className="grid gap-2 rounded-md border border-line bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">{PURCHASE_TEXT.sourceRailTitle}</h4>
        <Badge>{PURCHASE_TEXT.sourceCount(sources.length)}</Badge>
      </div>
      <div className="grid gap-1 md:grid-cols-2">
        {sources.map((source) => {
          const content = (
            <>
              <span className="font-semibold text-ink">{source.label}</span>
              <span className="break-all text-steel">{source.value}</span>
              <span className="text-xs text-steel">
                {source.href ? PURCHASE_TEXT.sourceOpen : PURCHASE_TEXT.sourceLinked}
              </span>
            </>
          );
          return source.href ? (
            <a
              key={source.key}
              href={source.href}
              className="grid gap-1 rounded bg-muted-panel px-2 py-1 text-sm underline-offset-2 hover:underline"
            >
              {content}
            </a>
          ) : (
            <div key={source.key} className="grid gap-1 rounded bg-muted-panel px-2 py-1 text-sm">
              {content}
            </div>
          );
        })}
      </div>
    </section>
  );
}
function StatementEvidencePreview({
  api,
  evidenceId,
  loadThumbnail,
}: {
  api: ConsoleApiClient;
  evidenceId?: string | null;
  loadThumbnail: boolean;
}) {
  const [preview, setPreview] = useState<{
    evidenceId: string;
    thumbnailUrl?: string;
    loadFailed: boolean;
  }>({ evidenceId: "", loadFailed: false });
  const thumbnailUrl = evidenceId && preview.evidenceId === evidenceId ? preview.thumbnailUrl : undefined;
  const loadFailed = Boolean(evidenceId && preview.evidenceId === evidenceId && preview.loadFailed);

  useEffect(() => {
    if (!evidenceId || !loadThumbnail) return;
    let ignore = false;
    async function loadEvidenceThumbnail() {
      const response = await api
        .GET("/api/v1/evidence/{evidenceId}/status", {
          params: { path: { evidenceId: evidenceId ?? "" } },
        })
        .catch(() => undefined);
      if (ignore || !evidenceId) return;
      if (response?.data?.thumbnail_url) {
        setPreview({ evidenceId, thumbnailUrl: response.data.thumbnail_url, loadFailed: false });
      } else {
        setPreview({ evidenceId, loadFailed: true });
      }
    }
    void loadEvidenceThumbnail();
    return () => {
      ignore = true;
    };
  }, [api, evidenceId, loadThumbnail]);

  if (!evidenceId) return null;

  return (
    <section className="grid gap-2 rounded-md border border-line bg-white p-3">
      <h4 className="text-sm font-semibold text-steel">
        {ko.financial.purchase.statementEvidencePreview}
      </h4>
      <div className="flex items-center gap-3">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={ko.financial.purchase.statementEvidenceThumbAlt}
            className="h-20 w-20 flex-shrink-0 rounded object-cover"
          />
        ) : (
          <div aria-hidden="true" className="h-20 w-20 flex-shrink-0 rounded bg-muted-panel" />
        )}
        <div className="min-w-0 text-sm">
          <p className="font-medium text-ink">{ko.financial.purchase.statementEvidenceId}</p>
          <p className="break-all text-steel">{evidenceId}</p>
          {loadFailed ? <p className="mt-1 text-amber-800">{ko.financial.purchase.statementEvidenceUnavailable}</p> : null}
        </div>
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="font-semibold text-steel">{label}</dt>
      <dd className="break-words text-ink">{value}</dd>
    </div>
  );
}

interface ActionDialogProps {
  title: string;
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmVariant?: "default" | "destructive";
  state: WriteState;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

function ActionDialog({
  title,
  label,
  placeholder,
  value,
  onChange,
  confirmLabel,
  confirmDisabled,
  confirmVariant = "default",
  state,
  error,
  onCancel,
  onConfirm,
}: ActionDialogProps) {
  const busy = state === "saving";
  return (
    <DialogShell title={title} onCancel={onCancel} busy={busy}>
      <div className="grid gap-2">
        <label className="text-sm font-medium text-steel" htmlFor="financial-action-input">
          {label}
        </label>
        <Input
          id="financial-action-input"
          value={value}
          placeholder={placeholder}
          onChange={(event) => { onChange(event.currentTarget.value); }}
        />
      </div>
      {error ? <p role="alert" className="text-sm font-semibold text-red-700">{error}</p> : null}
      <DialogActions
        busy={busy}
        confirmLabel={confirmLabel}
        confirmDisabled={confirmDisabled}
        confirmVariant={confirmVariant}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </DialogShell>
  );
}

interface RestartDialogProps {
  request: PurchaseRequestSummary;
  state: WriteState;
  error?: string;
  onCancel: () => void;
  onConfirm: (statementEvidenceId: string, memo: string) => void;
}

function RestartDialog({ request, state, error, onCancel, onConfirm }: RestartDialogProps) {
  const [evidence, setEvidence] = useState(request.statement_evidence_id ?? "");
  const [memo, setMemo] = useState("");
  const busy = state === "saving";
  const disabled = busy || memo.trim().length === 0 || (Boolean(request.equipment_id) && evidence.trim().length === 0);

  return (
    <DialogShell title={ko.financial.purchase.restart.title} onCancel={onCancel} busy={busy}>
      <p className="text-sm font-medium text-amber-800">{ko.financial.purchase.restart.warning}</p>
      <div className="grid gap-3">
        {request.equipment_id ? (
          <Field
            id="restart-evidence"
            label={ko.financial.purchase.fields.statementEvidenceId}
            placeholder={ko.financial.purchase.fields.statementEvidenceIdPlaceholder}
            value={evidence}
            onChange={setEvidence}
          />
        ) : null}
        <div className="grid gap-2">
          <label className="text-sm font-medium text-steel" htmlFor="restart-memo">
            {ko.financial.purchase.fields.memo}
          </label>
          <Textarea
            id="restart-memo"
            rows={2}
            className="min-h-9"
            value={memo}
            onChange={(event) => { setMemo(event.currentTarget.value); }}
          />
        </div>
      </div>
      {error ? <p role="alert" className="text-sm font-semibold text-red-700">{error}</p> : null}
      <DialogActions
        busy={busy}
        confirmLabel={ko.financial.purchase.restart.confirm}
        confirmDisabled={disabled}
        onCancel={onCancel}
        onConfirm={() => { onConfirm(evidence.trim(), memo.trim()); }}
      />
    </DialogShell>
  );
}

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  state: WriteState;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDialog({ title, body, confirmLabel, state, error, onCancel, onConfirm }: ConfirmDialogProps) {
  const busy = state === "saving";
  return (
    <DialogShell title={title} onCancel={onCancel} busy={busy}>
      <p className="text-sm font-medium text-amber-800">{body}</p>
      {error ? <p role="alert" className="text-sm font-semibold text-red-700">{error}</p> : null}
      <DialogActions
        busy={busy}
        confirmLabel={confirmLabel}
        confirmVariant="destructive"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </DialogShell>
  );
}

function DialogShell({
  title,
  busy,
  onCancel,
  children,
}: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onCancel();
      }}
      label={title}
      closeOnScrimClick={!busy}
    >
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {children}
    </Dialog>
  );
}

function DialogActions({
  busy,
  confirmLabel,
  confirmDisabled,
  confirmVariant = "default",
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmVariant?: "default" | "destructive";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
        {ko.financial.purchase.cancel}
      </Button>
      <Button
        type="button"
        size="sm"
        variant={confirmVariant}
        disabled={busy || confirmDisabled}
        onClick={onConfirm}
      >
        {busy ? ko.financial.purchase.actions.working : confirmLabel}
      </Button>
    </div>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "numeric" | "text";
  readOnly?: boolean;
}

function Field({ id, label, value, onChange, placeholder, inputMode, readOnly }: FieldProps) {
  return (
    <div className="grid gap-1.5">
      <label className="text-sm font-medium text-steel" htmlFor={id}>{label}</label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        readOnly={readOnly}
        onChange={(event) => { onChange(event.currentTarget.value); }}
      />
    </div>
  );
}

function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-sm font-medium text-steel" htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        className="min-h-10 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink"
        onChange={(event) => { onChange(event.currentTarget.value as T); }}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </div>
  );
}
