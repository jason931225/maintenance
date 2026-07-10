// wire-pending: W1-voucher-gl — /api/v1/finance/vouchers* is not yet in the
// generated OpenAPI client (backend/crates/financial/{domain,rest} land the
// route in a parallel lane). Shapes here mirror the real domain model
// (backend/crates/financial/domain/src/voucher.rs: VoucherLifecycleState,
// VoucherPostingStatus, VoucherValidationStatus, CreateFinanceVoucherLineInput)
// so wiring is a swap: drop the `as never` path casts once the client
// regenerates with these paths, and the field shapes need no rework.
import type { ConsoleApiClient } from "../../api/client";

export type VoucherLifecycleState = "draft" | "review" | "active" | "archived" | "disposed";
export type VoucherPostingStatus = "unposted" | "posted" | "reversed";
export type VoucherValidationStatus =
  | "valid"
  | "unbalanced"
  | "invalid_gl_account"
  | "source_missing"
  | "period_locked";

export interface VoucherLine {
  line_no: number;
  gl_account_id: string;
  gl_account_code?: string;
  gl_account_name?: string;
  description?: string | null;
  debit_won: number;
  credit_won: number;
}

export interface VoucherRecord {
  id: string;
  code: string;
  title: string;
  memo?: string | null;
  lifecycle_state: VoucherLifecycleState;
  lifecycle_version: number;
  posting_status: VoucherPostingStatus;
  validation_status: VoucherValidationStatus;
  period?: string | null;
  voucher_date?: string | null;
  posted_at?: string | null;
  total_debit_won: number;
  total_credit_won: number;
  source_kind?: "dx" | "approval" | "payroll" | "purchase" | "contract" | "manual" | null;
  source_code?: string | null;
  source_id?: string | null;
  gl_account_summary?: string | null;
  org_scope?: string | null;
  branch_scope?: string | null;
  created_by?: string | null;
  audit_trace_id?: string | null;
  lines: VoucherLine[];
}

export interface VoucherListResponse {
  items: VoucherRecord[];
  total: number;
}

export interface CreateVoucherRequest {
  title: string;
  memo?: string;
  voucher_date?: string;
  lines: Array<Pick<VoucherLine, "line_no" | "gl_account_id" | "description" | "debit_won" | "credit_won">>;
}

interface RawFetchInit {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

/** Routes through the shared authenticated client (retry/refresh/cache) for a
 * path the generated schema does not know about yet — see file header. */
async function rawRequest<TResponse>(
  api: ConsoleApiClient,
  path: string,
  init: RawFetchInit = {},
): Promise<TResponse | undefined> {
  const method = init.method ?? "GET";
  const opts = {
    params: init.query ? { query: init.query } : undefined,
    body: init.body,
  };
  const call = method === "GET" ? api.GET : api.POST;
  const response = await (call as unknown as (
    p: string,
    o: unknown,
  ) => Promise<{ data?: TResponse; error?: unknown }>)(path, opts).catch(() => undefined);
  return response?.data;
}

export async function listVouchers(
  api: ConsoleApiClient,
  query: string,
): Promise<VoucherListResponse | undefined> {
  return rawRequest<VoucherListResponse>(api, "/api/v1/finance/vouchers", {
    query: query.trim() ? { q: query.trim() } : undefined,
  });
}

export async function getVoucher(api: ConsoleApiClient, voucherId: string): Promise<VoucherRecord | undefined> {
  return rawRequest<VoucherRecord>(api, `/api/v1/finance/vouchers/${voucherId}`);
}

export async function createVoucher(
  api: ConsoleApiClient,
  request: CreateVoucherRequest,
): Promise<VoucherRecord | undefined> {
  return rawRequest<VoucherRecord>(api, "/api/v1/finance/vouchers", { method: "POST", body: request });
}

export async function postVoucher(api: ConsoleApiClient, voucherId: string): Promise<VoucherRecord | undefined> {
  return rawRequest<VoucherRecord>(api, `/api/v1/finance/vouchers/${voucherId}/post`, { method: "POST" });
}

export async function reverseVoucher(api: ConsoleApiClient, voucherId: string): Promise<VoucherRecord | undefined> {
  return rawRequest<VoucherRecord>(api, `/api/v1/finance/vouchers/${voucherId}/reverse`, { method: "POST" });
}
