import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";

export type DailyPlan = components["schemas"]["DailyPlanSummary"];
export type CreateDailyPlan = components["schemas"]["CreateDailyPlanRequest"];
export type ReviewDailyPlan = components["schemas"]["ReviewDailyPlanRequest"];

export class ProductionApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProductionApiError";
  }
}

function message(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return `Production request failed (${String(status)})`;
}

function requireData<T>(response: { data?: T; error?: unknown; response: Response }): T {
  if (response.data !== undefined) return response.data;
  throw new ProductionApiError(message(response.error, response.response.status), response.response.status);
}

/** Daily-plan transport bound to the authenticated ConsoleApiClient. */
export function createProductionApi(api: ConsoleApiClient) {
  return {
    list: async (planDate?: string, signal?: AbortSignal) => {
      const response = await api.GET("/api/daily-work-plans", {
        params: { query: planDate ? { plan_date: planDate } : {} },
        signal,
      });
      return requireData(response);
    },
    get: async (id: string, signal?: AbortSignal) => {
      const response = await api.GET("/api/daily-work-plans/{planId}", {
        params: { path: { planId: id } },
        signal,
      });
      return requireData(response);
    },
    create: async (input: CreateDailyPlan, signal?: AbortSignal) => {
      const response = await api.POST("/api/daily-work-plans", { body: input, signal });
      return requireData(response);
    },
    requestReview: async (id: string, signal?: AbortSignal) => {
      const response = await api.POST("/api/daily-work-plans/{planId}/request-review", {
        params: { path: { planId: id } },
        signal,
      });
      return requireData(response);
    },
    review: async (id: string, input: ReviewDailyPlan, signal?: AbortSignal) => {
      const response = await api.POST("/api/daily-work-plans/{planId}/review", {
        params: { path: { planId: id } },
        body: input,
        signal,
      });
      return requireData(response);
    },
    confirm: async (id: string, signal?: AbortSignal) => {
      const response = await api.POST("/api/daily-work-plans/{planId}/confirm", {
        params: { path: { planId: id } },
        signal,
      });
      return requireData(response);
    },
  };
}

export type ProductionApi = ReturnType<typeof createProductionApi>;
