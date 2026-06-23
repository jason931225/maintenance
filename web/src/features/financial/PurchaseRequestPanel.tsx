import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";

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

interface CreateForm {
  vendorName: string;
  amountWon: string;
  statementEvidenceId: string;
  memo: string;
}

function emptyCreateForm(): CreateForm {
  return { vendorName: "", amountWon: "", statementEvidenceId: "", memo: "" };
}

/** Merge a fetched/created summary into the session list (newest first, deduped). */
function upsert(
  list: PurchaseRequestSummary[],
  next: PurchaseRequestSummary,
): PurchaseRequestSummary[] {
  return [next, ...list.filter((item) => item.id !== next.id)];
}

export function PurchaseRequestPanel({ api, roles }: PurchaseRequestPanelProps) {
  const canCreate = hasAnyRole(roles, PURCHASE_CREATE_ROLES);
  const canApprove = hasAnyRole(roles, PURCHASE_APPROVE_ROLES);
  const canFinalApprove = hasAnyRole(roles, PURCHASE_FINAL_APPROVE_ROLES);
  const canExecute = hasAnyRole(roles, PURCHASE_EXECUTE_ROLES);
  const canReject = hasAnyRole(roles, PURCHASE_REJECT_ROLES);

  const [requests, setRequests] = useState<PurchaseRequestSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = requests.find((item) => item.id === selectedId);

  const [creating, setCreating] = useState(false);
  const [equipment, setEquipment] = useState<SelectedEquipment>();
  const [form, setForm] = useState<CreateForm>(emptyCreateForm);
  const [writeState, setWriteState] = useState<WriteState>("idle");
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

  function resetCreate() {
    setCreating(false);
    setEquipment(undefined);
    setForm(emptyCreateForm());
    setWriteState("idle");
  }

  function setField<K extends keyof CreateForm>(key: K, value: CreateForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleCreate() {
    if (!equipment) return;
    setWriteState("saving");
    try {
      const body: CreatePurchaseRequest = {
        branch_id: equipment.branchId,
        equipment_id: equipment.id,
        statement_evidence_id: form.statementEvidenceId.trim(),
        vendor_name: form.vendorName.trim(),
        amount_won: Number(form.amountWon),
        memo: form.memo.trim(),
        config: DEFAULT_FINANCIAL_CONFIG,
      };
      const response = await api.POST("/api/v1/financial/purchase-requests", {
        body,
      });
      if (!response.data) {
        throw new Error("create purchase request response missing data");
      }
      setRequests((prev) => upsert(prev, response.data));
      setSelectedId(response.data.id);
      setNotice(ko.financial.purchase.createSuccess);
      resetCreate();
    } catch {
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

  function closeDialog() {
    setDialog(undefined);
    setDialogValue("");
    setActionState("idle");
    setActionError(undefined);
  }

  const createDisabled =
    writeState === "saving" ||
    !equipment ||
    !form.vendorName.trim() ||
    !form.statementEvidenceId.trim() ||
    form.amountWon.trim().length === 0 ||
    Number.isNaN(Number(form.amountWon)) ||
    Number(form.amountWon) < 0;

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
          className="grid gap-3 rounded-md border border-line p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <h3 className="text-base font-semibold text-ink">
            {ko.financial.purchase.createTitle}
          </h3>
          <EquipmentSelector
            api={api}
            selected={equipment}
            onSelect={setEquipment}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="pr-vendor"
              label={ko.financial.purchase.fields.vendorName}
              placeholder={ko.financial.purchase.fields.vendorNamePlaceholder}
              value={form.vendorName}
              onChange={(v) => {
                setField("vendorName", v);
              }}
            />
            <Field
              id="pr-amount"
              label={ko.financial.purchase.fields.amountWon}
              value={form.amountWon}
              inputMode="numeric"
              onChange={(v) => {
                setField("amountWon", v);
              }}
            />
            <Field
              id="pr-evidence"
              label={ko.financial.purchase.fields.statementEvidenceId}
              placeholder={
                ko.financial.purchase.fields.statementEvidenceIdPlaceholder
              }
              value={form.statementEvidenceId}
              onChange={(v) => {
                setField("statementEvidenceId", v);
              }}
            />
          </div>
          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="pr-memo"
            >
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
          </div>
          {writeState === "error" ? (
            <p role="alert" className="text-sm font-semibold text-red-700">
              {ko.financial.purchase.createFailed}
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
    </div>
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
