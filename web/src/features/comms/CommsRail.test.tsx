import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { MessengerMessageSummary } from "../../api/types";
import type { AuthSession } from "../../context/auth";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import { ko } from "../../i18n/ko";
import { FEATURES } from "../../components/shell/nav";
import { CommsRail } from "./CommsRail";
import type { NotificationSummary } from "./notificationsApi";
import { useCommsStore } from "./store";

// The rail's runtime (fetches + realtime) is exercised in store/hub tests; here
// we keep it inert with a blank access token and drive the store directly.
const session: AuthSession = {
  access_token: "",
  user_id: "u1",
  roles: ["ADMIN"],
  branches: [],
  feature_grants: [FEATURES.MAIL_USE],
};

function stubApi(): ConsoleApiClient {
  const empty = () => Promise.resolve({ data: undefined, response: new Response() });
  return { GET: vi.fn(empty), POST: vi.fn(empty), PUT: vi.fn(empty), PATCH: vi.fn(empty) } as unknown as ConsoleApiClient;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

function renderRail(path = "/dispatch", api: ConsoleApiClient = stubApi()) {
  return render(
    <AuthTestProvider session={session} overrides={{ api }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
        <CommsRail />
      </MemoryRouter>
    </AuthTestProvider>,
  );
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
}

function notification(overrides: Partial<NotificationSummary> = {}): NotificationSummary {
  return {
    id: overrides.id ?? "n1",
    recipient_user_id: "u1",
    category: "결재",
    text: "결재 요청",
    link: overrides.link ?? { type: "screen", screen: "support" },
    unread: overrides.unread ?? true,
    created_at: "2026-07-08T00:00:00Z",
    read_at: null,
    ...overrides,
  };
}

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  useCommsStore.getState().reset();
  setViewport(1024); // default: auto-collapsed
});
afterEach(() => {
  setViewport(1024);
});

describe("CommsRail", () => {
  it("expands from the collapsed strip when a section icon is clicked", () => {
    renderRail();
    // Collapsed: no collapse control yet.
    expect(
      screen.queryByRole("button", { name: ko.shell.commsRail.collapse }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: ko.shell.commsRail.openSection.notifications }),
    );

    expect(
      screen.getByRole("button", { name: ko.shell.commsRail.collapse }),
    ).toBeVisible();
    expect(useCommsStore.getState().collapsedPref).toBe(false);
    expect(useCommsStore.getState().openSection).toBe("notifications");
  });

  it("switches the open accordion section", () => {
    setViewport(1400); // open by default
    renderRail();

    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(ko.shell.commsRail.sections.messenger) }),
    );
    expect(useCommsStore.getState().openSection).toBe("messenger");
    expect(screen.getByText(ko.shell.commsRail.empty.messenger)).toBeVisible();
  });

  it("hides the messenger section while the messenger page owns the screen", () => {
    setViewport(1400);
    renderRail("/messenger");
    expect(
      screen.queryByRole("button", { name: new RegExp(ko.shell.commsRail.sections.messenger) }),
    ).not.toBeInTheDocument();
    // Notifications section is always present.
    expect(
      screen.getByRole("button", { name: new RegExp(ko.shell.commsRail.sections.notifications) }),
    ).toBeVisible();
  });

  it("marks a notification read and navigates to its target on click", () => {
    setViewport(1400);
    renderRail();
    // Seed AFTER mount: useCommsRuntime resets the store on mount (principal
    // isolation), which would wipe a pre-render seed.
    act(() => {
      useCommsStore.setState({
        notifications: [notification({ id: "a", link: { type: "screen", screen: "support" } })],
        notificationUnread: 1,
        openSection: "notifications",
      });
    });

    fireEvent.click(screen.getByText("결재 요청"));

    expect(useCommsStore.getState().notifications[0].unread).toBe(false);
    expect(useCommsStore.getState().notificationUnread).toBe(0);
    expect(screen.getByTestId("pathname")).toHaveTextContent("/support");
  });

  it("marks all notifications read from the section header", () => {
    setViewport(1400);
    renderRail();
    act(() => {
      useCommsStore.setState({
        notifications: [notification({ id: "a" }), notification({ id: "b" })],
        notificationUnread: 2,
        openSection: "notifications",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: ko.shell.commsRail.markAllRead }));
    expect(useCommsStore.getState().notificationUnread).toBe(0);
  });

  it("consumes Escape: subview → home, then collapses the rail", () => {
    setViewport(1400);
    renderRail();
    act(() => {
      useCommsStore.setState({ collapsedPref: false, subview: { kind: "thread", threadId: "t1" } });
    });

    const first = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    act(() => {
      document.dispatchEvent(first);
    });
    expect(first.defaultPrevented).toBe(true);
    expect(useCommsStore.getState().subview).toEqual({ kind: "home" });

    const second = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    act(() => {
      document.dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(true);
    expect(useCommsStore.getState().collapsedPref).toBe(true);
  });

  it("swaps the send button's accessible label to 'sending' while a message is in flight", async () => {
    setViewport(1400);
    let resolvePost!: (value: { data: MessengerMessageSummary; response: Response }) => void;
    const postPromise = new Promise<{ data: MessengerMessageSummary; response: Response }>((resolve) => {
      resolvePost = resolve;
    });
    const api = stubApi();
    vi.mocked(api.POST).mockReturnValue(postPromise);

    renderRail("/dispatch", api);
    act(() => {
      useCommsStore.setState({ collapsedPref: false, subview: { kind: "thread", threadId: "t1" } });
    });

    fireEvent.change(screen.getByLabelText(ko.shell.commsRail.composer), {
      target: { value: "안녕하세요" },
    });
    fireEvent.click(screen.getByRole("button", { name: ko.shell.commsRail.send }));

    expect(await screen.findByRole("button", { name: ko.shell.commsRail.sending })).toBeInTheDocument();

    await act(async () => {
      resolvePost({
        data: {
          id: "m1",
          thread_id: "t1",
          branch_id: "b1",
          sender_id: "u1",
          sender_name: "테스터",
          body: "안녕하세요",
          attachment_evidence_ids: [],
          read_count: 0,
          read_target_count: 1,
          sent_at: "2026-07-08T00:00:00Z",
          created_at: "2026-07-08T00:00:00Z",
        },
        response: new Response(),
      });
      await postPromise;
    });

    expect(await screen.findByRole("button", { name: ko.shell.commsRail.send })).toBeInTheDocument();
  });

  it("is hidden entirely below the mobile breakpoint", () => {
    setViewport(600);
    renderRail();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});
