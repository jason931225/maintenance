import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useRef, useState } from "react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  buildNonAuthoritativePolicyProjection,
  policyProjectionCanAuthorize,
  projectionHasElevatedHint,
} from "../auth/policyProjection";
import { singleFlightRefresh } from "../api/refresh";
import type { RefreshAuthority } from "../api/refresh";
import type { AcceptableTokens, AuthContextValue, TokenAcceptanceLease } from "./auth";
import { AuthProvider, useAuth } from "./auth";

type LeaseAwareAuth = AuthContextValue & {
  beginTokenAcceptance?: () => TokenAcceptanceLease | undefined;
  acceptTokens: (
    tokens: AcceptableTokens | undefined,
    lease?: TokenAcceptanceLease,
  ) => boolean | undefined;
};

function leaseAwareAuth(auth: AuthContextValue): LeaseAwareAuth {
  return auth as LeaseAwareAuth;
}

function acceptWithFreshLease(
  auth: AuthContextValue,
  tokens: AcceptableTokens | undefined,
): boolean | undefined {
  const leaseAware = leaseAwareAuth(auth);
  return leaseAware.acceptTokens(tokens, leaseAware.beginTokenAcceptance?.());
}

// A minimal access JWT (header.payload.signature) whose payload decodes to a
// `sub` claim, exercising the UI-gating claim decode without a real signature.
function fakeAccessToken(sub: string, signature = "sig"): string {
  const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub, roles: ["MECHANIC"] }));
  return `${header}.${payload}.${signature}`;
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

function GroupRolesProbe() {
  const { session, restoring } = useAuth();
  if (restoring) return <div data-testid="group-roles">restoring</div>;
  return (
    <div data-testid="group-roles">
      {(session?.group_roles ?? []).join(",") || "-"}
    </div>
  );
}

function FeatureGrantsProbe() {
  const { session, restoring } = useAuth();
  if (restoring) return <div data-testid="feature-grants">restoring</div>;
  return (
    <div data-testid="feature-grants">
      {(session?.feature_grants ?? []).join(",") || "-"}
    </div>
  );
}

function PolicyProjectionProbe() {
  const { session, restoring } = useAuth();
  if (restoring) return <div data-testid="policy-projection">restoring</div>;
  const projection = buildNonAuthoritativePolicyProjection({
    feature_grants: session?.feature_grants,
    policy_projection: session?.policy_projection,
  });
  return (
    <div data-testid="policy-projection">
      {[
        projection?.authority ?? "-",
        `stale:${String(projection?.stale ?? false)}`,
        `elevated:${String(
          projectionHasElevatedHint(projection, "role_manage"),
        )}`,
        `authorize:${String(
          policyProjectionCanAuthorize(projection, "role_manage"),
        )}`,
      ].join("|")}
    </div>
  );
}

function PasskeySetupProbe() {
  const { session, restoring } = useAuth();
  if (restoring) return <div data-testid="passkey-setup">restoring</div>;
  return (
    <div data-testid="passkey-setup">
      {`setup:${String(session?.requires_passkey_setup ?? false)}`}
    </div>
  );
}

function AcceptTokensProbe({ accessToken }: { accessToken: string }) {
  const auth = useAuth();
  const { session, restoring } = auth;
  return (
    <div>
      <div data-testid="state">
        {restoring
          ? "restoring"
          : session
            ? `auth:${session.access_token}`
            : "anon"}
      </div>
      <button
        type="button"
        onClick={() => {
          acceptWithFreshLease(auth, {
            access_token: accessToken,
            requires_passkey_setup: false,
          });
        }}
      >
        accept
      </button>
    </div>
  );
}

