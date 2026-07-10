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
  createVoucher,
  getVoucher,
  listVouchers,
  postVoucher as postVoucherApi,
  reverseVoucher as reverseVoucherApi,
  type CreateVoucherRequest,
  type VoucherLine,
  type VoucherRecord,
  type VoucherValidationStatus,
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

/** Status choice id — validation/posting override lifecycle since they gate
 * what a user can actually do next (mirrors backend validate_post_transition:
 * posting requires lifecycle draft|review, posting_status unposted, and a
 * valid validation_status). */
export function voucherStatusId(record: VoucherRecord): string {
  if (record.validation_status !== "valid") return "invalid";
  if (record.posting_status === "posted") return "posted";
  // ponytail: "reversed" has no dedicated registry choice yet; "revision"
  // (개정) is the closest existing tone — add a real "reversed" choice if a
  // future review wants it distinguished from an in-flight edit.
  if (record.posting_status === "reversed") return "revision";
  return record.lifecycle_state;
}

function sourceValue(record: VoucherRecord): ModuleSourceValue | undefined {
  if (!record.source_kind) return undefined;
  return {
    labelKey: `${F}.sources.${record.source_kind}`,
    tone: "info",
    kind: record.source_kind,
    id: record.source_id ?? record.source_code ?? record.source_kind,
    code: record.source_code ?? undefined,
    policyAction: FINANCE_MODULE_ACTIONS.read,
  };
}

const SOURCE_LINK_KEY: Record<NonNullable<VoucherRecord["source_kind"]>, string> = {
  dx: "sourceDx",
  approval: "sourceAp",
  payroll: "sourcePayroll",
  purchase: "sourcePurchase",
  contract: "sourceContract",
  manual: "sourceDx",
};

function linkChips(record: VoucherRecord): ModuleLinkChipValue[] {
  const chips: ModuleLinkChipValue[] = [
    { key: "lifecycle", labelKey: `${F}.links.lifecycle`, tone: "info", kind: "finance_voucher", id: record.id, code: record.code, policyAction: FINANCE_MODULE_ACTIONS.lifecycle },
    { key: "objectGraph", labelKey: `${F}.links.graph`, tone: "neutral", kind: "finance_voucher", id: record.id, code: record.code, policyAction: FINANCE_MODULE_ACTIONS.graph },
  ];
  if (record.audit_trace_id) {
    chips.push({ key: "auditTrail", labelKey: `${F}.links.audit`, tone: "neutral", kind: "audit_trace", id: record.audit_trace_id, policyAction: FINANCE_MODULE_ACTIONS.audit });
  }
  if (record.source_kind && (record.source_id || record.source_code)) {
    chips.push({
      key: SOURCE_LINK_KEY[record.source_kind],
      labelKey: `${F}.links.${record.source_kind === "manual" ? "dx" : record.source_kind}`,
      tone: "info",
      kind: record.source_kind,
      id: record.source_id ?? record.source_code ?? record.source_kind,
      code: record.source_code ?? undefined,
      policyAction: FINANCE_MODULE_ACTIONS.read,
    });
  }
  // Account drill: one chip per distinct GL line — real per-line data, not a
  // fabricated single summary chip.
  const seenAccounts = new Set<string>();
  for (const line of record.lines) {
    if (seenAccounts.has(line.gl_account_id)) continue;
    seenAccounts.add(line.gl_account_id);
    chips.push({
      key: `glAccount:${line.gl_account_id}`,
      labelKey: `${F}.links.glAccount`,
      tone: "accent",
      kind: "gl_account",
      id: line.gl_account_id,
      code: line.gl_account_code ?? line.gl_account_id,
      policyAction: FINANCE_MODULE_ACTIONS.read,
    });
  }
  return chips;
}

/** 기표→차대검증→승인→전기 — grounded in the three real backend fields
 * (voucher.rs VoucherLifecycleState/PostingStatus/ValidationStatus +
 * validate_post_transition's draft|review→post gate), not invented stages. */
