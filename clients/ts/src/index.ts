import createClient from "openapi-fetch";

import type { paths } from "./schema";

export type { components, operations, paths } from "./schema";

export interface MaintenanceApiClientOptions {
  baseUrl: string;
  bearerToken?: string;
}

export function createMaintenanceApiClient(options: MaintenanceApiClientOptions) {
  const headers = options.bearerToken
    ? { Authorization: `Bearer ${options.bearerToken}` }
    : undefined;

  return createClient<paths>({
    baseUrl: options.baseUrl,
    headers,
  });
}
