import { render, screen, type ReactElement } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { AuthSession } from "../../context/auth";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import { AttendanceScreenBody } from "./AttendanceConsoleRoute";

const screenSpy = vi.fn((props: { selfServicePanel?: ReactElement }) => (
  <div data-testid="attendance-screen">
    {props.selfServicePanel}
    <span data-testid="manager-workspace">manager workspace</span>
  </div>
));
const authzSpy = vi.fn(() => ({ allows: () => true }));
const managerTransportSpy = vi.fn(() => ({
  listSubstitutionCandidates: vi.fn(),
}));
const selfTransportSpy = vi.fn(() => ({
  listOwnExceptions: vi.fn(),
  getOwnWeek52: vi.fn(),
}));
const panelSpy = vi.fn(
  (props: { sessionIdentity: string | undefined; active: boolean }) => (
    <section
      data-testid="self-service"
      data-session={props.sessionIdentity}
      data-active={String(props.active)}
    />
  ),
);
const punchSpy = vi.fn(() => <section data-testid="punch-panel">punch</section>);

vi.mock("./AttendanceScreen", () => ({
  AttendanceScreen: (props: unknown) =>
    screenSpy(props as { selfServicePanel?: ReactElement }),
}));
vi.mock("./SelfServiceAttendancePanel", () => ({
  SelfServiceAttendancePanel: (props: {
    sessionIdentity: string | undefined;
    active: boolean;
  }) => panelSpy(props),
}));
vi.mock("./AttendancePunchPanel", () => ({
  AttendancePunchPanel: () => punchSpy(),
}));
vi.mock("./attendanceTransport", () => ({
  createAttendanceApiTransport: (...args: unknown[]) =>
    managerTransportSpy(...args),
}));
vi.mock("./selfServiceAttendanceTransport", () => ({
  createSelfServiceAttendanceTransport: (...args: unknown[]) =>
    selfTransportSpy(...args),
}));
vi.mock("./useAttendanceConsoleAuthz", () => ({
  useAttendanceConsoleAuthz: () => authzSpy(),
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AttendanceScreenBody", () => {
  it("renders self-service for a branchless member without manager authz, transport, selectors, or controls", () => {
    render(
      <AuthTestProvider session={session([])} overrides={{ api: client() }}>
        <AttendanceScreenBody />
      </AuthTestProvider>,
    );
    expect(screen.getByTestId("self-service")).toHaveAttribute(
      "data-session",
      "session-a",
    );
    expect(screen.queryByTestId("attendance-screen")).toBeNull();
    expect(authzSpy).not.toHaveBeenCalled();
    expect(managerTransportSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("manager-workspace")).toBeNull();
  });

  it("does not compose private attendance content or manager reads while inactive, then composes fresh on reactivation", () => {
    const api = client();
    const { rerender } = render(
      <AuthTestProvider session={session(["branch-a"])} overrides={{ api }}>
        <AttendanceScreenBody active={false} />
      </AuthTestProvider>,
    );
    expect(screen.queryByTestId("self-service")).toBeNull();
    expect(screen.queryByTestId("attendance-screen")).toBeNull();
    expect(panelSpy).not.toHaveBeenCalled();
    expect(authzSpy).not.toHaveBeenCalled();
    expect(managerTransportSpy).not.toHaveBeenCalled();

    rerender(
      <AuthTestProvider session={session(["branch-a"])} overrides={{ api }}>
        <AttendanceScreenBody active />
      </AuthTestProvider>,
    );
    expect(screen.getByTestId("self-service")).toBeVisible();
    expect(screen.getByTestId("attendance-screen")).toBeVisible();
    expect(authzSpy).toHaveBeenCalledTimes(1);
    expect(managerTransportSpy).toHaveBeenCalledWith(api, "branch-a");
  });

  it("places manager workspace before the personal punch and own panels for a branched manager", () => {
    const api = client();
    render(
      <AuthTestProvider session={session(["branch-a"])} overrides={{ api }}>
        <AttendanceScreenBody />
      </AuthTestProvider>,
    );
    expect(screen.getByTestId("attendance-screen")).toBeVisible();
    expect(authzSpy).toHaveBeenCalledTimes(1);
    expect(managerTransportSpy).toHaveBeenCalledWith(api, "branch-a");
    const managerWorkspace = screen.getByTestId("manager-workspace");
    expect(managerWorkspace.compareDocumentPosition(screen.getByTestId("punch-panel"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByTestId("punch-panel").compareDocumentPosition(screen.getByTestId("self-service"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("replaces and removes employee authority rather than retaining a previous panel session", () => {
    const api = client();
    const { rerender } = render(
      <AuthTestProvider session={session([], "one")} overrides={{ api }}>
        <AttendanceScreenBody />
      </AuthTestProvider>,
    );
    expect(screen.getByTestId("self-service")).toHaveAttribute(
      "data-session",
      "one",
    );
    rerender(
      <AuthTestProvider session={session([], "two")} overrides={{ api }}>
        <AttendanceScreenBody />
      </AuthTestProvider>,
    );
    expect(screen.getByTestId("self-service")).toHaveAttribute(
      "data-session",
      "two",
    );
    rerender(
      <AuthTestProvider session={undefined} overrides={{ api }}>
        <AttendanceScreenBody />
      </AuthTestProvider>,
    );
    expect(screen.getByTestId("self-service")).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(screen.getByTestId("self-service")).not.toHaveAttribute(
      "data-session",
    );
  });

  it("removes manager composition when the active branch is removed", () => {
    const api = client();
    const { rerender } = render(
      <AuthTestProvider session={session(["branch-a"])} overrides={{ api }}>
        <AttendanceScreenBody />
      </AuthTestProvider>,
    );
    expect(screen.getByTestId("attendance-screen")).toBeVisible();
    rerender(
      <AuthTestProvider session={session([])} overrides={{ api }}>
        <AttendanceScreenBody />
      </AuthTestProvider>,
    );
    expect(screen.queryByTestId("attendance-screen")).toBeNull();
    expect(screen.getByTestId("self-service")).toBeVisible();
  });
});
