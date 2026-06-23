import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/** A platform-tier token (the `platform` claim drives `isPlatform`). */
function fakePlatformToken(sub: string): string {
  const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({ sub, roles: ["SUPER_ADMIN"], platform: true }),
  );
  return `${header}.${payload}.sig`;
}

/** A view_as (impersonation) token: tenant-tier (`platform` false), acting role. */
function fakeViewAsToken(sub: string, role: string): string {
  const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({ sub, roles: [role], platform: false, view_as: true }),
  );
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

  it("decodes the display-name and email claims into the session", async () => {
    const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
    // The `name` claim is non-ASCII, so encode the payload as UTF-8 -> base64
    // exactly as the backend JWT serializer does (a bare btoa would throw).
    const utf8ToBase64 = (value: string) =>
      btoa(String.fromCharCode(...new TextEncoder().encode(value)));
    const payload = utf8ToBase64(
      JSON.stringify({
        sub: "00000000-0000-4000-8000-000000000001",
        roles: ["ADMIN"],
        name: "김관리",
        email: "admin@example.com",
      }),
    );
    const access = `${header}.${payload}.sig`;
    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({
          access_token: access,
          refresh_token: null,
          token_type: "Bearer",
          refresh_expires_at: "2026-06-19T00:00:00Z",
        }),
      ),
    );

    render(
      <AuthProvider>
        <IdentityProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("identity")).toHaveTextContent(
        "김관리|admin@example.com",
      );
    });
  });
});

/** Surfaces the decoded display-name + email claims for assertion. */
function IdentityProbe() {
  const { session, restoring } = useAuth();
  if (restoring) return <div data-testid="identity">restoring</div>;
  return (
    <div data-testid="identity">
      {`${session?.display_name ?? "-"}|${session?.email ?? "-"}`}
    </div>
  );
}

/**
 * A probe that surfaces the active session's platform flag + token plus buttons
 * to enter/exit view-as, so a test can drive the provider's impersonation state
 * machine through the real `AuthProvider`.
 */
function ViewAsProbe({ viewAsToken }: { viewAsToken: string }) {
  const { session, viewAs, enterViewAs, exitViewAs } = useAuth();
  if (!session) return <div data-testid="va">anon</div>;
  return (
    <div>
      <div data-testid="va">
        {`platform:${String(session.isPlatform ?? false)}`}
      </div>
      <div data-testid="token">{session.access_token}</div>
      <div data-testid="banner">{viewAs ? viewAs.actingOrgName : "none"}</div>
      <button
        type="button"
        onClick={() => {
          enterViewAs({
            token: viewAsToken,
            actingOrgId: "org-a",
            actingOrgName: "Acme Corporation",
            actingRole: "ADMIN",
          });
        }}
      >
        enter
      </button>
      <button
        type="button"
        onClick={() => {
          exitViewAs();
        }}
      >
        exit
      </button>
    </div>
  );
}

describe("AuthProvider view-as (read-only impersonation)", () => {
  it("switches into the tenant view on enter and restores the platform session on exit", async () => {
    const user = userEvent.setup();
    const platformToken = fakePlatformToken(
      "00000000-0000-4000-8000-000000000009",
    );
    const viewAsToken = fakeViewAsToken(
      "00000000-0000-4000-8000-000000000009",
      "ADMIN",
    );
    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({
          access_token: platformToken,
          refresh_token: null,
          token_type: "Bearer",
          refresh_expires_at: "2026-06-19T00:00:00Z",
        }),
      ),
    );

    render(
      <AuthProvider>
        <ViewAsProbe viewAsToken={viewAsToken} />
      </AuthProvider>,
    );

    // Boot recovers the operator's PLATFORM session.
    await waitFor(() => {
      expect(screen.getByTestId("va")).toHaveTextContent("platform:true");
    });
    expect(screen.getByTestId("banner")).toHaveTextContent("none");

    // Entering view-as switches the active session to the TENANT view (the
    // impersonation token has platform=false) and arms the banner context.
    await user.click(screen.getByRole("button", { name: "enter" }));
    await waitFor(() => {
      expect(screen.getByTestId("va")).toHaveTextContent("platform:false");
    });
    expect(screen.getByTestId("token")).toHaveTextContent(viewAsToken);
    expect(screen.getByTestId("banner")).toHaveTextContent("Acme Corporation");

    // Exiting restores the operator's platform session verbatim and clears the
    // impersonation context.
    await user.click(screen.getByRole("button", { name: "exit" }));
    await waitFor(() => {
      expect(screen.getByTestId("va")).toHaveTextContent("platform:true");
    });
    expect(screen.getByTestId("token")).toHaveTextContent(platformToken);
    expect(screen.getByTestId("banner")).toHaveTextContent("none");
  });
});