function SessionIncarnationProbe({
  firstToken,
  secondToken,
  viewAsToken,
}: {
  firstToken: string;
  secondToken: string;
  viewAsToken?: string;
}) {
  const auth = useAuth();
  const {
    session,
    restoring,
    login,
    logout,
    refresh,
    enterViewAs,
    exitViewAs,
  } = auth;
  return (
    <div>
      <div data-testid="incarnation">
        {restoring
          ? "restoring"
          : session?.client_session_incarnation ?? "none"}
      </div>
      <button
        type="button"
        onClick={() => {
          acceptWithFreshLease(auth, { access_token: firstToken });
        }}
      >
        accept-first
      </button>
      <button
        type="button"
        onClick={() => {
          acceptWithFreshLease(auth, { access_token: secondToken });
        }}
      >
        accept-second
      </button>
      <button
        type="button"
        onClick={() => {
          acceptWithFreshLease(auth, undefined);
        }}
      >
        clear-session
      </button>
      <button
        type="button"
        onClick={() => {
          void login();
        }}
      >
        login
      </button>
      <button
        type="button"
        onClick={() => {
          void refresh().catch(() => undefined);
        }}
      >
        refresh
      </button>
      <button
        type="button"
        onClick={() => {
          void logout();
        }}
      >
        logout
      </button>
      {viewAsToken ? (
        <button
          type="button"
          onClick={() => {
            enterViewAs({
              token: viewAsToken,
              actingOrgId: "tenant-a",
              actingOrgName: "Tenant A",
              actingRole: "ADMIN",
            });
          }}
        >
          enter-view-as
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => {
          exitViewAs();
        }}
      >
        exit-view-as
      </button>
    </div>
  );
}

function currentIncarnation(): string {
  return screen.getByTestId("incarnation").textContent;
}

function renderProvider() {
  return render(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>,
  );
}

describe("AuthProvider boot silent refresh", () => {
  it("session incarnation is created on boot and preserved by a proven refresh", async () => {
    const user = userEvent.setup();
    const first = fakeAccessToken(
      "00000000-0000-4000-8000-000000000001",
      "first",
    );
    const second = fakeAccessToken(
      "00000000-0000-4000-8000-000000000001",
      "second",
    );
    let refreshCalls = 0;
    server.use(
      http.post("*/api/v1/auth/token/refresh", () => {
        refreshCalls += 1;
        return HttpResponse.json({
          access_token: refreshCalls === 1 ? first : second,
          refresh_token: null,
          token_type: "Bearer",
          refresh_expires_at: "2026-06-19T00:00:00Z",
        });
      }),
    );

    render(
      <AuthProvider>
        <SessionIncarnationProbe firstToken={first} secondToken={second} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(currentIncarnation()).not.toBe("restoring");
      expect(currentIncarnation()).not.toBe("none");
    });
    const established = currentIncarnation();

    await user.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => {
      expect(refreshCalls).toBe(2);
    });
    expect(currentIncarnation()).toBe(established);
  });

  it("session incarnation changes on explicit acceptance replacement and clears on failure", async () => {
    const user = userEvent.setup();
    const first = fakeAccessToken(
      "00000000-0000-4000-8000-000000000001",
      "first",
    );
    const second = fakeAccessToken(
      "00000000-0000-4000-8000-000000000001",
      "second",
    );
    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    render(
      <AuthProvider>
        <SessionIncarnationProbe firstToken={first} secondToken={second} />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(currentIncarnation()).toBe("none");
    });

    await user.click(screen.getByRole("button", { name: "accept-first" }));
    const firstIncarnation = currentIncarnation();
    expect(firstIncarnation).not.toBe("none");

    await user.click(screen.getByRole("button", { name: "accept-second" }));
    const secondIncarnation = currentIncarnation();
    expect(secondIncarnation).not.toBe(firstIncarnation);

    await user.click(screen.getByRole("button", { name: "accept-first" }));
    expect(currentIncarnation()).not.toBe(firstIncarnation);
    expect(currentIncarnation()).not.toBe(secondIncarnation);

    await user.click(screen.getByRole("button", { name: "clear-session" }));
    expect(currentIncarnation()).toBe("none");
  });

  it("session incarnation is created by direct passkey login and cleared by logout", async () => {
    const user = userEvent.setup();
    const access = fakeAccessToken(
      "00000000-0000-4000-8000-000000000001",
      "login",
    );
    class FakeAuthenticatorAssertionResponse {
      authenticatorData = Uint8Array.from([1]).buffer;
      clientDataJSON = Uint8Array.from([2]).buffer;
      signature = Uint8Array.from([3]).buffer;
      userHandle = Uint8Array.from([4]).buffer;
    }
    class FakePublicKeyCredential {
      id = "credential-1";
      type = "public-key";
      rawId = Uint8Array.from([5]).buffer;
      response = new FakeAuthenticatorAssertionResponse();
    }
    vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
    vi.stubGlobal(
      "AuthenticatorAssertionResponse",
      FakeAuthenticatorAssertionResponse,
    );
    vi.stubGlobal("AuthenticatorAttestationResponse", class {});
    vi.stubGlobal("navigator", {
      credentials: {
        get: vi.fn().mockResolvedValue(new FakePublicKeyCredential()),
        create: vi.fn(),
      },
    });
    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
      http.post("*/api/v1/auth/passkey/login/start", () =>
        HttpResponse.json({
          ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          challenge: { challenge: "AQID", allowCredentials: [] },
          expires_at: "2026-06-14T00:00:00Z",
        }),
      ),
      http.post("*/api/v1/auth/passkey/login/finish", () =>
        HttpResponse.json({
          access_token: access,
          refresh_token: null,
          token_type: "Bearer",
          refresh_expires_at: "2026-06-19T00:00:00Z",
        }),
      ),
      http.post(
        "*/api/v1/auth/logout",
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    render(
      <AuthProvider>
        <SessionIncarnationProbe firstToken={access} secondToken={access} />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(currentIncarnation()).toBe("none");
    });

    await user.click(screen.getByRole("button", { name: "login" }));
    await waitFor(() => {
      expect(currentIncarnation()).not.toBe("none");
    });

    await user.click(screen.getByRole("button", { name: "logout" }));
    await waitFor(() => {
      expect(currentIncarnation()).toBe("none");
    });
  });

  it("session incarnation clears when a proven refresh fails", async () => {
    const access = fakeAccessToken(
      "00000000-0000-4000-8000-000000000001",
      "boot",
    );
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
        <SessionIncarnationProbe firstToken={access} secondToken={access} />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(currentIncarnation()).not.toBe("none");
    });

    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    await userEvent.setup().click(
      screen.getByRole("button", { name: "refresh" }),
    );
    await waitFor(() => {
      expect(currentIncarnation()).toBe("none");
    });
  });

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

  it("lets an explicit token accept finish restoring while boot refresh is still pending", async () => {
    const user = userEvent.setup();
    const access = fakeAccessToken("00000000-0000-4000-8000-000000000001");
    let resolveRefresh!: () => void;
    const pendingRefresh = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    server.use(
      http.post("*/api/v1/auth/token/refresh", async () => {
        await pendingRefresh;
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }),
    );

    render(
      <AuthProvider>
        <AcceptTokensProbe accessToken={access} />
      </AuthProvider>,
    );

    expect(screen.getByTestId("state")).toHaveTextContent("restoring");
    await user.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveTextContent(`auth:${access}`);
    });
    resolveRefresh();
  });

  it("preserves a zero-passkey setup requirement returned by silent refresh", async () => {
    const access = fakeAccessToken("00000000-0000-4000-8000-000000000001");
    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({
          access_token: access,
          refresh_token: null,
          token_type: "Bearer",
          refresh_expires_at: "2026-06-19T00:00:00Z",
          requires_passkey_setup: true,
        }),
      ),
    );

    render(
      <AuthProvider>
        <PasskeySetupProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("passkey-setup")).toHaveTextContent(
        "setup:true",
      );
    });
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

  it("decodes runtime-effective feature grants into the session for custom-role UI gating", async () => {
    const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
    const payload = btoa(
      JSON.stringify({
        sub: "00000000-0000-4000-8000-000000000001",
        roles: ["MEMBER"],
        feature_grants: ["mail_use", "role_manage"],
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
        <FeatureGrantsProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("feature-grants")).toHaveTextContent(
        "mail_use,role_manage",
      );
    });
  });



  it("decodes Cedar policy projection as advisory-only session data", async () => {
    const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
    const payload = btoa(
      JSON.stringify({
        sub: "00000000-0000-4000-8000-000000000001",
        roles: ["MEMBER"],
        feature_grants: ["mail_use", "role_manage"],
        policy_projection: {
          policy_version: "old",
          subject_version: "old",
          engine_mode: "cedar_shadow_legacy_enforce",
          stale: true,
          feature_grants: ["role_manage"],
          elevated_decisions: ["role_manage"],
        },
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
        <PolicyProjectionProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("policy-projection")).toHaveTextContent(
        "advisory_ui_only|stale:true|elevated:true|authorize:false",
      );
    });
  });

  it("decodes group roles into the session for group-admin UI gating", async () => {
    const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
    const payload = btoa(
      JSON.stringify({
        sub: "00000000-0000-4000-8000-000000000001",
        roles: ["MEMBER"],
        group_roles: ["GROUP_ADMIN"],
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
        <GroupRolesProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("group-roles")).toHaveTextContent(
        "GROUP_ADMIN",
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

function SourceAuthorityProbe({
  sourceToken,
  viewToken,
}: {
  sourceToken: string;
  viewToken: string;
}) {
  const auth = useAuth();
  const ports = auth as typeof auth & {
    refreshAuthority?: RefreshAuthority;
    sourceRefreshAuthority?: RefreshAuthority;
  };
  const capturedSource = useRef<RefreshAuthority | undefined>(undefined);
  const [refreshResult, setRefreshResult] = useState("idle");
  return (
    <div>
      <div data-testid="refresh-ports">
        {`${ports.refreshAuthority ? "present" : "none"}|${
          ports.refreshAuthority === ports.sourceRefreshAuthority ? "same" : "distinct"
        }`}
      </div>
      <div data-testid="source-refresh-result">{refreshResult}</div>
      <button
        type="button"
        onClick={() => {
          acceptWithFreshLease(auth, { access_token: sourceToken });
        }}
      >
        source-accept
      </button>
      <button
        type="button"
        onClick={() => {
          capturedSource.current = ports.sourceRefreshAuthority;
          auth.enterViewAs({
            token: viewToken,
            actingOrgId: "source-authority-org",
            actingOrgName: "Source Authority Org",
            actingRole: "ADMIN",
          });
        }}
      >
        source-enter
      </button>
      <button
        type="button"
        onClick={() => {
          auth.exitViewAs();
          void singleFlightRefresh(capturedSource.current).then(
            (token) => {
              setRefreshResult(token);
            },
            () => {
              setRefreshResult("rejected");
            },
          );
        }}
      >
        source-exit-refresh
      </button>
    </div>
  );
}

describe("AuthProvider view-as (read-only impersonation)", () => {
  it("exposes distinct effective/source authority ports and synchronously rebinds source on exit", async () => {
    const user = userEvent.setup();
    const sourceToken = fakePlatformToken("source-authority");
    const freshSourceToken = fakePlatformToken("fresh-source-authority");
    const viewToken = fakeViewAsToken("source-authority", "ADMIN");
    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    render(
      <AuthProvider>
        <SourceAuthorityProbe sourceToken={sourceToken} viewToken={viewToken} />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("refresh-ports")).toHaveTextContent("none|same");
    });

    await user.click(screen.getByRole("button", { name: "source-accept" }));
    await waitFor(() => {
      expect(screen.getByTestId("refresh-ports")).toHaveTextContent("present|same");
    });
    await user.click(screen.getByRole("button", { name: "source-enter" }));
    await waitFor(() => {
      expect(screen.getByTestId("refresh-ports")).toHaveTextContent("present|distinct");
    });

    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ access_token: freshSourceToken }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "source-exit-refresh" }));
    await waitFor(() => {
      expect(screen.getByTestId("source-refresh-result")).toHaveTextContent(freshSourceToken);
    });
  });

  it("session incarnation changes on view-as entry and restores the source incarnation on exit", async () => {
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
        <SessionIncarnationProbe
          firstToken={platformToken}
          secondToken={platformToken}
          viewAsToken={viewAsToken}
        />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(currentIncarnation()).not.toBe("restoring");
      expect(currentIncarnation()).not.toBe("none");
    });
    const sourceIncarnation = currentIncarnation();

    await user.click(screen.getByRole("button", { name: "enter-view-as" }));
    const viewAsIncarnation = currentIncarnation();
    expect(viewAsIncarnation).not.toBe(sourceIncarnation);
    expect(viewAsIncarnation).not.toBe("none");

    await user.click(screen.getByRole("button", { name: "exit-view-as" }));
    expect(currentIncarnation()).toBe(sourceIncarnation);
  });

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