export function documentFlowStepper(record: VoucherRecord): ModuleStepperValue {
  const validationDone = record.validation_status === "valid";
  const approvalDone = record.lifecycle_state === "active" || record.lifecycle_state === "archived" || record.lifecycle_state === "disposed";
  const approvalCurrent = record.lifecycle_state === "review";
  const postingDone = record.posting_status === "posted";
  const postingBlocked = record.posting_status !== "posted" && (!validationDone || !approvalDone) && record.posting_status !== "reversed";

  return {
    steps: [
      // A loaded voucher has, by definition, been entered.
      { key: "entry", labelKey: `${F}.documentFlow.entry`, state: "done" },
      {
        key: "validate",
        labelKey: `${F}.documentFlow.validate`,
        state: validationDone ? "done" : "blocked",
        reasonKey: validationDone ? undefined : `${F}.validationReasons.${record.validation_status}`,
      },
      {
        key: "approve",
        labelKey: `${F}.documentFlow.approve`,
        state: approvalDone ? "done" : approvalCurrent ? "current" : "pending",
      },
      {
        key: "post",
        labelKey: `${F}.documentFlow.post`,
        state: postingDone ? "done" : record.posting_status === "reversed" ? "blocked" : postingBlocked ? "blocked" : "current",
        occurredAt: formatDate(record.posted_at),
        reasonKey: record.posting_status === "reversed" ? `${F}.documentFlow.reversedReason` : undefined,
      },
    ],
  };
}

export function balanceCheckValue(record: VoucherRecord): ModuleBalanceCheckValue {
  const ok = record.validation_status === "valid" && record.total_debit_won === record.total_credit_won;
  return {
    status: ok ? "ok" : "blocked",
    okLabelKey: `${F}.balanceCheck.ok`,
    blockedLabelKey: `${F}.balanceCheck.blocked`,
    totalDebit: formatWon(record.total_debit_won),
    totalDebitLabelKey: `${F}.detail.totalDebit`,
    totalCredit: formatWon(record.total_credit_won),
    totalCreditLabelKey: `${F}.detail.totalCredit`,
    reasonKey: ok ? undefined : `${F}.validationReasons.${record.validation_status}`,
  };
}

// openSource/openGraph/openLifecycle are covered by the (real, per-row)
// linkChips above — a second control for the same destination would be a
// §4-18 duplicate shape. Only genuinely distinct, executable operations are
// row actions here, each wired to financeDataAdapter.executeAction below.
function rowActions(record: VoucherRecord): ModuleActionConfig[] {
  const actions: ModuleActionConfig[] = [];
  const canPost =
    record.posting_status === "unposted" &&
    record.validation_status === "valid" &&
    (record.lifecycle_state === "draft" || record.lifecycle_state === "review");
  if (canPost) {
    actions.push({ key: "postVoucher", labelKey: `${F}.actions.postVoucher`, policyAction: FINANCE_MODULE_ACTIONS.post });
  }
  if (record.posting_status === "posted") {
    actions.push({ key: "reverseVoucher", labelKey: `${F}.actions.reverseVoucher`, policyAction: FINANCE_MODULE_ACTIONS.post });
  }
  return actions;
}

export function voucherRow(record: VoucherRecord): ModuleRow {
  return {
    id: record.id,
    code: record.code,
    title: record.title,
    status: choiceStatus("finance_voucher", "status", voucherStatusId(record)),
    source: sourceValue(record),
    cells: {
      title: record.title,
      amount: formatWon(record.total_debit_won),
      gl: record.gl_account_summary ?? undefined,
      postedAt: formatDate(record.posted_at),
    },
    detail: {
      title: record.title,
      lifecyclePhase: resolveText(choiceStatus("finance_voucher", "status", record.lifecycle_state).labelKey),
      lifecycleVersion: String(record.lifecycle_version),
      postingStatus: resolveText(`${F}.postingStatuses.${record.posting_status}`),
      period: record.period ?? undefined,
      voucherDate: formatDate(record.voucher_date),
      postedAt: formatDate(record.posted_at),
      totalDebitWon: formatWon(record.total_debit_won),
      totalCreditWon: formatWon(record.total_credit_won),
      sourceKind: record.source_kind ? resolveText(`${F}.sources.${record.source_kind}`) : undefined,
      sourceCode: record.source_code ?? undefined,
      glAccountSummary: record.gl_account_summary ?? undefined,
      orgScope: record.org_scope ?? undefined,
      branchScope: record.branch_scope ?? undefined,
      createdBy: record.created_by ?? undefined,
      auditTraceId: record.audit_trace_id ?? undefined,
      documentFlow: documentFlowStepper(record),
      balanceCheck: balanceCheckValue(record),
    },
    linkChips: linkChips(record),
    actions: rowActions(record),
  };
}

