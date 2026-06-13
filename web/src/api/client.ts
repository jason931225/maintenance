import { createMaintenanceApiClient } from "@maintenance/api-client-ts";

import { getDeviceId } from "./device";

export function createConsoleApiClient(bearerToken?: string) {
  const client = createMaintenanceApiClient({
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? window.location.origin,
    bearerToken,
  });

  // Attach a stable X-Device-Id to every request so the backend can apply its
  // optional per-device auth rate limit. Best-effort: omitted when unavailable.
  client.use({
    onRequest({ request }) {
      const deviceId = getDeviceId();
      if (deviceId) {
        request.headers.set("X-Device-Id", deviceId);
      }
      return request;
    },
  });

  return client;
}

export type ConsoleApiClient = ReturnType<typeof createConsoleApiClient>;