function AuthorityTransitionProbe({
  tokenA,
  tokenB,
  viewToken,
}: {
  tokenA: string;
  tokenB: string;
  viewToken: string;
}) {
  const auth = useAuth();
  const retainedEnter = useRef<typeof auth.enterViewAs | undefined>(undefined);
  const retainedExit = useRef<typeof auth.exitViewAs | undefined>(undefined);
  return (
    <div>
      <div data-testid="authority-state">
        {auth.restoring
          ? "restoring"
          : [
              auth.session?.access_token ?? "anon",
              auth.session?.client_session_incarnation ?? "none",
              auth.viewAs?.platformSession.access_token ?? "no-source",
            ].join("|")}
      </div>
      <button type="button" onClick={() => { acceptWithFreshLease(auth, { access_token: tokenA }); }}>
        authority-accept-a
      </button>
      <button type="button" onClick={() => { acceptWithFreshLease(auth, { access_token: tokenB }); }}>
        authority-accept-b
      </button>
      <button type="button" onClick={() => { acceptWithFreshLease(auth, undefined); }}>
        authority-clear
      </button>
      <button type="button" onClick={() => { void auth.refresh().catch(() => undefined); }}>
        authority-refresh
      </button>
      <button type="button" onClick={() => { void auth.login().catch(() => undefined); }}>
        authority-login
      </button>
      <button type="button" onClick={() => { void auth.logout().catch(() => undefined); }}>
        authority-logout
      </button>
      <button type="button" onClick={() => { retainedEnter.current = auth.enterViewAs; }}>
        capture-enter
      </button>
      <button
        type="button"
        onClick={() => {
          retainedEnter.current?.({
            token: viewToken,
            actingOrgId: "tenant-view",
            actingOrgName: "Tenant View",
            actingRole: "ADMIN",
          });
        }}
      >
        invoke-enter
      </button>
      <button
        type="button"
        onClick={() => {
          auth.enterViewAs({
            token: viewToken,
            actingOrgId: "tenant-view",
            actingOrgName: "Tenant View",
            actingRole: "ADMIN",
          });
        }}
      >
        enter-current
      </button>
      <button type="button" onClick={() => { retainedExit.current = auth.exitViewAs; }}>
        capture-exit
      </button>
      <button type="button" onClick={() => { retainedExit.current?.(); }}>
        invoke-exit
      </button>
    </div>
  );
}

