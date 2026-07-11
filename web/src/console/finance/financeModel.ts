import type { ConsoleApiClient } from "../../api/client";
import { choiceStatus, resolveText } from "../modules/typeRegistry";
import type {
  ModuleActionConfig,
  ModuleBalanceCheckValue,
  ModuleDataAdapter,
  ModuleLinkChipValue,
  ModuleRow,
  ModuleSourceValue,
  ModuleStepperValue,
} from "../modules/types";
import {
  createVoucherDraft,
  getVoucher,
  listVouchers,
  postVoucher as postVoucherApi,
  reverseVoucher as reverseVoucherApi,
  submitVoucher as submitVoucherApi,
  approveVoucher as approveVoucherApi,
  type CreateVoucherRequest,
  type DebitCredit,
  type VoucherLineInput,
  type VoucherSummary,
  type VoucherStatus,
} from "./financeApi";

const F = "console.modules.finance";

// Owned here (not moduleScreens.ts) so the config layer can import it without
// a moduleScreens.ts → financeModel.ts → moduleScreens.ts cycle.
export const FINANCE_MODULE_ACTIONS = {
  read: "finance_voucher_read",
  create: "finance_voucher_create",
  post: "finance_voucher_post",
  link: "object.link.create",
  graph: "object.view",
  audit: "audit_log_read",
  lifecycle: "finance_voucher_read",
} as const;

const wonFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short" });

export function formatWon(value: number | null | undefined): string | undefined {
  return typeof value === "number" ? wonFormatter.format(value) : undefined;
}

function formatDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateFormatter.format(date);
}

/** Status choice id — a direct lowercase mirror of the real backend
 * `VoucherStatus` FSM (finance-gl/domain: Draft → BalanceChecked → Approved →
 * Posted → Reversed). S14 fix: the prior version of this file invented a
 * three-field (lifecycle_state/posting_status/validation_status) shape that
 * does not exist on the wire; there is exactly one status enum. */
export function voucherStatusId(record: VoucherSummary): string {
  return record.status.toLowerCase();
}

const KNOWN_SOURCE_LABEL_KEYS: Partial<Record<string, string>> = {
  approval: `${F}.sources.approval`,
  purchase_request: `${F}.sources.purchase`,
  payroll_run: `${F}.sources.payroll`,
  contract: `${F}.sources.contract`,
};

/** A source type outside the known set renders its raw string rather than an
 * unresolved dotted ko key (never a literal "console.modules.finance..." on
 * screen). */
function sourceTypeLabel(type: string): string {
  const key = KNOWN_SOURCE_LABEL_KEYS[type];
  return key ? resolveText(key) : type;
}

function sourceValue(record: VoucherSummary): ModuleSourceValue | undefined {
  if (!record.source_object_type || !record.source_object_id) return undefined;
  return {
    labelKey: KNOWN_SOURCE_LABEL_KEYS[record.source_object_type] ?? record.source_object_type,
    tone: "info",
    kind: record.source_object_type,
    id: record.source_object_id,
    policyAction: FINANCE_MODULE_ACTIONS.read,
  };
}

function linkChips(record: VoucherSummary): ModuleLinkChipValue[] {
  const chips: ModuleLinkChipValue[] = [
    { key: "lifecycle", labelKey: `${F}.links.lifecycle`, tone: "info", kind: "finance_voucher", id: record.id, code: record.voucher_no, policyAction: FINANCE_MODULE_ACTIONS.lifecycle },
    { key: "objectGraph", labelKey: `${F}.links.graph`, tone: "neutral", kind: "finance_voucher", id: record.id, code: record.voucher_no, policyAction: FINANCE_MODULE_ACTIONS.graph },
    // Any resource is audit-queryable by (kind, id) — real, not a fabricated
    // trace-id field (the old audit_trace_id column does not exist on the wire).
    { key: "auditTrail", labelKey: `${F}.links.audit`, tone: "neutral", kind: "finance_voucher", id: record.id, policyAction: FINANCE_MODULE_ACTIONS.audit },
  ];
  if (record.source_object_type && record.source_object_id) {
    chips.push({
      key: `source:${record.source_object_type}`,
      labelKey: sourceTypeLabel(record.source_object_type),
      tone: "info",
      kind: record.source_object_type,
      id: record.source_object_id,
      policyAction: FINANCE_MODULE_ACTIONS.read,
    });
  }
  if (record.reversal_of_voucher_id) {
    chips.push({ key: "reversalOf", labelKey: `${F}.links.reversalOf`, tone: "purple", kind: "finance_voucher", id: record.reversal_of_voucher_id, policyAction: FINANCE_MODULE_ACTIONS.read });
  }
  if (record.reversed_by_voucher_id) {
    chips.push({ key: "reversedBy", labelKey: `${F}.links.reversedBy`, tone: "purple", kind: "finance_voucher", id: record.reversed_by_voucher_id, policyAction: FINANCE_MODULE_ACTIONS.read });
  }
  // Account drill: one chip per distinct account code — real per-line data,
  // not a fabricated single summary chip.
  const seenAccounts = new Set<string>();
  for (const line of record.lines) {
    if (seenAccounts.has(line.account_code)) continue;
    seenAccounts.add(line.account_code);
    chips.push({
      key: `glAccount:${line.account_code}`,
      labelKey: `${F}.links.glAccount`,
      tone: "accent",
      kind: "gl_account",
      id: line.account_code,
      code: line.account_code,
      policyAction: FINANCE_MODULE_ACTIONS.read,
    });
  }
  return chips;
}

