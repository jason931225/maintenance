import { createMaintenanceApiClient } from "@maintenance/api-client-ts";

import { getDeviceId } from "./device";

export function createConsoleApiClient(bearerToken?: string) {
  const client = createMaintenanceApiClient({
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? window.location.origin,
    bearerToken,
  });

  client.use({
    onRequest({ request }) {
      // Opt this (web) client into the cookie transport for the refresh token:
      // the backend then sets `mnt_refresh` as an HttpOnly cookie and omits the
      // refresh token from response bodies. Mobile clients never send this header
      // and keep the body-based refresh token.
      request.headers.set("X-Auth-Transport", "cookie");

      // Attach a stable X-Device-Id so the backend can apply its optional
      // per-device auth rate limit. Best-effort: omitted when unavailable.
      const deviceId = getDeviceId();
      if (deviceId) {
        request.headers.set("X-Device-Id", deviceId);
      }

      // Send and accept the HttpOnly refresh cookie (`mnt_refresh`). The browser
      // attaches it only to /api/v1/auth requests (the cookie's Path scope), so
      // ordinary API calls still carry just the Authorization bearer header.
      // openapi-fetch builds the Request before middleware runs, and a Request's
      // `credentials` is immutable, so we return a credentials-augmented clone
      // that inherits the headers set above.
      return new Request(request, { credentials: "include" });
    },
  });

  return client;
}

export type ConsoleApiClient = ReturnType<typeof createConsoleApiClient>;
