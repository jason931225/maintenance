import { createMaintenanceApiClient } from "@maintenance/api-client-ts";

import { getDeviceId } from "./device";
import { shouldSkipAuthRefresh, singleFlightRefresh } from "./refresh";

const retryableRequestClones = new WeakMap<Request, Request>();

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
      const retryableRequest = new Request(request, { credentials: "include" });
      retryableRequestClones.set(retryableRequest, retryableRequest.clone());
      return retryableRequest;
    },

    async onResponse({ response, request }) {
      // On a 401 from refresh-eligible endpoints: perform a single-flight token
      // refresh and retry the original request once with the new bearer token.
      // Primary auth endpoints are excluded to avoid refresh loops on login,
      // OTP redeem, token refresh, and logout. Authenticated auth endpoints such
      // as passkey enroll-handoff still refresh/retry when the bearer is stale.
      if (response.status !== 401 || shouldSkipAuthRefresh(request.url)) {
        return response;
      }

      let newToken: string;
      try {
        newToken = await singleFlightRefresh();
      } catch {
        // singleFlightRefresh already called onUnauthenticated(); just abort.
        return response;
      }

      // Retry the original request with the fresh token.
      const retrySource = retryableRequestClones.get(request) ?? request;
      const retryRequest = new Request(retrySource, {
        headers: (() => {
          const h = new Headers(retrySource.headers);
          h.set("Authorization", `Bearer ${newToken}`);
          return h;
        })(),
      });
      return fetch(retryRequest);
    },
  });

  return client;
}

export type ConsoleApiClient = ReturnType<typeof createConsoleApiClient>;