function installPasskeyTestPlatform() {
  class FakeAuthenticatorAssertionResponse {
    authenticatorData = Uint8Array.from([1]).buffer;
    clientDataJSON = Uint8Array.from([2]).buffer;
    signature = Uint8Array.from([3]).buffer;
    userHandle = Uint8Array.from([4]).buffer;
  }
  class FakePublicKeyCredential {
    id = "credential-race";
    type = "public-key";
    rawId = Uint8Array.from([5]).buffer;
    response = new FakeAuthenticatorAssertionResponse();
  }
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
  vi.stubGlobal("AuthenticatorAssertionResponse", FakeAuthenticatorAssertionResponse);
  vi.stubGlobal("AuthenticatorAttestationResponse", class {});
  vi.stubGlobal("navigator", {
    credentials: {
      get: vi.fn().mockResolvedValue(new FakePublicKeyCredential()),
      create: vi.fn(),
    },
  });
}

async function renderAuthorityTransitionProbe(
  tokenA: string,
  tokenB: string,
  viewToken: string,
) {
  server.use(
    http.post("*/api/v1/auth/token/refresh", () =>
      HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
    ),
  );
  render(
    <AuthProvider>
      <AuthorityTransitionProbe
        tokenA={tokenA}
        tokenB={tokenB}
        viewToken={viewToken}
      />
    </AuthProvider>,
  );
  await waitFor(() => {
    expect(screen.getByTestId("authority-state")).toHaveTextContent("anon|none");
  });
  return userEvent.setup();
}

