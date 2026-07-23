import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConsultingEngagementBody } from "./ConsultingEngagementBody";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../../context/auth", () => ({ useAuth }));

const engagement = {
  id: "11111111-1111-4111-8111-111111111111", customer_id: "22222222-2222-4222-8222-222222222222",
  customer_document_id: null, ontology_instance_id: null, title: "현장 진단", status: "DRAFT", approval_id: null,
  workflow_execution_id: null, version: 1, created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
};

function renderBody(overrides: { session?: object; history?: unknown[] } = {}) {
  const GET = vi.fn((path: string) => {
    if (path.endsWith("/history")) return Promise.resolve({ data: overrides.history ?? [{ id: "history-1", event_type: "engagement.created", version: 1, payload: {}, occurred_at: "2026-07-23T00:00:00Z" }] });
    if (path.includes("{engagement_id}")) return Promise.resolve({ data: { ...engagement, diagnostics: [], findings: [], initiatives: [], observations: [] } });
    return Promise.resolve({ data: { items: [engagement], limit: 25, offset: 0, total: 1 } });
  });
  useAuth.mockReturnValue({ api: { GET }, session: { org_id: "org-a", user_id: "user-a", client_session_incarnation: "session-a", access_token: "token-a", ...overrides.session } });
  return { GET, ...render(<ConsultingEngagementBody />) };
}

describe("ConsultingEngagementBody", () => {
  it("renders Korean labels and server-ordered immutable history", async () => {
    const { GET } = renderBody({ history: [
      { id: "history-1", event_type: "engagement.created", version: 1, payload: {}, occurred_at: "2026-07-23T00:00:00Z" },
      { id: "history-2", event_type: "engagement.transitioned", version: 2, payload: {}, occurred_at: "2026-07-23T00:00:01Z" },
    ] });
    expect(await screen.findByRole("heading", { name: "컨설팅 실행 · 실현효익" })).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: /현장 진단/ }));
    expect(await screen.findByRole("heading", { name: "변경 이력" })).toBeVisible();
    expect(screen.getAllByRole("listitem").slice(-2).map(item => { return item.textContent; })).toEqual(["참여 생성 · v1", "상태 전환 · v2"]);
    expect(GET).toHaveBeenCalledWith("/api/v1/consulting/engagements/{engagement_id}/history", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("does not commit stale results after an auth-context switch", async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise(resolve => { resolveFirst = resolve; });
    const GET = vi.fn(() => first);
    useAuth.mockReturnValue({ api: { GET }, session: { org_id: "org-a", user_id: "user-a", client_session_incarnation: "session-a", access_token: "token-a" } });
    const view = render(<ConsultingEngagementBody />);
    useAuth.mockReturnValue({ api: { GET: vi.fn(() => Promise.resolve({ data: { items: [], limit: 25, offset: 0, total: 0 } })) }, session: { org_id: "org-b", user_id: "user-b", client_session_incarnation: "session-b", access_token: "token-b" } });
    view.rerender(<ConsultingEngagementBody />);
    resolveFirst({ data: { items: [engagement], limit: 25, offset: 0, total: 1 } });
    await waitFor(() => { expect(screen.getByText("표시할 컨설팅 참여가 없습니다.")).toBeVisible(); });
    expect(screen.queryByRole("button", { name: /현장 진단/ })).toBeNull();
  });
});
