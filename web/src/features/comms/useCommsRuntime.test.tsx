import { renderHook } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { AuthSession } from "../../context/auth";
import { FEATURES } from "../../components/shell/nav";
import { useCommsStore } from "./store";
import { useCommsRuntime } from "./useCommsRuntime";

const emptyApi = {
  GET: vi.fn(() => Promise.resolve({ data: undefined, response: new Response() })),
} as unknown as ConsoleApiClient;

const userA: AuthSession = {
  access_token: "a",
  user_id: "user-A",
  roles: ["ADMIN"],
  branches: [],
  feature_grants: [FEATURES.MAIL_USE],
};
// Different principal that LACKS the mail surface, so a fetch can't overwrite a
// stale mail count — only a reset clears it.
const userB: AuthSession = { ...userA, access_token: "b", user_id: "user-B", feature_grants: [] };

beforeAll(() => {
  vi.stubGlobal("WebSocket", class {
    addEventListener() {}
    close() {}
  });
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  useCommsStore.getState().reset();
});

describe("useCommsRuntime principal isolation", () => {
  it("resets rail + badge state when the principal changes (impersonation swap)", () => {
    const { rerender } = renderHook(
      ({ session }: { session: AuthSession | undefined }) => {
        useCommsRuntime(emptyApi, session);
      },
      { initialProps: { session: userA } },
    );

    // Simulate user A's loaded data, incl. a mail count B has no gate to refetch.
    useCommsStore.setState({
      counts: { approvals: 3, messenger: 2, mail: 5, supportOpen: 1, supportUnread: 1 },
      notifications: [
        {
          id: "n1",
          recipient_user_id: "user-A",
          category: "결재",
          text: "A's notification",
          link: { type: "screen", screen: "approvals" },
          unread: true,
          created_at: "2026-07-09T00:00:00Z",
          read_at: null,
        },
      ],
      notificationUnread: 1,
    });

    rerender({ session: userB });

    const state = useCommsStore.getState();
    expect(state.notifications).toEqual([]);
    expect(state.notificationUnread).toBe(0);
    expect(state.counts.mail).toBe(0); // the leak the reviewer flagged
    expect(state.counts.approvals).toBe(0);
  });

  it("clears state on logout (user_id → undefined)", () => {
    const { rerender } = renderHook(
      ({ session }: { session: AuthSession | undefined }) => {
        useCommsRuntime(emptyApi, session);
      },
      { initialProps: { session: userA } },
    );
    useCommsStore.setState({ notificationUnread: 4, counts: { approvals: 9, messenger: 0, mail: 0, supportOpen: 0, supportUnread: 0 } });

    rerender({ session: undefined });

    const state = useCommsStore.getState();
    expect(state.notificationUnread).toBe(0);
    expect(state.counts.approvals).toBe(0);
  });
});
