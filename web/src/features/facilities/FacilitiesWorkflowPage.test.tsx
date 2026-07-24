import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../../context/auth", () => ({ useAuth }));

import { FacilitiesWorkflowPage } from "./FacilitiesWorkflowPage";

const caseId = "11111111-1111-1111-1111-111111111111";
const techId = "22222222-2222-2222-2222-222222222222";
const evidenceA = "33333333-3333-3333-3333-333333333333";
const evidenceB = "44444444-4444-4444-4444-444444444444";
const actorId = techId;

const allFacilitiesCapabilities = [
  "facilities_manage",
  "facilities_dispatch",
  "facilities_execute",
  "facilities_accept",
  "facilities_observe",
];

function authzResponse(features = allFacilitiesCapabilities) {
  return new Response(JSON.stringify({
    roles: ["OPERATOR"],
    branch_scope: { kind: "all" },
    capabilities: features.map((feature) => ({ feature, permission: "allow", branch_scope: { kind: "all" } })),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function caseView(status: string, overrides = {}) {
  return { id: caseId, status, assigneeId: status === "DUE" || status === "SCHEDULED" ? null : techId, responseDueAt: "2030-01-01T09:00:00Z", completionDueAt: "2030-01-01T12:00:00Z", acceptanceDueAt: "2030-01-02T12:00:00Z", energyDeltaKwh: null, totalCostKrw: 0, ...overrides };
}

function setupApi(initial = "DUE", userId = actorId) {
  let status = initial;
  let value = caseView(status);
  const GET = vi.fn((path: string) => {
    if (path === "/api/v1/facilities/cases") return Promise.resolve({ data: [value], response: new Response() });
    return Promise.resolve({ data: value, response: new Response() });
  });
  const POST = vi.fn((path: string, options?: { body?: Record<string, unknown> }) => {
    if (path.endsWith("/triage")) status = "SCHEDULED";
    else if (path.endsWith("/assign")) status = "ASSIGNED";
    else if (path.endsWith("/start")) status = "IN_PROGRESS";
    else if (path.endsWith("/observations")) value = caseView(status, { energyDeltaKwh: "-8.500", totalCostKrw: options?.body?.costKrw ?? 0 });
    else if (path.endsWith("/submit")) status = "AWAITING_ACCEPTANCE";
    else if (path.endsWith("/acceptance")) status = options?.body?.decision === "ACCEPTED" ? "CLOSED" : "REWORK_REQUIRED";
    value = { ...value, ...caseView(status), ...(path.endsWith("/observations") ? { energyDeltaKwh: "-8.500", totalCostKrw: options?.body?.costKrw ?? 0 } : {}) };
    return Promise.resolve({ data: path === "/api/v1/facilities/cases" ? value : {}, response: new Response() });
  });
  useAuth.mockReturnValue({ api: { GET, POST }, session: { access_token: "token", org_id: "org", user_id: userId, client_session_incarnation: "session" } });
  return { GET, POST };
}

describe("FacilitiesWorkflowPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(authzResponse()));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("executes the real lifecycle commands and renders only server-read state", async () => {
    const { POST } = setupApi();
    const user = userEvent.setup();
    render(<FacilitiesWorkflowPage />);
    await screen.findByRole("heading", { name: "접수 대기" });

    await user.clear(screen.getByLabelText("현장 예정 시각"));
    await user.type(screen.getByLabelText("현장 예정 시각"), "2030-01-01T10:00");
    await user.click(screen.getByRole("button", { name: "일정 확정" }));
    await screen.findByRole("heading", { name: "일정 확정" });

    await user.type(screen.getByLabelText("담당 사용자 ID"), techId);
    await user.click(screen.getByRole("button", { name: "담당 배정" }));
    await screen.findByRole("heading", { name: "담당 배정" });
    await user.click(screen.getByRole("button", { name: "작업 시작" }));
    await screen.findByRole("heading", { name: "작업 진행" });

    await user.type(screen.getByLabelText("작업 전 kWh"), "100.000");
    await user.type(screen.getByLabelText("작업 후 kWh"), "91.500");
    await user.type(screen.getByLabelText("비용 (KRW)"), "42000");
    await user.click(screen.getByRole("button", { name: "관측 기록" }));
    await screen.findByText("-8.500 kWh");
    expect(screen.getByText("42,000 KRW")).toBeInTheDocument();

    await user.type(screen.getByLabelText("안전 점검 증빙 ID"), evidenceA);
    await user.type(screen.getByLabelText("서비스 보고 증빙 ID"), evidenceB);
    await user.click(screen.getByRole("button", { name: "인수 요청 제출" }));
    await screen.findByRole("heading", { name: "인수 확인 대기" });
    await user.click(screen.getByRole("button", { name: "인수 및 종결" }));
    await screen.findByRole("heading", { name: "종결" });
    expect(screen.getByText("종결된 사례")).toBeInTheDocument();

    expect(POST.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/facilities/cases/{case_id}/triage",
      "/api/v1/facilities/cases/{case_id}/assign",
      "/api/v1/facilities/cases/{case_id}/start",
      "/api/v1/facilities/cases/{case_id}/observations",
      "/api/v1/facilities/cases/{case_id}/submit",
      "/api/v1/facilities/cases/{case_id}/acceptance",
    ]);
  });

  it("requires a rejected case to restart before observation and evidence submission", async () => {
    const { POST } = setupApi("AWAITING_ACCEPTANCE");
    const user = userEvent.setup();
    render(<FacilitiesWorkflowPage />);
    await screen.findByRole("heading", { name: "인수 확인 대기" });

    await user.type(screen.getByLabelText("반려 사유 (반려 시 기록)"), "현장 조정이 필요합니다");
    await user.click(screen.getByRole("button", { name: "재작업 요청" }));
    await screen.findByRole("heading", { name: "재작업 필요" });
    expect(screen.queryByRole("button", { name: "인수 요청 제출" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "작업 시작" }));
    await screen.findByRole("heading", { name: "작업 진행" });
    await user.type(screen.getByLabelText("작업 전 kWh"), "91.500");
    await user.type(screen.getByLabelText("작업 후 kWh"), "90.000");
    await user.click(screen.getByRole("button", { name: "관측 기록" }));
    await screen.findByText("-8.500 kWh");
    await user.type(screen.getByLabelText("안전 점검 증빙 ID"), evidenceA);
    await user.type(screen.getByLabelText("서비스 보고 증빙 ID"), evidenceB);
    await user.click(screen.getByRole("button", { name: "인수 요청 제출" }));
    await screen.findByRole("heading", { name: "인수 확인 대기" });

    expect(POST.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/facilities/cases/{case_id}/acceptance",
      "/api/v1/facilities/cases/{case_id}/start",
      "/api/v1/facilities/cases/{case_id}/observations",
      "/api/v1/facilities/cases/{case_id}/submit",
    ]);
  });

  it("keeps observation-only operators read-only except for observations", async () => {
    const { POST } = setupApi("IN_PROGRESS");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(authzResponse(["facilities_observe"])));
    render(<FacilitiesWorkflowPage />);

    expect(await screen.findByRole("button", { name: "관측 기록" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "인수 요청 제출" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "사례 접수" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "작업 진행" })).toBeInTheDocument();
    expect(POST).not.toHaveBeenCalled();
  });

  it("omits execute controls for a non-assignee even with the execute capability", async () => {
    setupApi("ASSIGNED", "another-operator");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(authzResponse(["facilities_execute"])));
    render(<FacilitiesWorkflowPage />);

    expect(await screen.findByRole("heading", { name: "담당 배정" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "작업 시작" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "인수 요청 제출" })).not.toBeInTheDocument();
  });

  it("marks the selected case with semantic pressed state", async () => {
    setupApi();
    render(<FacilitiesWorkflowPage />);

    await screen.findByRole("heading", { name: "접수 대기" });
    expect(screen.getByRole("button", { name: `사례 ${caseId}` })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not send a submission without both mandatory evidence records", async () => {
    const { POST } = setupApi("IN_PROGRESS");
    render(<FacilitiesWorkflowPage />);
    await screen.findByRole("heading", { name: "작업 진행" });
    const submitForm = screen.getByRole("button", { name: "인수 요청 제출" }).closest("form");
    if (!submitForm) throw new Error("submission form is missing");
    fireEvent.submit(submitForm);
    expect(await screen.findByRole("alert")).toHaveTextContent("안전 점검과 서비스 보고 증빙 ID가 모두 필요합니다.");
    expect(POST).not.toHaveBeenCalled();
  });

  it("renders the backend failure rather than inventing a transition", async () => {
    const { POST } = setupApi();
    POST.mockResolvedValueOnce({ error: new Error("illegal transition"), response: new Response("", { status: 409 }) });
    const user = userEvent.setup();
    render(<FacilitiesWorkflowPage />);
    await screen.findByRole("heading", { name: "접수 대기" });
    await user.click(screen.getByRole("button", { name: "일정 확정" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("illegal transition");
    expect(screen.getByRole("heading", { name: "접수 대기" })).toBeInTheDocument();
  });
});
