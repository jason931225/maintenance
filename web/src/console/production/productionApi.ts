import type { components } from "@maintenance/api-client-ts";

export type DailyPlan = components["schemas"]["DailyPlanSummary"];
export type CreateDailyPlan = components["schemas"]["CreateDailyPlanRequest"];
export type ReviewDailyPlan = components["schemas"]["ReviewDailyPlanRequest"];

export class ProductionApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProductionApiError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(path, {
    credentials: "include",
    headers,
    ...options,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new ProductionApiError(
      body?.error?.message ?? `Production request failed (${String(response.status)})`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

export const productionApi = {
  list: (planDate?: string, signal?: AbortSignal) =>
    request<{ items: DailyPlan[] }>(
      `/api/daily-work-plans${planDate ? `?plan_date=${encodeURIComponent(planDate)}` : ""}`,
      { signal },
    ),
  get: (id: string, signal?: AbortSignal) =>
    request<DailyPlan>(`/api/daily-work-plans/${encodeURIComponent(id)}`, { signal }),
  create: (input: CreateDailyPlan, signal?: AbortSignal) =>
    request<DailyPlan>("/api/daily-work-plans", {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    }),
  requestReview: (id: string, signal?: AbortSignal) =>
    request<DailyPlan>(`/api/daily-work-plans/${encodeURIComponent(id)}/request-review`, {
      method: "POST",
      signal,
    }),
  review: (id: string, input: ReviewDailyPlan, signal?: AbortSignal) =>
    request<DailyPlan>(`/api/daily-work-plans/${encodeURIComponent(id)}/review`, {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    }),
  confirm: (id: string, signal?: AbortSignal) =>
    request<DailyPlan>(`/api/daily-work-plans/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      signal,
    }),
};