function RootIsolationProbe({
  label,
  token,
}: {
  label: string;
  token: string;
}) {
  const auth = useAuth();
  const { api, session } = auth;
  const [requestStatus, setRequestStatus] = useState("idle");
  return (
    <div>
      <div data-testid={`${label}-root-state`}>
        {`${session?.access_token ?? "anon"}|${requestStatus}`}
      </div>
      <button
        type="button"
        onClick={() => {
          acceptWithFreshLease(auth, { access_token: token });
        }}
      >
        {`${label}-accept`}
      </button>
      <button
        type="button"
        onClick={() => {
          void api
            .GET("/api/v1/users", {
              params: { query: { include_inactive: false } },
            })
            .then(({ response }) => {
              setRequestStatus(String(response.status));
            });
        }}
      >
        {`${label}-request`}
      </button>
    </div>
  );
}

describe("AuthProvider authority transition fencing", () => {
  it("keeps two simultaneously mounted provider roots refresh-independent", async () => {
    const initialA = fakeAccessToken("root-a", "initial-a");
    const initialB = fakeAccessToken("root-b", "initial-b");
    const refreshedA = fakeAccessToken("root-a", "refreshed-a");
    const refreshedB = fakeAccessToken("root-b", "refreshed-b");
    let refreshCalls = 0;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
      http.get("*/api/v1/users", ({ request }) => {
        const bearer = request.headers.get("authorization");
        return bearer === `Bearer ${refreshedA}` ||
          bearer === `Bearer ${refreshedB}`
          ? HttpResponse.json([])
          : HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }),
    );

    render(
      <>
        <AuthProvider>
          <RootIsolationProbe label="root-a" token={initialA} />
        </AuthProvider>
        <AuthProvider>
          <RootIsolationProbe label="root-b" token={initialB} />
        </AuthProvider>
      </>,
    );
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId("root-a-root-state")).toHaveTextContent("anon");
      expect(screen.getByTestId("root-b-root-state")).toHaveTextContent("anon");
    });
    server.use(
      http.post("*/api/v1/auth/token/refresh", async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          markFirstStarted();
          await firstBarrier;
          return HttpResponse.json({ access_token: refreshedA });
        }
        markSecondStarted();
        return HttpResponse.json({ access_token: refreshedB });
      }),
    );
    await user.click(screen.getByRole("button", { name: "root-a-accept" }));
    await user.click(screen.getByRole("button", { name: "root-b-accept" }));

    await user.click(screen.getByRole("button", { name: "root-a-request" }));
    await firstStarted;
    await user.click(screen.getByRole("button", { name: "root-b-request" }));
    await secondStarted;
    releaseFirst();

    await waitFor(() => {
      expect(screen.getByTestId("root-a-root-state")).toHaveTextContent(
        `${refreshedA}|200`,
      );
      expect(screen.getByTestId("root-b-root-state")).toHaveTextContent(
        `${refreshedB}|200`,
      );
    });
    expect(refreshCalls).toBe(2);
  });

  it.each([
    ["different claims", fakeAccessToken("user-a", "a"), fakeAccessToken("user-b", "b")],
    ["equal claims", fakeAccessToken("user-a", "a"), fakeAccessToken("user-a", "b")],
  ])(
    "discards delayed public refresh A success after explicit B acceptance (%s)",
    async (_label, tokenA, tokenB) => {
      const refreshedA = fakeAccessToken("user-a", "refreshed-a");
      const user = await renderAuthorityTransitionProbe(
        tokenA,
        tokenB,
        fakeViewAsToken("user-a", "ADMIN"),
      );
      await user.click(screen.getByRole("button", { name: "authority-accept-a" }));

      let releaseRefresh!: () => void;
      const refreshBarrier = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      let refreshStarted!: () => void;
      const refreshStartedPromise = new Promise<void>((resolve) => {
        refreshStarted = resolve;
      });
      server.use(
        http.post("*/api/v1/auth/token/refresh", async () => {
          refreshStarted();
          await refreshBarrier;
          return HttpResponse.json({
            access_token: refreshedA,
            refresh_token: null,
            token_type: "Bearer",
            refresh_expires_at: "2099-01-01T00:00:00Z",
          });
        }),
      );

      await user.click(screen.getByRole("button", { name: "authority-refresh" }));
      await refreshStartedPromise;
      await user.click(screen.getByRole("button", { name: "authority-accept-b" }));
      releaseRefresh();

      await waitFor(() => {
        expect(screen.getByTestId("authority-state")).toHaveTextContent(tokenB);
      });
      expect(screen.getByTestId("authority-state")).not.toHaveTextContent(refreshedA);
    },
  );

  it("keeps a delayed login from overwriting a later accepted session", async () => {
    const tokenA = fakeAccessToken("login-a", "a");
    const tokenB = fakeAccessToken("accepted-b", "b");
    const user = await renderAuthorityTransitionProbe(
      tokenA,
      tokenB,
      fakeViewAsToken("login-a", "ADMIN"),
    );
    installPasskeyTestPlatform();

    let finishStarted!: () => void;
    const finishStartedPromise = new Promise<void>((resolve) => {
      finishStarted = resolve;
    });
    let releaseFinish!: () => void;
    const finishBarrier = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    server.use(
      http.post("*/api/v1/auth/passkey/login/start", () =>
        HttpResponse.json({
          ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          challenge: { challenge: "AQID", allowCredentials: [] },
          expires_at: "2099-01-01T00:00:00Z",
        }),
      ),
      http.post("*/api/v1/auth/passkey/login/finish", async () => {
        finishStarted();
        await finishBarrier;
        return HttpResponse.json({
          access_token: tokenA,
          refresh_token: null,
          token_type: "Bearer",
          refresh_expires_at: "2099-01-01T00:00:00Z",
        });
      }),
    );

    await user.click(screen.getByRole("button", { name: "authority-login" }));
    await finishStartedPromise;
    await user.click(screen.getByRole("button", { name: "authority-accept-b" }));
    releaseFinish();

    await waitFor(() => {
      expect(screen.getByTestId("authority-state")).toHaveTextContent(tokenB);
    });
    expect(screen.getByTestId("authority-state")).not.toHaveTextContent(tokenA);
  });

  it("rejects a retained view-as enter closure after A is replaced by B", async () => {
    const tokenA = fakePlatformToken("operator-a");
    const tokenB = fakePlatformToken("operator-b");
    const viewToken = fakeViewAsToken("operator-a", "ADMIN");
    const user = await renderAuthorityTransitionProbe(tokenA, tokenB, viewToken);

    await user.click(screen.getByRole("button", { name: "authority-accept-a" }));
    await user.click(screen.getByRole("button", { name: "capture-enter" }));
    await user.click(screen.getByRole("button", { name: "authority-accept-b" }));
    await user.click(screen.getByRole("button", { name: "invoke-enter" }));

    expect(screen.getByTestId("authority-state")).toHaveTextContent(tokenB);
    expect(screen.getByTestId("authority-state")).not.toHaveTextContent(viewToken);
  });

  it("rejects a retained view-as exit closure after A is replaced by B", async () => {
    const tokenA = fakePlatformToken("operator-a");
    const tokenB = fakePlatformToken("operator-b");
    const viewToken = fakeViewAsToken("operator-a", "ADMIN");
    const user = await renderAuthorityTransitionProbe(tokenA, tokenB, viewToken);

    await user.click(screen.getByRole("button", { name: "authority-accept-a" }));
    await user.click(screen.getByRole("button", { name: "enter-current" }));
    expect(screen.getByTestId("authority-state")).toHaveTextContent(viewToken);
    await user.click(screen.getByRole("button", { name: "capture-exit" }));
    await user.click(screen.getByRole("button", { name: "authority-accept-b" }));
    await user.click(screen.getByRole("button", { name: "invoke-exit" }));

    expect(screen.getByTestId("authority-state")).toHaveTextContent(tokenB);
    expect(screen.getByTestId("authority-state")).not.toHaveTextContent(tokenA);
  });

  it("invalidates local authority before a delayed logout network call completes", async () => {
    const tokenA = fakeAccessToken("logout-a", "a");
    const tokenB = fakeAccessToken("logout-b", "b");
    const user = await renderAuthorityTransitionProbe(
      tokenA,
      tokenB,
      fakeViewAsToken("logout-a", "ADMIN"),
    );
    await user.click(screen.getByRole("button", { name: "authority-accept-a" }));

    let logoutStarted!: () => void;
    const logoutStartedPromise = new Promise<void>((resolve) => {
      logoutStarted = resolve;
    });
    let releaseLogout!: () => void;
    const logoutBarrier = new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });
    server.use(
      http.post("*/api/v1/auth/logout", async () => {
        logoutStarted();
        await logoutBarrier;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await user.click(screen.getByRole("button", { name: "authority-logout" }));
    await logoutStartedPromise;
    expect(screen.getByTestId("authority-state")).toHaveTextContent("anon|none");
    releaseLogout();
  });
});

