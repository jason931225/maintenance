import { createMaintenanceApiClient } from "@maintenance/api-client-ts";

export function createConsoleApiClient(bearerToken?: string) {
  return createMaintenanceApiClient({
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? window.location.origin,
    bearerToken,
  });
}

export type ConsoleApiClient = ReturnType<typeof createConsoleApiClient>;
