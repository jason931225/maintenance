// Real finance-gl REST wiring (backend/crates/finance-gl/rest, openapi tag
// `finance-gl`) — the actual 기표→차대검증→승인→전기→역분개 voucher FSM. S14
// re-model: the prior version of this file targeted a `/api/v1/finance/vouchers`
// path that was never implemented (a `rawRequest` `as never` placeholder); the
// real mounted route is `/api/v1/finance-gl/vouchers*` with a single
// `VoucherStatus` enum (DRAFT|BALANCE_CHECKED|APPROVED|POSTED|REVERSED), not the
// three-field (lifecycle/posting/validation) shape this file used to assume.
import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";
import { ApiCallError } from "../../api/ontologyActions";
import { isUuid } from "../../lib/utils";

export type VoucherStatus = components["schemas"]["VoucherStatus"];
export type DebitCredit = components["schemas"]["DebitCredit"];
export type VoucherLineInput = components["schemas"]["VoucherLineInput"];
export type VoucherLineSummary = components["schemas"]["VoucherLineSummary"];
export type VoucherSummary = components["schemas"]["VoucherSummary"];
export type CreateVoucherRequest = components["schemas"]["CreateVoucherRequest"];
export type BranchSummary = components["schemas"]["BranchSummary"];

export async function listVouchers(
  api: ConsoleApiClient,
  opts: { branchId?: string; status?: VoucherStatus } = {},
): Promise<VoucherSummary[]> {
  const { data, error, response } = await api.GET("/api/v1/finance-gl/vouchers", {
    params: { query: { branch_id: opts.branchId, status: opts.status } },
  });
  if (!data) throw new ApiCallError(response.status, error);
  return data;
}

export async function getVoucher(api: ConsoleApiClient, voucherId: string): Promise<VoucherSummary> {
  const { data, error, response } = await api.GET("/api/v1/finance-gl/vouchers/{voucher_id}", {
    params: { path: { voucher_id: voucherId } },
  });
  if (!data) throw new ApiCallError(response.status, error);
  return data;
}

export async function createVoucherDraft(
  api: ConsoleApiClient,
  request: CreateVoucherRequest,
): Promise<VoucherSummary> {
  const { data, error, response } = await api.POST("/api/v1/finance-gl/vouchers", { body: request });
  if (!data) throw new ApiCallError(response.status, error);
  return data;
}

export async function submitVoucher(api: ConsoleApiClient, voucherId: string): Promise<VoucherSummary> {
  const { data, error, response } = await api.POST("/api/v1/finance-gl/vouchers/{voucher_id}/submit", {
    params: { path: { voucher_id: voucherId } },
  });
  if (!data) throw new ApiCallError(response.status, error);
  return data;
}

export async function approveVoucher(api: ConsoleApiClient, voucherId: string): Promise<VoucherSummary> {
  const { data, error, response } = await api.POST("/api/v1/finance-gl/vouchers/{voucher_id}/approve", {
    params: { path: { voucher_id: voucherId } },
  });
  if (!data) throw new ApiCallError(response.status, error);
  return data;
}

export async function postVoucher(api: ConsoleApiClient, voucherId: string): Promise<VoucherSummary> {
  const { data, error, response } = await api.POST("/api/v1/finance-gl/vouchers/{voucher_id}/post", {
    params: { path: { voucher_id: voucherId } },
  });
  if (!data) throw new ApiCallError(response.status, error);
  return data;
}

export async function reverseVoucher(
  api: ConsoleApiClient,
  voucherId: string,
  memo = "",
): Promise<VoucherSummary> {
  const { data, error, response } = await api.POST("/api/v1/finance-gl/vouchers/{voucher_id}/reverse", {
    params: { path: { voucher_id: voucherId } },
    body: { memo },
  });
  if (!data) throw new ApiCallError(response.status, error);
  return data;
}

/** Branch picker for voucher drafting (create requires a `branch_id`). */
export async function listBranches(api: ConsoleApiClient): Promise<BranchSummary[]> {
  const { data, error, response } = await api.GET("/api/v1/branches");
  if (!data) throw new ApiCallError(response.status, error);
  return data.filter((branch) => !branch.deactivated_at);
}

/** Runtime view of the generated `AccountDrillEntry` wire schema. The
 * generated client selects the operation; this concrete view is only exposed
 * after the fail-closed decoder validates every wire field. */
export interface AccountDrillEntry {
  voucher_id: string;
  voucher_no: string;
  status: "DRAFT" | "BALANCE_CHECKED" | "APPROVED" | "POSTED" | "REVERSED";
  line_id: string;
  account_code: string;
  side: "DEBIT" | "CREDIT";
  amount_won: number;
  source_object_type?: string | null;
  source_object_id?: string | null;
  entry_at: string;
}

export class FinanceAccountDrillContractError extends Error {
  constructor() {
    super("accountDrill returned an invalid response");
    this.name = "FinanceAccountDrillContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isSafeWonAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function hasPairedSourceIdentity(type: unknown, id: unknown): boolean {
  return (type == null && id == null) || (isString(type) && isString(id));
}

/** Mirrors the strict calendar/time/offset validation used by attendance DTOs.
 * `Date.parse` alone accepts implementation-specific invalid values, so a
 * successful parse is necessary but not sufficient for a backend RFC3339
 * `date-time` field. */
function isRfc3339DateTime(value: unknown): value is string {
  if (!isString(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = match.slice(1, 7);
  const [year, month, day, hour, minute, second] = [rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) return false;
  const rawOffsetHour = match.at(8);
  const rawOffsetMinute = match.at(9);
  if (rawOffsetHour !== undefined && (Number(rawOffsetHour) > 23 || rawOffsetMinute === undefined || Number(rawOffsetMinute) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function isAccountDrillEntry(value: unknown): value is AccountDrillEntry {
  return (
    isRecord(value) &&
    isString(value.voucher_id) &&
    isUuid(value.voucher_id) &&
    isString(value.voucher_no) &&
    (value.status === "DRAFT" ||
      value.status === "BALANCE_CHECKED" ||
      value.status === "APPROVED" ||
      value.status === "POSTED" ||
      value.status === "REVERSED") &&
    isString(value.line_id) &&
    isUuid(value.line_id) &&
    isString(value.account_code) &&
    (value.side === "DEBIT" || value.side === "CREDIT") &&
    isSafeWonAmount(value.amount_won) &&
    hasPairedSourceIdentity(value.source_object_type, value.source_object_id) &&
    isRfc3339DateTime(value.entry_at)
  );
}

export function parseAccountDrillEntries(value: unknown): AccountDrillEntry[] {
  if (!Array.isArray(value) || !value.every(isAccountDrillEntry)) {
    throw new FinanceAccountDrillContractError();
  }
  return value;
}

/** Real GL account drill. Account scope, organization scope, and authorization
 * are exclusively enforced by the backend; this UI only renders the returned
 * tenant-authorized voucher-line identities. */
export async function listAccountDrillEntries(
  api: ConsoleApiClient,
  accountCode: string,
  signal?: AbortSignal,
): Promise<AccountDrillEntry[]> {
  const { data, error, response } = await api.GET(
    "/api/v1/finance-gl/accounts/{account_code}/entries",
    { params: { path: { account_code: accountCode } }, signal },
  );
  if (!data) throw new ApiCallError(response.status, error);
  return parseAccountDrillEntries(data);
}
