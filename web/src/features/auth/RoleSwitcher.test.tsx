import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AuthContext } from "../../context/auth";
import type {
  AcceptableTokens,
  AuthContextValue,
  TokenAcceptanceLease,
} from "../../context/auth";
import { RoleSwitcher } from "./RoleSwitcher";
import { parseDevAuthAccessToken } from "./devAuthResponse";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function makeAuthContext(
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
  return {
    session: undefined,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => true,
    beginTokenAcceptance: () => Object.freeze({}) as TokenAcceptanceLease,
    clearPasskeySetup: () => {},
    api: {} as AuthContextValue["api"],
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    ...overrides,
  };
}

function renderSwitcher(ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <RoleSwitcher />
    </AuthContext.Provider>,
  );
}

describe("RoleSwitcher", () => {
  it("starts with the named KNL administrator preset instead of raw UUID fields", () => {
    renderSwitcher(makeAuthContext());

    expect(screen.getByText("KNL 로지스틱스")).toBeVisible();
    expect(screen.getByDisplayValue("관리자")).toBeVisible();
    expect(screen.getByDisplayValue("창원 본사")).toBeVisible();
    expect(screen.queryByLabelText("조직 ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/지점 ID/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "창원 본사 관리자 로그인" }),
    ).toBeVisible();
  });

  it("uses the selected named preset when minting the dev session", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/v1/dev-auth/session", async ({ request }) => {
        expect(await request.json()).toEqual({
          org_id: "00000000-0000-0000-0000-0000000000a1",
          role: "ADMIN",
          branch_ids: ["00000000-0000-0000-0000-0000000000c1"],
        });
        return HttpResponse.json({ access_token: "dev-auth-token" });
      }),
    );

    renderSwitcher(makeAuthContext());
    await user.click(
      screen.getByRole("button", { name: "창원 본사 관리자 로그인" }),
    );

    expect(
      await screen.findByRole("button", { name: "창원 본사 관리자 로그인" }),
    ).toBeEnabled();
  });

  it("keeps arbitrary UUID inputs behind an explicit advanced mode", async () => {
    const user = userEvent.setup();
    renderSwitcher(makeAuthContext());

    await user.click(screen.getByRole("button", { name: "고급 설정" }));

    expect(screen.getByLabelText("조직 ID")).toHaveValue(
      "00000000-0000-0000-0000-0000000000a1",
    );
    expect(screen.getByLabelText(/지점 ID/)).toHaveValue(
      "00000000-0000-0000-0000-0000000000c1",
    );
  });

  it("opens the named local panel by default", () => {
    renderSwitcher(makeAuthContext());
    expect(screen.getByText("KNL 로지스틱스")).toBeVisible();
    expect(screen.getByDisplayValue("관리자")).toBeVisible();
  });

  it("normalizes duplicate branch UUIDs and warns before an organization-wide login", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/v1/dev-auth/session", async ({ request }) => {
        expect(await request.json()).toEqual({
          org_id: "00000000-0000-0000-0000-0000000000a1",
          role: "ADMIN",
          branch_ids: [
            "00000000-0000-0000-0000-0000000000c1",
            "00000000-0000-0000-0000-0000000000c2",
          ],
        });
        return HttpResponse.json({ access_token: "dev-auth-token" });
      }),
    );
    renderSwitcher(makeAuthContext());
    await user.click(screen.getByRole("button", { name: "고급 설정" }));
    const branches = screen.getByLabelText(/지점 ID/);
    await user.clear(branches);
    expect(screen.getByRole("status")).toHaveTextContent("조직 전체 범위");
    await user.type(
      branches,
      "00000000-0000-0000-0000-0000000000C1, 00000000-0000-0000-0000-0000000000c1, 00000000-0000-0000-0000-0000000000C2",
    );
    await user.click(
      screen.getByRole("button", { name: "창원 본사 관리자 로그인" }),
    );
  });

  it("rejects malformed advanced UUID inputs before any request", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(window, "fetch");
    renderSwitcher(makeAuthContext());
    await user.click(screen.getByRole("button", { name: "고급 설정" }));
    await user.clear(screen.getByLabelText("조직 ID"));
    await user.type(screen.getByLabelText("조직 ID"), "not-a-uuid");
    await user.click(
      screen.getByRole("button", { name: "창원 본사 관리자 로그인" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("올바른 UUID");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("mints a session via dev-auth and hands the token to acceptTokens", async () => {
    const user = userEvent.setup();
    const acceptTokens = vi.fn();
    server.use(
      http.post("*/api/v1/dev-auth/session", () =>
        HttpResponse.json({ access_token: "dev-auth-token" }),
      ),
    );

    renderSwitcher(makeAuthContext({ acceptTokens }));

    await user.click(
      screen.getByRole("button", { name: "창원 본사 관리자 로그인" }),
    );

    expect(acceptTokens).toHaveBeenCalledWith(
      {
        access_token: "dev-auth-token",
        requires_passkey_setup: false,
      },
      expect.any(Object),
    );
  });

  it("shows an error and does not accept a session when the backend rejects the request", async () => {
    const user = userEvent.setup();
    const acceptTokens = vi.fn();
    server.use(
      http.post("*/api/v1/dev-auth/session", () =>
        HttpResponse.json({}, { status: 400 }),
      ),
    );

    renderSwitcher(makeAuthContext({ acceptTokens }));

    await user.click(
      screen.getByRole("button", { name: "창원 본사 관리자 로그인" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "선택한 조직, 역할 또는 지점을 확인하세요.",
    );
    expect(acceptTokens).not.toHaveBeenCalled();
  });

  it("treats malformed and tokenless successful responses as protocol errors", async () => {
    await expect(
      parseDevAuthAccessToken({
        json: async () => Promise.reject(new SyntaxError("invalid JSON")),
      }),
    ).rejects.toThrow("invalid JSON");
    await expect(
      parseDevAuthAccessToken({ json: () => Promise.resolve({}) }),
    ).resolves.toBeUndefined();
  });

  it("distinguishes route-absent, unknown-selection, validation, server, and network failures", async () => {
    const user = userEvent.setup();
    const cases = [
      [
        () => new HttpResponse(null, { status: 404 }),
        "dev-auth 백엔드가 실행 중이 아닙니다",
      ],
      [
        () => HttpResponse.json({ code: "not_found" }, { status: 404 }),
        "찾을 수 없습니다",
      ],
      [
        () => HttpResponse.json({}, { status: 422 }),
        "선택한 조직, 역할 또는 지점",
      ],
      [() => HttpResponse.json({}, { status: 500 }), "로컬 백엔드에서 오류"],
      [() => HttpResponse.error(), "로컬 백엔드에 연결할 수 없습니다"],
    ] as const;

    for (const [respond, expected] of cases) {
      server.use(http.post("*/api/v1/dev-auth/session", respond));
      const { unmount } = renderSwitcher(makeAuthContext());
      await user.click(
        screen.getByRole("button", { name: "창원 본사 관리자 로그인" }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(expected);
      unmount();
      server.resetHandlers();
    }
  });
});

describe("RoleSwitcher provider-owned acceptance lease fencing", () => {
  it("acquires before fetch and refuses a delayed A result after B is accepted", async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    let sequence = 0;
    let currentLease: TokenAcceptanceLease | undefined;
    let acceptedToken = "none";
    const beginTokenAcceptance = vi.fn(() => {
      events.push(`lease-${String(sequence + 1)}`);
      currentLease = Object.freeze({
        sequence: ++sequence,
      }) as unknown as TokenAcceptanceLease;
      return currentLease;
    });
    const acceptTokens = vi.fn(
      (tokens: AcceptableTokens | undefined, lease?: TokenAcceptanceLease) => {
        if (!lease || lease !== currentLease) return false;
        currentLease = undefined;
        acceptedToken = tokens?.access_token ?? "none";
        return true;
      },
    );
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let releaseRequest!: () => void;
    const requestBarrier = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    server.use(
      http.post("*/api/v1/dev-auth/session", async () => {
        events.push("request-start");
        markRequestStarted();
        await requestBarrier;
        events.push("request-resolve");
        return HttpResponse.json({ access_token: "delayed-role-a" });
      }),
    );

    renderSwitcher(makeAuthContext({ beginTokenAcceptance, acceptTokens }));
    await user.click(
      screen.getByRole("button", { name: "창원 본사 관리자 로그인" }),
    );
    await requestStarted;
    expect(events.indexOf("lease-1")).toBeLessThan(
      events.indexOf("request-start"),
    );

    const leaseB = beginTokenAcceptance();
    expect(acceptTokens({ access_token: "accepted-b" }, leaseB)).toBe(true);
    releaseRequest();
    await screen.findByRole("alert");
    expect(events).toContain("request-resolve");
    expect(acceptTokens).toHaveBeenCalledWith(
      { access_token: "delayed-role-a", requires_passkey_setup: false },
      expect.any(Object),
    );
    expect(acceptedToken).toBe("accepted-b");
  });
});