/** 기표→차대검증→승인→전기 — the real backend FSM (finance-gl/domain
 * VoucherStatus + validate_voucher_transition), not invented stages. */
export function documentFlowStepper(record: VoucherSummary): ModuleStepperValue {
  const order: VoucherStatus[] = ["DRAFT", "BALANCE_CHECKED", "APPROVED", "POSTED"];
  const reversed = record.status === "REVERSED";
  // A reversed voucher was posted at some point — every step reads as done,
  // with the post step's reason explaining the revoked terminal state.
  const currentIndex = reversed ? order.length - 1 : order.indexOf(record.status);
  const stateAt = (stepIndex: number): "done" | "current" | "pending" => {
    if (stepIndex <= currentIndex) return "done";
    if (stepIndex === currentIndex + 1) return "current";
    return "pending";
  };
  return {
    steps: [
      { key: "entry", labelKey: `${F}.documentFlow.entry`, state: "done" },
      { key: "validate", labelKey: `${F}.documentFlow.validate`, state: stateAt(1) },
      { key: "approve", labelKey: `${F}.documentFlow.approve`, state: stateAt(2) },
      {
        key: "post",
        labelKey: `${F}.documentFlow.post`,
        state: stateAt(3),
        occurredAt: formatDate(record.posted_at),
        reasonKey: reversed ? `${F}.documentFlow.reversedReason` : undefined,
      },
    ],
  };
}

export function balanceCheckValue(record: VoucherSummary): ModuleBalanceCheckValue {
  const ok = record.debit_total_won === record.credit_total_won && record.debit_total_won > 0;
  return {
    status: ok ? "ok" : "blocked",
    okLabelKey: `${F}.balanceCheck.ok`,
    blockedLabelKey: `${F}.balanceCheck.blocked`,
    totalDebit: formatWon(record.debit_total_won),
    totalDebitLabelKey: `${F}.detail.totalDebit`,
    totalCredit: formatWon(record.credit_total_won),
    totalCreditLabelKey: `${F}.detail.totalCredit`,
  };
}

/** 승인 상신(제출) / 승인 / 전기 / 반제 — one action per legal forward edge of
 * the real FSM, gated on the voucher's current status (mirrors
 * validate_voucher_transition; the backend re-validates and re-authorizes
 * every call, including the SoD `approved_by != created_by` check). */
function rowActions(record: VoucherSummary): ModuleActionConfig[] {
  switch (record.status) {
    case "DRAFT":
      return [{ key: "submitVoucher", labelKey: `${F}.actions.submitVoucher`, policyAction: FINANCE_MODULE_ACTIONS.post }];
    case "BALANCE_CHECKED":
      return [{ key: "approveVoucher", labelKey: `${F}.actions.approveVoucher`, policyAction: FINANCE_MODULE_ACTIONS.post }];
    case "APPROVED":
      return [{ key: "postVoucher", labelKey: `${F}.actions.postVoucher`, policyAction: FINANCE_MODULE_ACTIONS.post }];
    case "POSTED":
      return [{ key: "reverseVoucher", labelKey: `${F}.actions.reverseVoucher`, policyAction: FINANCE_MODULE_ACTIONS.post }];
    case "REVERSED":
      return [];
  }
}

/** Distinct account codes, joined — the real per-line GL summary (never a
 * single fabricated account). */
function glAccountSummary(record: VoucherSummary): string | undefined {
  const codes = [...new Set(record.lines.map((line) => line.account_code))];
  return codes.length > 0 ? codes.join(", ") : undefined;
}

export function voucherRow(record: VoucherSummary): ModuleRow {
  return {
    id: record.id,
    code: record.voucher_no,
    title: record.memo,
    status: choiceStatus("finance_voucher", "status", voucherStatusId(record)),
    source: sourceValue(record),
    cells: {
      title: record.memo,
      amount: formatWon(record.debit_total_won),
      gl: glAccountSummary(record),
      postedAt: formatDate(record.posted_at),
    },
    detail: {
      title: record.memo,
      totalDebitWon: formatWon(record.debit_total_won),
      totalCreditWon: formatWon(record.credit_total_won),
      postedAt: formatDate(record.posted_at),
      createdBy: record.created_by,
      approvedBy: record.approved_by ?? undefined,
      branchScope: record.branch_id,
      glAccountSummary: glAccountSummary(record),
      documentFlow: documentFlowStepper(record),
      balanceCheck: balanceCheckValue(record),
    },
    linkChips: linkChips(record),
    actions: rowActions(record),
  };
}

