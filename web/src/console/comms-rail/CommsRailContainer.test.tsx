import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CommsRailContainer } from "./CommsRailContainer";
import type { CommsRailCopy } from "./view/CommsRailView";

let auth: { api: unknown; session: unknown; viewAs?: unknown };

vi.mock("../../context/auth", () => ({
  useAuth: () => auth,
}));

const copy: CommsRailCopy = {
  landmark: "Communications", drawerTitle: "Communications", close: "Close", open: "Open",
  source: { messenger: "Messenger", mail: "Mail", notifications: "Notifications", notices: "Notices" },
  state: { loading: "Loading", empty: "Empty", denied: "Denied", malformed: "Malformed", error: "Error", retry: "Retry", retrying: "Retrying" },
  action: { "mark-messenger-read": "Mark read", "mark-mail-read": "Mark read", "mark-notification-read": "Mark read" },
  unread: (count) => `${String(count)} unread`, collapse: (name) => `Collapse ${name}`,
  expand: (name) => `Expand ${name}`, detail: "Detail", occurredAt: (value) => value,
};

const UUID_A = "00000000-0000-4000-8000-000000000001";
const UUID_B = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-07-22T10:00:00.000Z";

function response(data: unknown) { return { data, response: new Response(null, { status: 200 }) }; }

function apiFor(title: string) {
  return {
    GET: vi.fn((path: string) => Promise.resolve(path === "/api/messenger/threads"
      ? response({ items: [{ id: UUID_A, branch_id: UUID_B, kind: "channel", visibility: "channel", muted: false, title, last_message_id: UUID_B, last_message_at: NOW, member_count: 1, unread_count: 1, created_at: NOW, updated_at: NOW }] })
      : response({}))),
    PUT: vi.fn(), PATCH: vi.fn(), POST: vi.fn(),
  };
}

function session(userId: string) {
  return { access_token: `token-${userId}`, user_id: userId, org_id: UUID_A, branches: [UUID_B], roles: ["admin"], group_roles: [], feature_grants: [] };
}

describe("CommsRailContainer", () => {
  it("synchronously remounts on full auth scope changes and never leaves prior-principal rows visible", async () => {
    const apiA = apiFor("Alpha");
    auth = { api: apiA, session: session(UUID_A) };
    const view = render(<CommsRailContainer copy={copy} />);
    expect(await screen.findByText("Alpha")).toBeVisible();

    const apiB = apiFor("Beta");
    auth = { api: apiB, session: session(UUID_B), viewAs: { mode: "role", actingOrgId: UUID_A, actingRole: "manager" } };
    view.rerender(<CommsRailContainer copy={copy} />);

    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getAllByText("Loading").length).toBeGreaterThan(0);
    expect(await screen.findByText("Beta")).toBeVisible();
    expect(apiB.GET).toHaveBeenCalledWith("/api/messenger/threads", expect.objectContaining({
      headers: { "Cache-Control": "no-store, no-cache" },
    }));
  });

  it("does not request or render a rail without an authenticated complete scope", () => {
    auth = { api: apiFor("unused"), session: undefined };
    const { container } = render(<CommsRailContainer copy={copy} />);
    expect(container).toBeEmptyDOMElement();
  });
});