function LeaseCaptureProbe({
  label,
  onRender,
}: {
  label: string;
  onRender: (auth: LeaseAwareAuth) => void;
}) {
  const auth = leaseAwareAuth(useAuth());
  onRender(auth);
  return (
    <output data-testid={`${label}-lease-state`}>
      {auth.restoring
        ? "restoring"
        : `${auth.session?.access_token ?? "anon"}|${
            auth.session?.client_session_incarnation ?? "none"
          }|${auth.viewAs?.actingOrgId ?? "no-view"}`}
    </output>
  );
}

function rejectBootRefresh() {
  server.use(
    http.post("*/api/v1/auth/token/refresh", () =>
      HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
    ),
  );
}

describe("AuthProvider opaque one-use token acceptance leases", () => {
  it("fences delayed A after accepted B across equal-claim A-to-B-to-A transitions", async () => {
    rejectBootRefresh();
    let auth!: LeaseAwareAuth;
    const tokenA = fakeAccessToken("same-user", "a");
    const tokenB = fakeAccessToken("same-user", "b");
    render(
      <AuthProvider>
        <LeaseCaptureProbe label="equal" onRender={(value) => { auth = value; }} />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("equal-lease-state")).toHaveTextContent("anon|none");
    });

    expect(auth.beginTokenAcceptance).toEqual(expect.any(Function));
    const delayedA = auth.beginTokenAcceptance?.();
    const leaseB = auth.beginTokenAcceptance?.();
    expect(delayedA).toBeDefined();
    expect(leaseB).toBeDefined();
    let acceptedB: boolean | undefined;
    act(() => {
      acceptedB = auth.acceptTokens({ access_token: tokenB }, leaseB);
    });
    expect(acceptedB).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId("equal-lease-state")).toHaveTextContent(tokenB);
    });
    const incarnationB = screen.getByTestId("equal-lease-state").textContent.split("|")[1];

    let staleA: boolean | undefined;
    act(() => {
      staleA = auth.acceptTokens({ access_token: tokenA }, delayedA);
    });
    expect(staleA).toBe(false);
    expect(screen.getByTestId("equal-lease-state")).toHaveTextContent(`${tokenB}|${incarnationB}`);

    const returnToA = auth.beginTokenAcceptance?.();
    act(() => {
      expect(auth.acceptTokens({ access_token: tokenA }, returnToA)).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId("equal-lease-state")).toHaveTextContent(tokenA);
    });
    expect(screen.getByTestId("equal-lease-state").textContent.split("|")[1]).not.toBe(incarnationB);
    expect(auth.acceptTokens({ access_token: tokenB }, leaseB)).toBe(false);
  });

  it("freezes leases and rejects replay, missing, forged, copied, expired, and unsafe-mutated values", async () => {
    rejectBootRefresh();
    let auth!: LeaseAwareAuth;
    const token = fakeAccessToken("lease-hostile", "one");
    render(
      <AuthProvider>
        <LeaseCaptureProbe label="hostile" onRender={(value) => { auth = value; }} />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("hostile-lease-state")).toHaveTextContent("anon|none");
    });

    const lease = auth.beginTokenAcceptance?.();
    expect(lease).toBeDefined();
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Reflect.ownKeys(lease as object)).toEqual([]);
    expect(() => {
      (lease as unknown as Record<string, unknown>).generation = 1;
    }).toThrow(TypeError);
    expect(auth.acceptTokens({ access_token: token }, undefined)).toBe(false);
    expect(auth.acceptTokens({ access_token: token }, {} as TokenAcceptanceLease)).toBe(false);
    expect(
      auth.acceptTokens(
        { access_token: token },
        Object.assign({}, lease),
      ),
    ).toBe(false);
    act(() => {
      expect(auth.acceptTokens({ access_token: token }, lease)).toBe(true);
    });
    expect(auth.acceptTokens({ access_token: token }, lease)).toBe(false);

    const expired = auth.beginTokenAcceptance?.();
    expect(auth.beginTokenAcceptance?.()).toBeDefined();
    expect(auth.acceptTokens({ access_token: token }, expired)).toBe(false);
  });

  it("rejects wrong-provider, two-root, unmounted-provider, and retained-render leases", async () => {
    rejectBootRefresh();
    let authA!: LeaseAwareAuth;
    let authB!: LeaseAwareAuth;
    const view = render(
      <StrictMode>
        <AuthProvider>
          <LeaseCaptureProbe label="root-a-lease" onRender={(value) => { authA = value; }} />
        </AuthProvider>
        <AuthProvider>
          <LeaseCaptureProbe label="root-b-lease" onRender={(value) => { authB = value; }} />
        </AuthProvider>
      </StrictMode>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("root-a-lease-lease-state")).toHaveTextContent("anon|none");
      expect(screen.getByTestId("root-b-lease-lease-state")).toHaveTextContent("anon|none");
    });

    const tokenA = fakeAccessToken("root-a-lease", "a");
    const leaseA = authA.beginTokenAcceptance?.();
    expect(authB.acceptTokens({ access_token: tokenA }, leaseA)).toBe(false);
    const retainedBegin = authA.beginTokenAcceptance;
    expect(authA.acceptTokens({ access_token: tokenA }, leaseA)).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId("root-a-lease-lease-state")).toHaveTextContent(tokenA);
    });
    expect(retainedBegin?.()).toBeUndefined();

    const leaseAfterRender = authA.beginTokenAcceptance?.();
    const retainedAccept = authA.acceptTokens;
    view.unmount();
    expect(retainedAccept({ access_token: tokenA }, leaseAfterRender)).toBe(false);
  });

  it("invalidates outstanding leases synchronously on refresh, logout, and view transitions", async () => {
    rejectBootRefresh();
    let auth!: LeaseAwareAuth;
    const source = fakePlatformToken("lease-transition");
    const viewToken = fakeViewAsToken("lease-transition", "ADMIN");
    render(
      <AuthProvider>
        <LeaseCaptureProbe label="invalidate" onRender={(value) => { auth = value; }} />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("invalidate-lease-state")).toHaveTextContent("anon|none");
    });

    const refreshLease = auth.beginTokenAcceptance?.();
    await act(async () => {
      await auth.refresh();
    });
    expect(auth.acceptTokens({ access_token: source }, refreshLease)).toBe(false);

    const sourceLease = auth.beginTokenAcceptance?.();
    act(() => {
      expect(auth.acceptTokens({ access_token: source }, sourceLease)).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId("invalidate-lease-state")).toHaveTextContent(source);
    });
    const transitionLease = auth.beginTokenAcceptance?.();
    act(() => {
      expect(
        auth.enterViewAs({
          token: viewToken,
          actingOrgId: "org-a",
          actingOrgName: "Org A",
          actingRole: "ADMIN",
        }),
      ).toBe(true);
    });
    expect(auth.acceptTokens({ access_token: source }, transitionLease)).toBe(false);

    const logoutLease = auth.beginTokenAcceptance?.();
    await act(async () => {
      await auth.logout();
    });
    expect(auth.acceptTokens({ access_token: source }, logoutLease)).toBe(false);
  });
});