export interface DraftLine {
  line_no: number;
  account_code: string;
  memo: string;
  debit_won: string;
  credit_won: string;
}

export interface DraftValidation {
  balanced: boolean;
  totalDebit: number;
  totalCredit: number;
  reasonKey?: string;
}

/** Client-side mirror of the backend `compute_balance`/`ensure_balanced` gate
 * — catches the same shape of error before a round trip, not a replacement
 * for the server's own check at 기표→차대검증. */
export function validateDraft(memo: string, lines: DraftLine[]): DraftValidation {
  if (!memo.trim()) return { balanced: false, totalDebit: 0, totalCredit: 0, reasonKey: `${F}.compose.errors.title` };
  if (lines.length < 2) return { balanced: false, totalDebit: 0, totalCredit: 0, reasonKey: `${F}.compose.errors.minLines` };
  const seen = new Set<number>();
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    if (!line.account_code.trim()) return { balanced: false, totalDebit: 0, totalCredit: 0, reasonKey: `${F}.compose.errors.glAccount` };
    if (seen.has(line.line_no)) return { balanced: false, totalDebit: 0, totalCredit: 0, reasonKey: `${F}.compose.errors.duplicateLine` };
    seen.add(line.line_no);
    const debit = Number(line.debit_won) || 0;
    const credit = Number(line.credit_won) || 0;
    if (debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) {
      return { balanced: false, totalDebit: 0, totalCredit: 0, reasonKey: `${F}.compose.errors.onesided` };
    }
    totalDebit += debit;
    totalCredit += credit;
  }
  if (totalDebit !== totalCredit || totalDebit <= 0) {
    return { balanced: false, totalDebit, totalCredit, reasonKey: `${F}.compose.errors.unbalanced` };
  }
  return { balanced: true, totalDebit, totalCredit };
}

export function toCreateRequest(branchId: string, memo: string, lines: DraftLine[]): CreateVoucherRequest {
  const mapped: VoucherLineInput[] = lines.map((line) => {
    const debit = Number(line.debit_won) || 0;
    const side: DebitCredit = debit > 0 ? "DEBIT" : "CREDIT";
    const amount = debit > 0 ? debit : Number(line.credit_won) || 0;
    return {
      account_code: line.account_code.trim(),
      side,
      amount_won: amount,
      memo: line.memo.trim() || undefined,
    };
  });
  return { branch_id: branchId, memo: memo.trim(), lines: mapped };
}

/** Real counts over the fetched page (§4-11: every stat drills, none
 * fabricated). 당월수입/당월지출 are NOT computed here: the backend carries no
 * revenue/expense account classification (account_code is a free-form string,
 * no chart-of-accounts type field on the wire) — inventing one would be
 * fabricated data, not a real stat. */
function voucherStats(items: VoucherSummary[]): Record<string, number> {
  const currentPeriod = new Date().toISOString().slice(0, 7);
  let pending = 0;
  let postedThisMonth = 0;
  let postedAmountThisMonth = 0;
  let auto = 0;
  for (const item of items) {
    if (item.status !== "POSTED" && item.status !== "REVERSED") pending += 1;
    if (item.status === "POSTED" && item.posted_at?.slice(0, 7) === currentPeriod) {
      postedThisMonth += 1;
      postedAmountThisMonth += item.debit_total_won;
    }
    if (item.source_object_type) auto += 1;
  }
  return { pending, postedThisMonth, postedAmountThisMonth, auto };
}

export function makeFinanceDataAdapter(
  renderCompose: ModuleDataAdapter["renderCompose"],
): ModuleDataAdapter {
  return {
    async loadRows({ api }) {
      const items = await listVouchers(api);
      return {
        rows: items.map(voucherRow),
        stats: { total: items.length, ...voucherStats(items) },
        selectedRowId: items[0]?.id,
      };
    },
    async loadDetail({ api, row }) {
      const record = await getVoucher(api, row.id);
      return { row: voucherRow(record) };
    },
    renderCompose,
    async executeAction({ api, row, action }) {
      const call =
        action.key === "submitVoucher" ? submitVoucherApi :
        action.key === "approveVoucher" ? approveVoucherApi :
        action.key === "postVoucher" ? postVoucherApi :
        action.key === "reverseVoucher" ? reverseVoucherApi :
        undefined;
      if (!call) return;
      const record = await call(api, row.id);
      return { row: voucherRow(record) };
    },
  };
}

export async function submitVoucherDraft(
  api: ConsoleApiClient,
  branchId: string,
  memo: string,
  lines: DraftLine[],
): Promise<VoucherSummary> {
  return createVoucherDraft(api, toCreateRequest(branchId, memo, lines));
}
