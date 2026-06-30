import { Plus, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

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
import { ko } from "../../i18n/ko";
import { SUCCESS_DISMISS_MS, useAutoDismiss } from "../../lib/useAutoDismiss";
import { useAuth } from "../../context/auth";
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

type PurchaseType = "EQUIPMENT" | "NON_EQUIPMENT";
type PurchaseExceptionType =
  | "PRICE_ANOMALY"
  | "MISSING_QUOTE"
  | "POLICY_OVERRIDE"
  | "BUDGET_OVERRIDE";
type PurchaseLineInput = NonNullable<CreatePurchaseRequest["lines"]>[number];
type PurchaseExceptionInput = NonNullable<CreatePurchaseRequest["exceptions"]>[number];

interface PurchaseAttachmentDownload {
  url: string;
}


interface LineForm {
  description: string;
  quantity: string;
  unit: string;
  unitPriceWon: string;
  category: string;
  department: string;
  costCenter: string;
  project: string;
  sku: string;
  taxRateBps: string;
  quoteEvidenceId: string;
  neededBy: string;
}

interface CreateForm {
  purchaseType: PurchaseType;
  vendorName: string;
  workOrderId: string;
  statementEvidenceId: string;
  memo: string;
  shippingWon: string;
  discountWon: string;
  exceptionType: PurchaseExceptionType;
  exceptionReason: string;
  lines: LineForm[];
}

function emptyLine(): LineForm {
  return {
    description: "",
    quantity: "1",
    unit: "EA",
    unitPriceWon: "",
    category: "",
    department: "",
    costCenter: "",
    project: "",
    sku: "",
    taxRateBps: "1000",
    quoteEvidenceId: "",
    neededBy: "",
  };
}

function emptyCreateForm(): CreateForm {
  return {
    purchaseType: "EQUIPMENT",
    vendorName: "",
    workOrderId: "",
    statementEvidenceId: "",
    memo: "",
    shippingWon: "0",
    discountWon: "0",
    exceptionType: "PRICE_ANOMALY",
    exceptionReason: "",
    lines: [emptyLine()],
  };
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
 * a 4xx renders the server's actual message (e.g. an evidence-scope rejection)
 * rather than a generic "won't create". Falls back to the generic copy when the
 * body has no usable message.
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

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function lineSubtotal(line: LineForm): number {
  return numberValue(line.quantity) * numberValue(line.unitPriceWon);
}

function lineVat(line: LineForm): number {
  return Math.floor((lineSubtotal(line) * numberValue(line.taxRateBps)) / 10_000);
}

function formTotals(form: CreateForm) {
  const subtotal = form.lines.reduce((sum, line) => sum + lineSubtotal(line), 0);
  const vat = form.lines.reduce((sum, line) => sum + lineVat(line), 0);
  const shipping = numberValue(form.shippingWon);
  const discount = numberValue(form.discountWon);
  return {
    subtotal,
    vat,
    shipping,
    discount,
    total: Math.max(0, subtotal + vat + shipping - discount),
  };
}

function toLineInput(line: LineForm): PurchaseLineInput {
  return {
    description: line.description.trim(),
    quantity: numberValue(line.quantity),
    unit: line.unit.trim(),
    unit_price_won: numberValue(line.unitPriceWon),
    category: line.category.trim(),
    department: line.department.trim() || null,
    cost_center: line.costCenter.trim() || null,
    project: line.project.trim() || null,
    sku: line.sku.trim() || null,
    tax_rate_bps: numberValue(line.taxRateBps),
    quote_evidence_id: line.quoteEvidenceId.trim() || null,
    needed_by: line.neededBy || null,
  };
}

export function PurchaseRequestPanel({ api, roles }: PurchaseRequestPanelProps) {
  const { session } = useAuth();
  const canCreate = hasAnyRole(roles, PURCHASE_CREATE_ROLES);
  const canApprove = hasAnyRole(roles, PURCHASE_APPROVE_ROLES);
  const canFinalApprove = hasAnyRole(roles, PURCHASE_FINAL_APPROVE_ROLES);
  const canExecute = hasAnyRole(roles, PURCHASE_EXECUTE_ROLES);
  const canReject = hasAnyRole(roles, PURCHASE_REJECT_ROLES);
  const defaultBranchId = session?.branches?.[0];
  const optionA = ko.financial.purchase.optionA;

  const [requests, setRequests] = useState<PurchaseRequestSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = requests.find((item) => item.id === selectedId);

  const [creating, setCreating] = useState(false);
  const [equipment, setEquipment] = useState<SelectedEquipment>();
  const [form, setForm] = useState<CreateForm>(emptyCreateForm);
  const totals = useMemo(() => formTotals(form), [form]);
  const quoteInputRef = useRef<HTMLInputElement | null>(null);
  const createFormRef = useRef<HTMLFormElement | null>(null);
  const [quoteUploadState, setQuoteUploadState] = useState<WriteState>("idle");
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [createError, setCreateError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const clearNotice = useCallback(() => {
    setNotice(undefined);
  }, []);
  useAutoDismiss(notice, clearNotice, SUCCESS_DISMISS_MS);
  useEffect(() => {
    if (!creating || !canCreate) return;
    const frame = window.requestAnimationFrame(() => {
      const formElement = createFormRef.current;
      if (typeof formElement?.scrollIntoView === "function") {
        formElement.scrollIntoView({ block: "start", behavior: "auto" });
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [canCreate, creating]);

  const [lookupId, setLookupId] = useState("");
  const [lookupError, setLookupError] = useState(false);

  const [dialog, setDialog] = useState<Dialog>();
  const [dialogValue, setDialogValue] = useState("");
  const [actionState, setActionState] = useState<WriteState>("idle");
  const [actionError, setActionError] = useState<string>();

  function resetCreate() {
    setCreating(false);
    setEquipment(undefined);
    setForm(emptyCreateForm());
    setQuoteUploadState("idle");
    setWriteState("idle");
    setCreateError(undefined);
  }

  function setField<K extends keyof CreateForm>(key: K, value: CreateForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateLine(index: number, patch: Partial<LineForm>) {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((line, i) =>
        i === index ? { ...line, ...patch } : line,
      ),
    }));
  }

  function addLine() {
    setForm((prev) => ({ ...prev, lines: [...prev.lines, emptyLine()] }));
  }

  function removeLine(index: number) {
    setForm((prev) => ({
      ...prev,
      lines:
        prev.lines.length === 1
          ? prev.lines
          : prev.lines.filter((_, i) => i !== index),
    }));
  }

  async function uploadQuote(file: File) {
    const workOrderId = form.workOrderId.trim();
    if (!workOrderId) {
      setCreateError(optionA.uploadNeedsWorkOrder);
      setQuoteUploadState("error");
      return;
    }
    setQuoteUploadState("saving");
    setCreateError(undefined);
    try {
      const presign = await api.POST("/api/v1/evidence/presign", {
        body: {
          work_order_id: workOrderId,
          stage: "REQUEST",
          content_type: file.type || "application/octet-stream",
          size_bytes: file.size,
          checksum_sha256: undefined,
        },
      });
      if (!presign.data) throw new Error("missing presign");
      const headers = new Headers();
      for (const [name, value] of presign.data.upload.headers) {
        headers.set(name, value);
      }
      const putResponse = await fetch(presign.data.upload.url, {
        method: presign.data.upload.method,
        headers,
        body: file,
      });
      if (!putResponse.ok) throw new Error("quote upload failed");
      await api.POST("/api/v1/evidence/{evidenceId}/confirm", {
        params: { path: { evidenceId: presign.data.id } },
      });
      setField("statementEvidenceId", presign.data.id);
      setQuoteUploadState("idle");
    } catch {
      setCreateError(optionA.uploadFailed);
      setQuoteUploadState("error");
    } finally {
      if (quoteInputRef.current) quoteInputRef.current.value = "";
    }
  }

  async function handleCreate() {
    const branchId =
      form.purchaseType === "EQUIPMENT" ? equipment?.branchId : defaultBranchId;
    if (!branchId) return;
    setWriteState("saving");
    setCreateError(undefined);
    try {
      const exceptions: PurchaseExceptionInput[] =
        form.exceptionReason.trim().length > 0
          ? [
              {
                exception_type: form.exceptionType,
                reason: form.exceptionReason.trim(),
                attachment_evidence_id: form.statementEvidenceId.trim() || null,
                escalation_approver: null,
              },
            ]
          : [];
      const body: CreatePurchaseRequest = {
        branch_id: branchId,
        purchase_type: form.purchaseType,
        equipment_id:
          form.purchaseType === "EQUIPMENT" ? (equipment?.id ?? null) : null,
        work_order_id: form.workOrderId.trim() || null,
        statement_evidence_id: form.statementEvidenceId.trim() || null,
        vendor_name: form.vendorName.trim(),
        memo: form.memo.trim(),
        lines: form.lines.map(toLineInput),
        exceptions,
        shipping_won: numberValue(form.shippingWon),
        discount_won: numberValue(form.discountWon),
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
      if (!response.data) {
        throw new Error("purchase request not found");
      }
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
      if (!response.data) {
        throw new Error("action response missing data");
      }
      applyResult(response.data);
      setActionState("idle");
      setDialog(undefined);
      setDialogValue("");
    } catch {
      setActionState("error");
      setActionError(failureMessage);
    }
  }

  async function downloadAttachment(purchaseRequestId: string, attachmentId: string) {
    setActionError(undefined);
    try {
      const response = (await api.GET(
        "/api/v1/financial/purchase-requests/{purchaseRequestId}/attachments/{attachmentId}/download",
        {
          params: {
            path: {
              purchaseRequestId,
              attachmentId,
            },
          },
        },
      )) as { data?: PurchaseAttachmentDownload; error?: unknown };
      if (response.error || !response.data) {
        setActionError(
          errorMessage(response.error, optionA.attachmentDownloadFailed),
        );
        return;
      }
      window.open(response.data.url, "_blank", "noopener,noreferrer");
    } catch {
      setActionError(optionA.attachmentDownloadFailed);
    }
  }

  function closeDialog() {
    setDialog(undefined);
    setDialogValue("");
    setActionState("idle");
    setActionError(undefined);
  }

  const hasPriceAnomaly =
    totals.total >= 10_000_000 ||
    form.lines.some((line) => numberValue(line.unitPriceWon) >= 5_000_000);
  const hasEveryLineCore = form.lines.every(
    (line) =>
      line.description.trim() &&
      line.category.trim() &&
      numberValue(line.quantity) > 0 &&
      numberValue(line.unitPriceWon) >= 0,
  );
  const createDisabled =
    writeState === "saving" ||
    quoteUploadState === "saving" ||
    !form.vendorName.trim() ||
    !form.memo.trim() ||
    !hasEveryLineCore ||
    totals.total <= 0 ||
    (form.purchaseType === "EQUIPMENT" && (!equipment || !form.statementEvidenceId.trim())) ||
    (hasPriceAnomaly && !form.exceptionReason.trim());

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
          ref={createFormRef}
          className="grid gap-3 rounded-md border border-line bg-white p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <div className="sticky top-0 z-10 -mx-3 -mt-3 flex flex-wrap items-center justify-between gap-2 border-b border-line bg-white/95 px-3 py-2 backdrop-blur">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-steel">
                Draft · {form.purchaseType === "EQUIPMENT" ? optionA.draftEquipment : optionA.draftNonEquipment}
              </p>
              <h3 className="text-base font-semibold text-ink">
                {ko.financial.purchase.createTitle}
              </h3>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>{formatWon(totals.total)} {ko.financial.wonUnit}</Badge>
              <Badge>{hasPriceAnomaly ? optionA.policyExceptionRequired : optionA.policyClear}</Badge>
              <Button type="submit" disabled={createDisabled}>
                {writeState === "saving"
                  ? ko.financial.purchase.saving
                  : ko.financial.purchase.save}
              </Button>
            </div>
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
            <div className="grid gap-3">
              <section className="grid gap-3 rounded-md border border-line p-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="grid gap-2">
                    <label className="text-sm font-medium text-steel" htmlFor="pr-type">
                      {optionA.purchaseType}
                    </label>
                    <select
                      id="pr-type"
                      className="h-9 rounded-md border border-line bg-white px-3 text-sm"
                      value={form.purchaseType}
                      onChange={(event) => {
                        setField("purchaseType", event.currentTarget.value as PurchaseType);
                      }}
                    >
                      <option value="EQUIPMENT">{optionA.equipmentPurchase}</option>
                      <option value="NON_EQUIPMENT">{optionA.nonEquipmentPurchase}</option>
                    </select>
                  </div>
                  <Field
                    id="pr-vendor"
                    label={ko.financial.purchase.fields.vendorName}
                    placeholder={ko.financial.purchase.fields.vendorNamePlaceholder}
                    value={form.vendorName}
                    onChange={(v) => {
                      setField("vendorName", v);
                    }}
                  />
                </div>
                {form.purchaseType === "EQUIPMENT" ? (
                  <EquipmentSelector
                    api={api}
                    selected={equipment}
                    onSelect={setEquipment}
                  />
                ) : (
                  <p className="rounded-md border border-line bg-muted-panel p-2 text-sm text-steel">
                    {optionA.nonEquipmentHint}
                  </p>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  <Field
                    id="pr-work-order"
                    label={optionA.workOrder}
                    placeholder={optionA.workOrderPlaceholder}
                    value={form.workOrderId}
                    onChange={(v) => {
                      setField("workOrderId", v);
                    }}
                  />
                  <Field
                    id="pr-evidence"
                    label={ko.financial.purchase.fields.statementEvidenceId}
                    placeholder={ko.financial.purchase.fields.statementEvidenceIdPlaceholder}
                    value={form.statementEvidenceId}
                    onChange={(v) => {
                      setField("statementEvidenceId", v);
                    }}
                  />
                </div>
              </section>

              <section className="grid gap-2 rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-ink">{optionA.lineGrid}</h4>
                  <Button type="button" variant="secondary" onClick={addLine}>
                    {optionA.addRow}
                  </Button>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-[960px] border-separate border-spacing-0 text-sm">
                    <thead className="bg-muted-panel text-left text-xs text-steel">
                      <tr>
                        <th className="p-2">{optionA.columns.item}</th>
                        <th className="p-2">{optionA.columns.quantity}</th>
                        <th className="p-2">{optionA.columns.unit}</th>
                        <th className="p-2">{optionA.columns.unitPrice}</th>
                        <th className="p-2">{optionA.columns.amount}</th>
                        <th className="p-2">{optionA.columns.category}</th>
                        <th className="p-2">{optionA.columns.department}</th>
                        <th className="p-2">{optionA.columns.taxBps}</th>
                        <th className="p-2">{optionA.columns.quoteEvidence}</th>
                        <th className="p-2">{optionA.columns.neededBy}</th>
                        <th className="p-2">{optionA.columns.action}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {form.lines.map((line, index) => {
                        const rowNumber = String(index + 1);
                        return (
                          <tr key={index} className="align-top">
                            <td className="p-1">
                              <GridInput
                                ariaLabel={`${optionA.aria.item} ${rowNumber}`}
                                value={line.description}
                                onChange={(value) => {
                                  updateLine(index, { description: value });
                                }}
                              />
                            </td>
                            <td className="p-1">
                              <GridInput
                                ariaLabel={`${optionA.aria.quantity} ${rowNumber}`}
                                value={line.quantity}
                                inputMode="numeric"
                                onChange={(value) => {
                                  updateLine(index, { quantity: value });
                                }}
                              />
                            </td>
                            <td className="p-1">
                              <GridInput
                                ariaLabel={`${optionA.aria.unit} ${rowNumber}`}
                                value={line.unit}
                                onChange={(value) => {
                                  updateLine(index, { unit: value });
                                }}
                              />
                            </td>
                            <td className="p-1">
                              <GridInput
                                ariaLabel={`${optionA.aria.unitPrice} ${rowNumber}`}
                                value={line.unitPriceWon}
                                inputMode="numeric"
                                onChange={(value) => {
                                  updateLine(index, { unitPriceWon: value });
                                }}
                              />
                            </td>
                            <td className="whitespace-nowrap p-2 font-medium">
                              {formatWon(lineSubtotal(line) + lineVat(line))}
                            </td>
                            <td className="p-1">
                              <GridInput
                                ariaLabel={`${optionA.aria.category} ${rowNumber}`}
                                value={line.category}
                                onChange={(value) => {
                                  updateLine(index, { category: value });
                                }}
                              />
                            </td>
                            <td className="p-1">
                              <GridInput
                                ariaLabel={`${optionA.aria.department} ${rowNumber}`}
                                value={line.department}
                                onChange={(value) => {
                                  updateLine(index, { department: value });
                                }}
                              />
                            </td>
                            <td className="p-1">
                              <GridInput
                                ariaLabel={`${optionA.aria.taxBps} ${rowNumber}`}
                                value={line.taxRateBps}
                                inputMode="numeric"
                                onChange={(value) => {
                                  updateLine(index, { taxRateBps: value });
                                }}
                              />
                            </td>
                            <td className="p-1">
                              <GridInput
                                ariaLabel={`${optionA.aria.quoteEvidence} ${rowNumber}`}
                                value={line.quoteEvidenceId}
                                onChange={(value) => {
                                  updateLine(index, { quoteEvidenceId: value });
                                }}
                              />
                            </td>
                            <td className="p-1">
                              <GridInput
                                ariaLabel={`${optionA.aria.neededBy} ${rowNumber}`}
                                value={line.neededBy}
                                type="date"
                                onChange={(value) => {
                                  updateLine(index, { neededBy: value });
                                }}
                              />
                            </td>
                            <td className="p-1">
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={form.lines.length === 1}
                                onClick={() => {
                                  removeLine(index);
                                }}
                              >
                                {optionA.deleteRow}
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="grid gap-2 rounded-md border border-line p-3">
                <label className="text-sm font-medium text-steel" htmlFor="pr-memo">
                  {ko.financial.purchase.fields.memo}
                </label>
                <Textarea
                  id="pr-memo"
                  rows={2}
                  className="min-h-9"
                  value={form.memo}
                  placeholder={ko.financial.purchase.fields.memoPlaceholder}
                  onChange={(event) => {
                    setField("memo", event.currentTarget.value);
                  }}
                />
              </section>
            </div>

            <aside className="grid content-start gap-3 xl:sticky xl:top-16">
              <section className="grid gap-2 rounded-md border border-line p-3">
                <h4 className="text-sm font-semibold text-ink">{optionA.approvalPreview}</h4>
                <ol className="grid gap-2 text-sm">
                  <li>{optionA.approvalPreviewSteps.requesterAdmin}</li>
                  {totals.total > DEFAULT_FINANCIAL_CONFIG.executive_approval_threshold_won ? (
                    <li>{optionA.approvalPreviewSteps.executiveRequired}</li>
                  ) : (
                    <li>{optionA.approvalPreviewSteps.executiveSkipped}</li>
                  )}
                  <li>
                    {form.purchaseType === "EQUIPMENT"
                      ? optionA.approvalPreviewSteps.equipmentExecution
                      : optionA.approvalPreviewSteps.nonEquipmentExecution}
                  </li>
                </ol>
              </section>

              <section className="grid gap-2 rounded-md border border-line p-3">
                <h4 className="text-sm font-semibold text-ink">{optionA.policyChecklist}</h4>
                <PolicyItem ok={form.purchaseType !== "EQUIPMENT" || Boolean(equipment)} text={optionA.policies.equipmentRequired} />
                <PolicyItem ok={Boolean(form.statementEvidenceId.trim())} text={optionA.policies.quoteRequired} />
                <PolicyItem ok={hasEveryLineCore} text={optionA.policies.lineCore} />
                <PolicyItem ok={!hasPriceAnomaly || Boolean(form.exceptionReason.trim())} text={optionA.policies.priceException} />
              </section>

              {hasPriceAnomaly ? (
                <section className="grid gap-2 rounded-md border border-amber-300 bg-amber-50 p-3">
                  <h4 className="text-sm font-semibold text-ink">{optionA.structuredException}</h4>
                  <select
                    className="h-9 rounded-md border border-line bg-white px-3 text-sm"
                    value={form.exceptionType}
                    onChange={(event) => {
                      setField("exceptionType", event.currentTarget.value as PurchaseExceptionType);
                    }}
                  >
                    <option value="PRICE_ANOMALY">{optionA.exceptionOptions.PRICE_ANOMALY}</option>
                    <option value="MISSING_QUOTE">{optionA.exceptionOptions.MISSING_QUOTE}</option>
                    <option value="POLICY_OVERRIDE">{optionA.exceptionOptions.POLICY_OVERRIDE}</option>
                    <option value="BUDGET_OVERRIDE">{optionA.exceptionOptions.BUDGET_OVERRIDE}</option>
                  </select>
                  <Textarea
                    rows={2}
                    value={form.exceptionReason}
                    placeholder={optionA.exceptionPlaceholder}
                    onChange={(event) => {
                      setField("exceptionReason", event.currentTarget.value);
                    }}
                  />
                </section>
              ) : null}

              <section className="grid gap-2 rounded-md border border-line p-3">
                <h4 className="text-sm font-semibold text-ink">{optionA.quoteDropzone}</h4>
                <p className="text-xs text-steel">
                  {optionA.quoteHelp}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={quoteUploadState === "saving"}
                  onClick={() => {
                    quoteInputRef.current?.click();
                  }}
                >
                  <Upload aria-hidden="true" size={16} />
                  {quoteUploadState === "saving" ? optionA.uploading : optionA.quoteUpload}
                </Button>
                <input
                  ref={quoteInputRef}
                  className="sr-only"
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void uploadQuote(file);
                  }}
                />
                {form.statementEvidenceId ? (
                  <p className="break-all text-xs text-steel">
                    {optionA.linkedEvidence}: {form.statementEvidenceId}
                  </p>
                ) : null}
              </section>

              <section className="grid gap-2 rounded-md border border-line p-3">
                <h4 className="text-sm font-semibold text-ink">{optionA.totalsVat}</h4>
                <dl className="grid gap-1 text-sm">
                  <Row label={optionA.totals.subtotal} value={`${formatWon(totals.subtotal)} ${ko.financial.wonUnit}`} />
                  <Row label={optionA.totals.vat} value={`${formatWon(totals.vat)} ${ko.financial.wonUnit}`} />
                  <Row label={optionA.totals.total} value={`${formatWon(totals.total)} ${ko.financial.wonUnit}`} />
                </dl>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field
                    id="pr-shipping"
                    label={optionA.totals.shipping}
                    value={form.shippingWon}
                    inputMode="numeric"
                    onChange={(value) => {
                      setField("shippingWon", value);
                    }}
                  />
                  <Field
                    id="pr-discount"
                    label={optionA.totals.discount}
                    value={form.discountWon}
                    inputMode="numeric"
                    onChange={(value) => {
                      setField("discountWon", value);
                    }}
                  />
                </div>
              </section>


              {writeState === "error" ? (
                <p role="alert" className="text-sm font-semibold text-red-700">
                  {createError ?? ko.financial.purchase.createFailed}
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={writeState === "saving"}
                  onClick={resetCreate}
                >
                  {ko.financial.purchase.cancel}
                </Button>
                <Button type="submit" disabled={createDisabled}>
                  {writeState === "saving"
                    ? ko.financial.purchase.saving
                    : ko.financial.purchase.save}
                </Button>
              </div>
            </aside>
          </div>
        </form>
      ) : null}

      <div className="grid gap-2 rounded-md border border-line p-3">
        <label
          className="text-sm font-medium text-steel"
          htmlFor="pr-lookup"
        >
          {ko.financial.purchase.lookupLabel}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="pr-lookup"
            value={lookupId}
            placeholder={ko.financial.purchase.lookupPlaceholder}
            onChange={(event) => {
              setLookupId(event.currentTarget.value);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={lookupId.trim().length === 0}
            onClick={() => {
              void handleLookup();
            }}
          >
            {ko.financial.purchase.lookup}
          </Button>
        </div>
        {lookupError ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {ko.financial.purchase.lookupFailed}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
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
              className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-left ${
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
                <span className="font-semibold text-ink">
                  {request.vendor_name}
                </span>
                <span className="text-sm text-steel">
                  {formatWon(request.amount_won)} {ko.financial.wonUnit}
                </span>
              </div>
              <Badge>{ko.financial.statuses[request.status]}</Badge>
            </button>
          ))
        )}
      </div>

      {selected ? (
        <PurchaseDetail
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
          onDownloadAttachment={(attachmentId) => {
            void downloadAttachment(selected.id, attachmentId);
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
          state={actionState}
          error={actionError}
          onCancel={closeDialog}
          onConfirm={(statementEvidenceId, amountWon, memo) => {
            void runAction(
              () =>
                api.POST(
                  "/api/v1/financial/purchase-requests/{purchaseRequestId}/restart",
                  {
                    params: { path: { purchaseRequestId: selected.id } },
                    body: {
                      statement_evidence_id: statementEvidenceId,
                      amount_won: amountWon,
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
          body={ko.financial.purchase.executeConfirm.body}
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

interface PurchaseDetailProps {
  request: PurchaseRequestSummary;
  canCreate: boolean;
  canApprove: boolean;
  canFinalApprove: boolean;
  canExecute: boolean;
  canReject: boolean;
  actionState: WriteState;
  actionError?: string;
  onOpenDialog: (dialog: Dialog) => void;
  onDownloadAttachment: (attachmentId: string) => void;
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
      return {
        prepareExpenditure: perms.canCreate,
        reject: perms.canReject,
      };
    case "EXECUTIVE_PENDING":
      return {
        approveExecutive: perms.canFinalApprove,
        reject: perms.canReject,
      };
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
  request,
  canCreate,
  canApprove,
  canFinalApprove,
  canExecute,
  canReject,
  actionState,
  actionError,
  onOpenDialog,
  onDownloadAttachment,
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

  return (
    <div className="grid gap-3 rounded-md border border-line bg-muted-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-ink">
          {ko.financial.purchase.detailTitle}
        </h3>
        <Badge>{ko.financial.statuses[request.status]}</Badge>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <Row label={ko.financial.purchase.vendor} value={request.vendor_name} />
        <Row
          label={ko.financial.purchase.amount}
          value={`${formatWon(request.amount_won)} ${ko.financial.wonUnit}`}
        />
        {request.expenditure_no ? (
          <Row
            label={ko.financial.purchase.expenditureNo}
            value={request.expenditure_no}
          />
        ) : null}
        {request.rejection_memo ? (
          <Row
            label={ko.financial.purchase.rejectionMemo}
            value={request.rejection_memo}
          />
        ) : null}
      </dl>

      <SourceObjectRail request={request} />
      <PurchaseLineItems request={request} />
      <PurchaseAttachmentRail
        request={request}
        onDownloadAttachment={onDownloadAttachment}
      />
      <PurchasePolicyGates request={request} />
      <PurchaseApprovalLine request={request} />
      <FinanceControlBadges />

      <div className="flex flex-wrap items-center gap-2">
        {actions.submit ? (
          <Button type="button" disabled={busy} onClick={onSubmit}>
            {busy
              ? ko.financial.purchase.actions.working
              : ko.financial.purchase.actions.submit}
          </Button>
        ) : null}
        {actions.approveAdmin ? (
          <Button type="button" disabled={busy} onClick={onApproveAdmin}>
            {busy
              ? ko.financial.purchase.actions.working
              : ko.financial.purchase.actions.approveAdmin}
          </Button>
        ) : null}
        {actions.prepareExpenditure ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              onOpenDialog("expenditure");
            }}
          >
            {ko.financial.purchase.actions.prepareExpenditure}
          </Button>
        ) : null}
        {actions.approveExecutive ? (
          <Button type="button" disabled={busy} onClick={onApproveExecutive}>
            {busy
              ? ko.financial.purchase.actions.working
              : ko.financial.purchase.actions.approveExecutive}
          </Button>
        ) : null}
        {actions.execute ? (
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              onOpenDialog("execute");
            }}
          >
            {ko.financial.purchase.actions.execute}
          </Button>
        ) : null}
        {actions.reject ? (
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              onOpenDialog("reject");
            }}
          >
            {ko.financial.purchase.actions.reject}
          </Button>
        ) : null}
        {actions.restart ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              onOpenDialog("restart");
            }}
          >
            {ko.financial.purchase.actions.restart}
          </Button>
        ) : null}
        {!hasAction ? (
          <p className="text-sm text-steel">
            {ko.financial.purchase.actions.none}
          </p>
        ) : null}
      </div>
      {actionState === "error" && actionError ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}

function SourceObjectRail({ request }: { request: PurchaseRequestSummary }) {
  const t = ko.financial.purchase.sourceRail;
  const statementEvidenceId = request.statement_evidence_id;
  const optionA = ko.financial.purchase.optionA;
  return (
    <div className="grid gap-2 rounded-md border border-line bg-white p-3">
      <h4 className="text-sm font-semibold text-ink">{t.title}</h4>
      <dl className="grid gap-2 text-sm md:grid-cols-3">
        <div>
          <dt className="font-semibold text-steel">{t.equipment}</dt>
          <dd>
            {request.equipment_id ? (
              <Link
                className="font-medium text-ink underline-offset-4 hover:underline"
                to={`/equipment/${request.equipment_id}`}
              >
                {request.equipment_id}
              </Link>
            ) : (
              <span className="text-steel">{optionA.nonEquipmentSource}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{t.workOrder}</dt>
          <dd>
            {request.work_order_id ? (
              <Link
                className="font-medium text-ink underline-offset-4 hover:underline"
                to={`/work-orders/${request.work_order_id}`}
              >
                {request.work_order_id}
              </Link>
            ) : (
              <span className="text-steel">{t.noWorkOrder}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{t.evidence}</dt>
          <dd className="break-all font-mono text-xs text-ink">
            {statementEvidenceId ? statementEvidenceId : optionA.noAttachment}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function PurchaseLineItems({ request }: { request: PurchaseRequestSummary }) {
  const { lines } = request;
  const optionA = ko.financial.purchase.optionA;
  if (lines.length === 0) return null;

  return (
    <div className="grid gap-2 rounded-md border border-line bg-white p-3">
      <h4 className="text-sm font-semibold text-ink">{optionA.lineItems}</h4>
      <div className="overflow-x-auto">
        <table className="min-w-[720px] text-sm">
          <thead className="bg-muted-panel text-left text-xs text-steel">
            <tr>
              <th className="p-2">{optionA.columns.item}</th>
              <th className="p-2">{optionA.columns.quantity}</th>
              <th className="p-2">{optionA.columns.unitPrice}</th>
              <th className="p-2">{optionA.columns.vat}</th>
              <th className="p-2">{optionA.columns.total}</th>
              <th className="p-2">{optionA.columns.category}</th>
              <th className="p-2">{optionA.columns.evidence}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-t border-line">
                <td className="p-2">{line.description}</td>
                <td className="p-2">
                  {line.quantity} {line.unit}
                </td>
                <td className="p-2">{formatWon(line.unit_price_won)}</td>
                <td className="p-2">{formatWon(line.vat_won)}</td>
                <td className="p-2 font-medium">{formatWon(line.total_won)}</td>
                <td className="p-2">{line.category}</td>
                <td className="break-all p-2 font-mono text-xs">
                  {line.quote_evidence_id ? line.quote_evidence_id : optionA.requestLevelEvidence}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PurchaseAttachmentRail({
  request,
  onDownloadAttachment,
}: {
  request: PurchaseRequestSummary;
  onDownloadAttachment: (attachmentId: string) => void;
}) {
  const { attachments } = request;
  const optionA = ko.financial.purchase.optionA;
  if (attachments.length === 0) return null;

  return (
    <div className="grid gap-2 rounded-md border border-line bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">{optionA.attachments}</h4>
        <Badge>{attachments.length}{optionA.attachmentCountSuffix}</Badge>
      </div>
      <ul className="grid gap-2 text-sm">
        {attachments.map((attachment) => (
          <li
            key={attachment.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-2"
          >
            <div className="min-w-0">
              <span className="font-semibold text-ink">
                {attachment.attachment_type}
              </span>
              <span className="ml-2 text-xs text-steel">
                {attachment.preferred_quote ? optionA.preferredQuote : optionA.referenceAttachment}
              </span>
              <p className="break-all font-mono text-xs text-steel">
                {attachment.evidence_id}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                onDownloadAttachment(attachment.id);
              }}
            >
              {optionA.openAttachment}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PurchasePolicyGates({ request }: { request: PurchaseRequestSummary }) {
  const { exceptions, policy_gates: policyGates } = request;
  const optionA = ko.financial.purchase.optionA;
  return (
    <div className="grid gap-2 rounded-md border border-line bg-white p-3">
      <h4 className="text-sm font-semibold text-ink">{optionA.policyGates}</h4>
      <ul className="grid gap-2 text-sm md:grid-cols-2">
        {policyGates.map((gate) => (
          <li
            key={gate.code}
            className={`rounded-md border p-2 ${
              gate.blocking ? "border-amber-300 bg-amber-50" : "border-line"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{gate.label}</span>
              <Badge>{gate.status}</Badge>
            </div>
            <p className="mt-1 text-xs text-steel">{gate.message}</p>
          </li>
        ))}
      </ul>
      {exceptions.length > 0 ? (
        <ul className="grid gap-2 text-sm">
          {exceptions.map((exception) => (
            <li key={exception.id} className="rounded-md border border-line p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">
                  {exception.exception_type}
                </span>
                <Badge>{exception.status}</Badge>
              </div>
              <p className="mt-1 text-steel">{exception.reason}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PurchaseApprovalLine({ request }: { request: PurchaseRequestSummary }) {
  const t = ko.financial.purchase.approvalLine;
  const requiresExecutive =
    request.status === "EXECUTIVE_PENDING" ||
    request.amount_won >=
      DEFAULT_FINANCIAL_CONFIG.executive_approval_threshold_won;
  const steps: {
    key: string;
    label: string;
    status: PurchaseStatus;
    optional?: boolean;
  }[] = [
    {
      key: "statement",
      label: t.steps.statement,
      status: "STATEMENT_ATTACHED",
    },
    { key: "submit", label: t.steps.submit, status: "REQUEST_SUBMITTED" },
    { key: "admin", label: t.steps.admin, status: "ADMIN_APPROVED" },
    ...(requiresExecutive
      ? [
          {
            key: "executive",
            label: t.steps.executive,
            status: "EXECUTIVE_PENDING" as PurchaseStatus,
          },
        ]
      : [
          {
            key: "executive",
            label: t.steps.executive,
            status: "EXECUTIVE_PENDING" as PurchaseStatus,
            optional: true,
          },
        ]),
    {
      key: "expenditure",
      label: t.steps.expenditure,
      status: "READY_TO_EXECUTE",
    },
    { key: "execute", label: t.steps.execute, status: "EXECUTED" },
  ];

  return (
    <div className="grid gap-2 rounded-md border border-line bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">{t.title}</h4>
        <Badge>
          {request.status === "REJECTED"
            ? ko.financial.statuses.REJECTED
            : t.policy}
        </Badge>
      </div>
      <ol className="grid gap-2 md:grid-cols-6">
        {steps.map((step) => {
          const state = approvalStepState(request.status, step.status, {
            optional: step.optional,
          });
          return (
            <li
              key={step.key}
              className={`rounded-md border p-2 ${
                state === "current"
                  ? "border-ink bg-muted-panel"
                  : state === "done"
                    ? "border-brand-teal bg-white"
                    : "border-line bg-white"
              }`}
            >
              <span className="block text-xs font-semibold text-ink">
                {step.label}
              </span>
              <span className="mt-1 block text-xs text-steel">
                {t.state[state]}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function approvalStepState(
  current: PurchaseStatus,
  step: PurchaseStatus,
  options: { optional?: boolean } = {},
): "done" | "current" | "pending" | "skipped" | "rejected" {
  if (current === "REJECTED") return "rejected";
  if (options.optional) return "skipped";
  const rank: PurchaseStatus[] = [
    "STATEMENT_ATTACHED",
    "REQUEST_SUBMITTED",
    "ADMIN_APPROVED",
    "EXECUTIVE_PENDING",
    "READY_TO_EXECUTE",
    "EXECUTED",
  ];
  const currentIndex = rank.indexOf(current);
  const stepIndex = rank.indexOf(step);
  if (currentIndex === stepIndex) return "current";
  if (currentIndex > stepIndex) return "done";
  return "pending";
}

function FinanceControlBadges() {
  const t = ko.financial.purchase.controls;
  return (
    <ul className="grid gap-2 text-sm md:grid-cols-3">
      {t.map((item) => (
        <li
          key={item.label}
          className="rounded-md border border-line bg-white p-3"
        >
          <span className="font-semibold text-ink">{item.label}</span>
          <span className="mt-1 block text-steel">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-semibold text-steel">{label}</dt>
      <dd className="text-ink">{value}</dd>
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
        <label
          className="text-sm font-medium text-steel"
          htmlFor="financial-action-input"
        >
          {label}
        </label>
        <Input
          id="financial-action-input"
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}
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
  state: WriteState;
  error?: string;
  onCancel: () => void;
  onConfirm: (
    statementEvidenceId: string,
    amountWon: number,
    memo: string,
  ) => void;
}

function RestartDialog({
  state,
  error,
  onCancel,
  onConfirm,
}: RestartDialogProps) {
  const [evidence, setEvidence] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const busy = state === "saving";
  const disabled =
    busy ||
    evidence.trim().length === 0 ||
    amount.trim().length === 0 ||
    Number.isNaN(Number(amount)) ||
    Number(amount) < 0;

  return (
    <DialogShell
      title={ko.financial.purchase.restart.title}
      onCancel={onCancel}
      busy={busy}
    >
      <p className="text-sm font-medium text-amber-800">
        {ko.financial.purchase.restart.warning}
      </p>
      <div className="grid gap-3">
        <Field
          id="restart-evidence"
          label={ko.financial.purchase.fields.statementEvidenceId}
          placeholder={
            ko.financial.purchase.fields.statementEvidenceIdPlaceholder
          }
          value={evidence}
          onChange={setEvidence}
        />
        <Field
          id="restart-amount"
          label={ko.financial.purchase.fields.amountWon}
          value={amount}
          inputMode="numeric"
          onChange={setAmount}
        />
        <div className="grid gap-2">
          <label
            className="text-sm font-medium text-steel"
            htmlFor="restart-memo"
          >
            {ko.financial.purchase.fields.memo}
          </label>
          <Textarea
            id="restart-memo"
            rows={2}
            className="min-h-9"
            value={memo}
            onChange={(event) => {
              setMemo(event.currentTarget.value);
            }}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}
      <DialogActions
        busy={busy}
        confirmLabel={ko.financial.purchase.restart.confirm}
        confirmDisabled={disabled}
        onCancel={onCancel}
        onConfirm={() => {
          onConfirm(evidence.trim(), Number(amount), memo.trim());
        }}
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

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  state,
  error,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const busy = state === "saving";
  return (
    <DialogShell title={title} onCancel={onCancel} busy={busy}>
      <p className="text-sm font-medium text-amber-800">{body}</p>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}
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
        // A scrim click / Escape cancels the dialog, but never while a mutation
        // is in flight (busy) so the in-progress request is not abandoned.
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
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        onClick={onCancel}
      >
        {ko.financial.purchase.cancel}
      </Button>
      <Button
        type="button"
        variant={confirmVariant}
        disabled={busy || confirmDisabled}
        onClick={onConfirm}
      >
        {busy ? ko.financial.purchase.actions.working : confirmLabel}
      </Button>
    </div>
  );
}

function PolicyItem({ ok, text }: { ok: boolean; text: string }) {
  const optionA = ko.financial.purchase.optionA;
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-steel">{text}</span>
      <Badge>{ok ? optionA.pass : optionA.block}</Badge>
    </div>
  );
}

function GridInput({
  ariaLabel,
  value,
  onChange,
  inputMode,
  type = "text",
}: {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: "numeric" | "text";
  type?: string;
}) {
  return (
    <Input
      aria-label={ariaLabel}
      className="h-9 min-w-24 px-2"
      type={type}
      value={value}
      inputMode={inputMode}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
    />
  );
}
interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "numeric" | "text";
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  inputMode,
}: FieldProps) {
  return (
    <div className="grid gap-2">
      <label className="text-sm font-medium text-steel" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
    </div>
  );
}
