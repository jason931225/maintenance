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
