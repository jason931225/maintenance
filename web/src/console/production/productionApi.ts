import type { components } from "@maintenance/api-client-ts";

export type ProductionPlan = components["schemas"]["ProductionPlan"];
export type ProductionPlanDetail = components["schemas"]["ProductionPlanDetail"];
export type CreateProductionPlan = components["schemas"]["CreateProductionPlan"];
type ProductionOperation = components["schemas"]["ProductionOperation"];

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
  record: (planId: string, operationId: string, input: { expected_version: number; idempotency_key: string; output_quantity: number; scrap_quantity: number; downtime_minutes: number; quality_evidence_ref: string; quality_passed: boolean; note: string }) => request<ProductionOperation>(`/api/v1/production/plans/${planId}/operations/${operationId}/records`, { method: "POST", body: JSON.stringify(input) }),
};
