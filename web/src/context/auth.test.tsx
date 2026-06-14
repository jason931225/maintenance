import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthProvider, useAuth } from "./auth";

// A minimal access JWT (header.payload.signature) whose payload decodes to a
// `sub` claim, exercising the UI-gating claim decode without a real signature.
function fakeAccessToken(sub: string): string {
  const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub, roles: ["MECHANIC"] }));
  return `${header}.${payload}.sig`;
}

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

/** Renders the access token (or a sentinel) so tests can observe auth state. */
function AuthProbe() {
  const { session, restoring } = useAuth();
  if (restoring) return <div data-testid="state">restoring</div>;
  return (
    <div data-testid="state">
      {session ? `auth:${session.access_token}` : "anon"}
    </div>
  );
}

function renderProvider() {
  return render(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>,
  );
}

describe("AuthProvider boot silent refresh", () => {
  it("recovers a session from the refresh cookie and never persists the refresh token", async () => {
    const access = fakeAccessToken("00000000-0000-4000-8000-000000000001");
    let sawRefreshTokenInBody: unknown = "unset";
    server.use(
      http.post("*/api/v1/auth/token/refresh", async ({ request }) => {
        // The web transport sends an EMPTY body; the refresh token rides in the
        // (test-invisible) HttpOnly cookie, never the JSON body.
        sawRefreshTokenInBody = ((await request.json()) as {
          refresh_token?: unknown;
        }).refresh_token;
        // Cookie transport: refresh token is null in the body of the response.
        return HttpResponse.json({
          access_token: access,
          refresh_token: null,
          token_type: "Bearer",
          refresh_expires_at: "2026-06-19T00:00:00Z",
        });
      }),
    );

    renderProvider();

    // While the boot refresh is in flight the provider reports `restoring`.
    expect(screen.getByTestId("state")).toHaveTextContent("restoring");

    // After it resolves, the session is authenticated with the fresh access token.
    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveTextContent(`auth:${access}`);
    });

    // The web client must NOT echo the refresh token in the request body.
    expect(sawRefreshTokenInBody).toBeUndefined();

    // Nothing token-related is written to web storage: the refresh token lives
    // only in the HttpOnly cookie, and the access token stays in memory.
    expect(sessionStorage.length).toBe(0);
    expect(
      JSON.stringify(Object.entries(localStorage)),
    ).not.toContain(access);
  });

  it("falls back to unauthenticated when the boot refresh returns 401", async () => {
    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveTextContent("anon");
    });
    expect(sessionStorage.length).toBe(0);
  });
});
