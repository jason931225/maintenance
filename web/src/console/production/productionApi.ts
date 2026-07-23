export type ProductionPlan = {
  id: string; branch_id: string; customer_demand_id: string; product_code: string;
  quantity: number; status: "DRAFT" | "RELEASED"; version: number;
  first_operation_id: string; created_at: string; due_at: string;
};
export type ProductionPlanDetail = ProductionPlan & {
  checks: Record<string, unknown>;
  events: Array<{ id: string; event_type: string; actor_id: string; payload: Record<string, unknown>; occurred_at: string }>;
  operation: { id: string; sequence: number; status: string; output_quantity: number; scrap_quantity: number; downtime_minutes: number; quality_evidence_ref: string | null; quality_passed: boolean | null; version: number };
};
export type CreateProductionPlan = {
  branch_id: string; customer_demand_id: string; product_code: string; quantity: number; due_at: string;
  checks: { capacity_ok: boolean; material_ok: boolean; staffing_ok: boolean; capacity_reference: string; material_reference: string; staffing_reference: string };
  approval_ref?: string; ontology_type: string; idempotency_key: string;
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...(options?.headers ?? {}) }, ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Production request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
export const productionApi = {
  list: (branchId: string, offset = 0) => request<ProductionPlan[]>(`/api/v1/production/plans?branch_id=${encodeURIComponent(branchId)}&limit=25&offset=${offset}`),
  get: (id: string) => request<ProductionPlanDetail>(`/api/v1/production/plans/${id}`),
  create: (input: CreateProductionPlan) => request<ProductionPlan>("/api/v1/production/plans", { method: "POST", body: JSON.stringify(input) }),
  release: (id: string, version: number, idempotencyKey: string) => request<ProductionPlan>(`/api/v1/production/plans/${id}/release`, { method: "POST", body: JSON.stringify({ expected_version: version, idempotency_key: idempotencyKey }) }),
  record: (planId: string, operationId: string, input: { expected_version: number; idempotency_key: string; output_quantity: number; scrap_quantity: number; downtime_minutes: number; quality_evidence_ref: string; quality_passed: boolean; note: string }) => request<ProductionPlanDetail["operation"]>(`/api/v1/production/plans/${planId}/operations/${operationId}/records`, { method: "POST", body: JSON.stringify(input) }),
};
