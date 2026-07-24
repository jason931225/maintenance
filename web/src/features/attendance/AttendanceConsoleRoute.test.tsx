import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { AuthSession } from "../../context/auth";
import { attendanceStrings as text } from "../../i18n/attendance";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import { AttendanceScreenBody } from "./AttendanceConsoleRoute";

const screenSpy = vi.fn(() => <div data-testid="attendance-screen" />);
vi.mock("./AttendanceScreen", () => ({ AttendanceScreen: (props: unknown) => screenSpy(props) }));
vi.mock("./useAttendanceConsoleAuthz", () => ({
  useAttendanceConsoleAuthz: () => ({ allows: () => true }),
}));

function session(branches: string[], incarnation = "session-a"): AuthSession {
  return {
    access_token: "token",
    user_id: "user-a",
    org_id: "org-a",
    client_session_incarnation: incarnation,
    branches,
  };
}

function client(): ConsoleApiClient {
  return { GET: vi.fn(), POST: vi.fn() } as unknown as ConsoleApiClient;
}

describe("AttendanceScreenBody", () => {
  it("renders a truthful no-active-branch state and creates no adapter", () => {
    render(
      <AuthTestProvider session={session([])} overrides={{ api: client() }}>
        <AttendanceScreenBody />
      </AuthTestProvider>,
    );

    expect(screen.getByText(text.noBranch)).toBeVisible();
    expect(screen.queryByTestId("attendance-screen")).toBeNull();
  });

  it("binds the current session and active branch to a prop-less registry body", () => {
    const api = client();
    render(
      <AuthTestProvider session={session(["branch-a"])} overrides={{ api }}>
        <AttendanceScreenBody />
      </AuthTestProvider>,
    );

    expect(screen.getByTestId("attendance-screen")).toBeVisible();
    expect(screenSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        branchId: "branch-a",
        actorId: "user-a",
        sessionKey: "session-a",
      }),
    );
    const props = screenSpy.mock.calls.at(-1)?.[0] as { transport: { listSubstitutionCandidates: unknown } };
    expect(props.transport.listSubstitutionCandidates).toEqual(expect.any(Function));
  });

  it("rebinds to a replacement session rather than retaining the previous branch", () => {
    const api = client();
    const { rerender } = render(
      <AuthTestProvider session={session(["branch-a"], "one")} overrides={{ api }}>
        <AttendanceScreenBody />
      </AuthTestProvider>,
    );
    rerender(
      <AuthTestProvider session={session(["branch-b"], "two")} overrides={{ api }}>
        <AttendanceScreenBody />
      </AuthTestProvider>,
    );

    expect(screenSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ branchId: "branch-b", sessionKey: "two" }),
    );
  });
});
