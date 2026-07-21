// 레인1 leave — module-specific api client for the self-service 연차 신청 create.
//
// POST /api/v2/leave/requests (operationId createLeaveRequestV2). The caller files
// a request for THEMSELVES: the backend resolves subject_employee_id + branch_id
// from the authenticated caller's account (users.employee_id + user_branches),
// never from this body — so the FE cannot (and must not) send them. `days` is
// derived server-side; the FE sends only leave_type + dates + reason.
//
// Typing boundary: the generated openapi-fetch path map now carries the merged
// `createLeaveRequest` contract, so `api.POST` is compile-checked against the
// generated `LeaveCreateRequest` body + `LeaveRequestView` response — no cast.
// Fail-closed: any non-2xx (no `data`) yields { ok: false }.
import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";
import type { LeaveRequestView } from "../../api/types";

export type CreateLeaveRequestInput = Omit<
  components["schemas"]["LeaveCreateRequest"],
  "idempotency_key"
>;

export interface CreateLeaveRequestResult {
  ok: boolean;
  data?: LeaveRequestView;
  error?: unknown;
}

export async function createLeaveRequest(
  api: ConsoleApiClient,
  input: CreateLeaveRequestInput,
  idempotencyKey: string,
): Promise<CreateLeaveRequestResult> {
  const body = { ...input, idempotency_key: idempotencyKey };
  const { data, error } = await api.POST("/api/v2/leave/requests", { body });
  if (!data) return { ok: false, error };
  return { ok: true, data };
}