export interface DraftLine {
  line_no: number;
  gl_account_id: string;
  description: string;
  debit_won: string;
  credit_won: string;
}

export interface DraftValidation {
  balanced: boolean;
  totalDebit: number;
  totalCredit: number;
  reasonKey?: string;
}

/** Client-side mirror of backend validate_voucher_draft — catches the same
 * shape of error before a round trip, not a replacement for server validation. */
export function validateDraft(title: string, lines: DraftLine[]): DraftValidation {
  if (!title.trim()) return { balanced: false, totalDebit: 0, totalCredit: 0, reasonKey: `${F}.compose.errors.title` };
  if (lines.length < 2) return { balanced: false, totalDebit: 0, totalCredit: 0, reasonKey: `${F}.compose.errors.minLines` };
  const seen = new Set<number>();
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    if (!line.gl_account_id.trim()) return { balanced: false, totalDebit: 0, totalCredit: 0, reasonKey: `${F}.compose.errors.glAccount` };
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

export function toCreateRequest(title: string, memo: string, lines: DraftLine[]): CreateVoucherRequest {
  const mapped: VoucherLine[] = lines.map((line) => ({
    line_no: line.line_no,
    gl_account_id: line.gl_account_id.trim(),
    description: line.description.trim() || null,
    debit_won: Number(line.debit_won) || 0,
    credit_won: Number(line.credit_won) || 0,
  }));
  return {
    title: title.trim(),
    memo: memo.trim() || undefined,
    lines: mapped,
  };
}

const EXCEPTION_STATUSES: ReadonlySet<VoucherValidationStatus> = new Set([
  "unbalanced",
  "invalid_gl_account",
  "source_missing",
]);

/** Real counts over the fetched page — matches the statbar `source:` docs on
 * financeModuleScreen (review/posted/linked/exceptions), never fabricated. */
function voucherStats(items: VoucherRecord[]): Record<string, number> {
  const currentPeriod = new Date().toISOString().slice(0, 7);
  let review = 0;
  let posted = 0;
  let linked = 0;
  let exceptions = 0;
  for (const item of items) {
    if (item.lifecycle_state === "draft" || item.lifecycle_state === "review") review += 1;
    if (item.posting_status === "posted" && item.period === currentPeriod) posted += 1;
    if (item.source_kind) linked += 1;
    if (EXCEPTION_STATUSES.has(item.validation_status)) exceptions += 1;
  }
  return { review, posted, linked, exceptions };
}

export function makeFinanceDataAdapter(
  renderCompose: ModuleDataAdapter["renderCompose"],
): ModuleDataAdapter {
  return {
    async loadRows({ api, query }) {
      const response = await listVouchers(api, query);
      // Fail-closed (§4-10): a transport/backend error resolves listVouchers to
      // undefined (rawRequest swallows it). A successful empty result is
      // `{ items: [] }`, never undefined — so undefined here is always a real
      // failure and must surface as GenericModuleScreen's listFailed error
      // state, not a normal empty list. Mirrors EvidenceRecords.loadList.
      if (!response) throw new Error("finance voucher list request failed");
      const items = response.items;
      return {
        rows: items.map(voucherRow),
        stats: { total: response.total, ...voucherStats(items) },
        selectedRowId: items[0]?.id,
      };
    },
    async loadDetail({ api, row }) {
      const record = await getVoucher(api, row.id);
      if (!record) return { row };
      return { row: voucherRow(record) };
    },
    renderCompose,
    async executeAction({ api, row, action }) {
      const call = action.key === "postVoucher" ? postVoucherApi : action.key === "reverseVoucher" ? reverseVoucherApi : undefined;
      if (!call) return;
      const record = await call(api, row.id);
      if (!record) throw new Error(`finance voucher ${action.key} failed`);
      return { row: voucherRow(record) };
    },
  };
}

export async function submitVoucherDraft(
  api: ConsoleApiClient,
  title: string,
  memo: string,
  lines: DraftLine[],
): Promise<VoucherRecord | undefined> {
  return createVoucher(api, toCreateRequest(title, memo, lines));
}