describe("AuthProvider atomic delegated authority replacement", () => {
  it("atomically replaces orgA with orgB and rejects rapid or retained stale commits", async () => {
    rejectBootRefresh();
    let auth!: LeaseAwareAuth;
    const source = fakePlatformToken("atomic-source");
    const orgA = fakeViewAsToken("atomic-source", "ADMIN");
    const orgB = fakeViewAsToken("atomic-source", "MANAGER");
    const orgC = fakeViewAsToken("atomic-source", "MECHANIC");
    render(
      <AuthProvider>
        <LeaseCaptureProbe label="atomic" onRender={(value) => { auth = value; }} />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("atomic-lease-state")).toHaveTextContent("anon|none");
    });
    act(() => {
      expect(acceptWithFreshLease(auth, { access_token: source })).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId("atomic-lease-state")).toHaveTextContent(source);
    });
    act(() => {
      expect(
        auth.enterViewAs({
          token: orgA,
          source: "GROUP_ADMIN",
          mode: "MANAGE",
          actingOrgId: "org-a",
          actingOrgName: "Org A",
          actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
        }),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId("atomic-lease-state")).toHaveTextContent(`${orgA}|`);
      expect(screen.getByTestId("atomic-lease-state")).toHaveTextContent("|org-a");
    });

    const retainedReplace = auth.enterViewAs;
    act(() => {
      expect(
        auth.enterViewAs({
          token: orgB,
          source: "GROUP_ADMIN",
          mode: "MANAGE",
          actingOrgId: "org-b",
          actingOrgName: "Org B",
          actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
        }),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId("atomic-lease-state")).toHaveTextContent(`${orgB}|`);
      expect(screen.getByTestId("atomic-lease-state")).toHaveTextContent("|org-b");
    });
    expect(
      retainedReplace({
        token: orgC,
        source: "GROUP_ADMIN",
        mode: "MANAGE",
        actingOrgId: "org-c",
        actingOrgName: "Org C",
        actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
      }),
    ).toBe(false);
    expect(screen.getByTestId("atomic-lease-state")).toHaveTextContent(`${orgB}|`);
    expect(screen.getByTestId("atomic-lease-state")).toHaveTextContent("|org-b");
  });
});
