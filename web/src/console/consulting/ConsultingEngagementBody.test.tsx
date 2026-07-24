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

function renderBody(overrides: { session?: object; history?: unknown[]; engagement?: Partial<typeof engagement>; detail?: object | ((count: number) => object); post?: (path: string, options: unknown) => unknown } = {}) {
  const item = { ...engagement, ...overrides.engagement };
  let detailReads = 0;
  const POST = vi.fn((path: string, options: unknown) => overrides.post?.(path, options) ?? Promise.resolve({ data: { ...item, status: "PROPOSED", version: 2 } }));
  const GET = vi.fn((path: string) => {
    if (path.endsWith("/history")) return Promise.resolve({ data: overrides.history ?? [{ id: "history-1", event_type: "engagement.created", version: 1, payload: {}, occurred_at: "2026-07-23T00:00:00Z" }] });
    if (path.includes("{engagement_id}")) {
      detailReads += 1;
      const detail = typeof overrides.detail === "function" ? overrides.detail(detailReads) : overrides.detail;
      return Promise.resolve({ data: { ...item, diagnostics: [], findings: [], initiatives: [], observations: [], ...detail } });
    }
    return Promise.resolve({ data: { items: [item], limit: 25, offset: 0, total: 1 } });
  });
  useAuth.mockReturnValue({ api: { GET, POST }, session: { org_id: "org-a", user_id: "user-a", client_session_incarnation: "session-a", access_token: "token-a", ...overrides.session } });
  return { GET, POST, ...render(<ConsultingEngagementBody />) };
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

  it("records a diagnostic against the selected engagement and re-reads the server lineage", async () => {
    const { GET, POST } = renderBody();
    fireEvent.click(await screen.findByRole("button", { name: /현장 진단/ }));
    const summary = await screen.findByLabelText("진단 요약");
    fireEvent.change(summary, { target: { value: "현장 운영 흐름을 검토했습니다" } });
    fireEvent.click(screen.getByRole("button", { name: "진단 기록" }));
    await waitFor(() => {
      expect(POST).toHaveBeenCalledWith(
        "/api/v1/consulting/engagements/{engagement_id}/diagnostics",
        expect.objectContaining({
          params: { path: { engagement_id: engagement.id } },
          body: { summary: "현장 운영 흐름을 검토했습니다" },
          signal: expect.any(AbortSignal),
        }),
      );
      expect(GET).toHaveBeenCalledWith("/api/v1/consulting/engagements/{engagement_id}", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
  });

  it("submits the governed draft-to-proposed transition with the current version and reconciles list, detail, plus immutable history", async () => {
    const { GET, POST } = renderBody({ detail: count => count > 1 ? { status: "PROPOSED", version: 2 } : {}, history: [
      { id: "history-1", event_type: "engagement.created", version: 1, payload: {}, occurred_at: "2026-07-23T00:00:00Z" },
      { id: "history-2", event_type: "engagement.transitioned", version: 2, payload: {}, occurred_at: "2026-07-23T00:00:01Z" },
    ] });
    fireEvent.click(await screen.findByRole("button", { name: /현장 진단/ }));
    await screen.findByRole("button", { name: "제안으로 전환" });
    fireEvent.change(screen.getByLabelText("전환 사유"), { target: { value: "현장 진단 범위를 제안합니다" } });
    fireEvent.click(screen.getByRole("button", { name: "제안으로 전환" }));
    await waitFor(() => {
      expect(POST).toHaveBeenCalledWith(
        "/api/v1/consulting/engagements/{engagement_id}/transition",
        expect.objectContaining({
          params: { path: { engagement_id: engagement.id } },
          body: { toStatus: "PROPOSED", expectedVersion: 1, reason: "현장 진단 범위를 제안합니다" },
          signal: expect.any(AbortSignal),
        }),
      );
    });
    await waitFor(() => {
      expect(GET).toHaveBeenCalledWith("/api/v1/consulting/engagements/{engagement_id}/history", expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(screen.getByText("상태 전환 · v2")).toBeVisible();
      expect(screen.getByRole("button", { name: /현장 진단.*제안.*v2/ })).toBeVisible();
    });
  });

  it("does not issue IMPLEMENTED-to-MEASURED without a real observation and keeps the observation path reachable", async () => {
    const initiative = { id: "33333333-3333-4333-8333-333333333333", finding_id: "44444444-4444-4444-8444-444444444444", title: "운영 개선", hypothesis: "대기 시간을 줄입니다", kpi_definition_id: "55555555-5555-4555-8555-555555555555", target_direction: "DECREASE", created_at: "2026-07-23T00:00:00Z" };
    const { POST } = renderBody({ engagement: { status: "IMPLEMENTED", version: 7 }, detail: { initiatives: [initiative] } });
    fireEvent.click(await screen.findByRole("button", { name: /현장 진단/ }));
    await screen.findByRole("button", { name: "효익 관측 기록" });
    fireEvent.change(screen.getByLabelText("전환 사유"), { target: { value: "측정 단계로 이동" } });
    const measured = screen.getByRole("button", { name: "측정으로 전환" });
    expect(measured).toBeDisabled();
    fireEvent.click(measured);
    expect(POST).not.toHaveBeenCalled();
    expect(screen.getByText("측정, 지속 또는 시정 전환은 실제 효익 관측이 필요합니다.")).toBeVisible();
  });

  it("renders a real generated ErrorBody forbidden message rather than a generic fallback", async () => {
    renderBody({ post: () => Promise.resolve({ error: { error: { code: "FORBIDDEN", message: "현재 역할에는 컨설팅 전환 권한이 없습니다." } } }) });
    fireEvent.click(await screen.findByRole("button", { name: /현장 진단/ }));
    fireEvent.change(await screen.findByLabelText("전환 사유"), { target: { value: "제안" } });
    fireEvent.click(screen.getByRole("button", { name: "제안으로 전환" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("현재 역할에는 컨설팅 전환 권한이 없습니다.");
  });

  it("keeps authoritative state unchanged and exposes a refresh path when a governed transition conflicts", async () => {
    const { POST } = renderBody({ post: () => Promise.resolve({ error: { error: { code: "CONFLICT", message: "engagement changed or was not found; reload before retrying" } } }) });
    fireEvent.click(await screen.findByRole("button", { name: /현장 진단/ }));
    await screen.findByRole("button", { name: "제안으로 전환" });
    fireEvent.change(screen.getByLabelText("전환 사유"), { target: { value: "다시 시도" } });
    fireEvent.click(screen.getByRole("button", { name: "제안으로 전환" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("engagement changed or was not found; reload before retrying");
    expect(screen.getByRole("button", { name: "현재 상태 새로고침" })).toBeVisible();
    expect(POST).toHaveBeenCalledTimes(1);
  });
});
