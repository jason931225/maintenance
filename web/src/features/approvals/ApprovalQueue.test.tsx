import { render, screen, within } from "@testing-library/react";
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

import type { components } from "@maintenance/api-client-ts";
import type { WorkOrderListItem } from "../../api/types";
import { ApprovalQueue } from "./ApprovalQueue";
import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
import { branchId, primaryMechanicId, workOrderListItems } from "../../test/fixtures";

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

// Two PENDING approval items (order A and order B), each with its OWN request_no
// and id so the per-order reject dialog can be proven to scope its memo to a
// single order — a memo typed for A can never be applied to B.
const ORDER_A = workOrderListItems[1]; // 20260612-002 (ADMIN_REVIEW)
const ORDER_B: WorkOrderListItem = {
  ...ORDER_A,
  id: "feed0002-0002-4002-8002-000000000002",
  request_no: "20260612-009",
  status: "REPORT_SUBMITTED",
};

function detailFor(
  item: WorkOrderListItem,
  overrides: Partial<components["schemas"]["WorkOrderDetail"]> = {},
): components["schemas"]["WorkOrderDetail"] {
  return {
    ...item,
    symptom: "주행 중 유압 누유가 발생합니다.",
    customer_request: "오전 중 방문 요청",
    delay_reason: null,
    delay_note: null,
    diagnosis: "유압 호스 균열 확인",
    action_taken: "유압 호스 교체",
    result_type: "COMPLETED",
    report_submitted_by: primaryMechanicId,
    report_submitted_at: "2026-06-12T14:00:00Z",
    kpi_excluded: false,
    evidence_verified: true,
    approval_line: [],
    status_history: [
      {
        id: "aaaa1111-1111-4111-8111-111111111111",
        actor: primaryMechanicId,
        action: "REPORT",
        from_status: "IN_PROGRESS",
        to_status: "REPORT_SUBMITTED",
        occurred_at: "2026-06-12T14:00:00Z",
      },
    ],
    evidence: [
      {
        id: "ev000002-0002-4002-8002-000000000002",
        stage: "AFTER",
        content_type: "image/jpeg",
        size_bytes: 102400,
        uploaded_by: primaryMechanicId,
        worm_replica_status: "PENDING",
        retry_count: 0,
        verified_at: "2026-06-12T14:05:00Z",
        created_at: "2026-06-12T14:01:00Z",
      },
    ],
    ...overrides,
  };
}

function detailHandler() {
  return http.get("*/api/v1/work-orders/:id", ({ params }) => {
    if (params.id === ORDER_A.id) {
      return HttpResponse.json(detailFor(ORDER_A));
    }
    if (params.id === ORDER_B.id) {
      return HttpResponse.json(detailFor(ORDER_B));
    }
    return HttpResponse.json({ error: "not found" }, { status: 404 });
  });
}

// The embedded read-only detail fetches each evidence's status for a thumbnail.
function evidenceStatusHandler() {
  return http.get("*/api/v1/evidence/:evidenceId/status", () =>
    HttpResponse.json({
      id: "ev000002-0002-4002-8002-000000000002",
      work_order_id: ORDER_A.id,
      stage: "AFTER",
      processing_status: "READY",
      content_type: "image/jpeg",
      thumbnail_url: "https://example.test/after.jpg",
      processed_at: "2026-06-12T14:02:00Z",
    }),
  );
}

const adminSession: AuthSession = {
  access_token: "a",
  user_id: "admin-1",
  roles: ["ADMIN"],
  branches: [branchId],
};

function makeAuthContext(): AuthContextValue {
  const api = createConsoleApiClient(adminSession.access_token);
  return {
    session: adminSession,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api,
  };
}

function renderQueue(props: {
  onApprove: (id: string) => Promise<boolean>;
  onReject: (id: string, memo: string) => Promise<boolean>;
}) {
  return render(
    <AuthContext.Provider value={makeAuthContext()}>
      <ApprovalQueue
        workOrders={[ORDER_A, ORDER_B]}
        onApprove={props.onApprove}
        onReject={props.onReject}
      />
    </AuthContext.Provider>,
  );
}

describe("ApprovalQueue", () => {
  it("reveals the report — diagnosis, action, result and evidence — before the approver decides", async () => {
    const user = userEvent.setup();
    server.use(detailHandler(), evidenceStatusHandler());

    renderQueue({
      onApprove: vi.fn().mockResolvedValue(true),
      onReject: vi.fn().mockResolvedValue(true),
    });

    // Both pending orders are listed; the non-pending fixture row is filtered out.
    expect(screen.getByText("20260612-002")).toBeVisible();
    expect(screen.getByText("20260612-009")).toBeVisible();
    expect(screen.queryByText("20260612-003")).not.toBeInTheDocument();

    // The report is NOT fetched/shown until the approver opens the row.
    expect(screen.queryByText("유압 호스 균열 확인")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "20260612-002 보고 보기" }),
    );

    // Now the approver sees the diagnosis, action taken and the evidence thumb —
    // the work they previously approved blind.
    expect(await screen.findByText("유압 호스 균열 확인")).toBeVisible();
    expect(screen.getByText("유압 호스 교체")).toBeVisible();
    expect(screen.getByText("주행 중 유압 누유가 발생합니다.")).toBeVisible();
    const thumb = await screen.findByAltText("증거 미리보기");
    expect(thumb).toHaveAttribute("src", "https://example.test/after.jpg");
    await user.click(screen.getByRole("button", { name: "미리보기 열기" }));
    const viewer = await screen.findByRole("dialog", { name: "증거 이미지 미리보기" });
    expect(within(viewer).getByText("증거 · image/jpeg")).toBeVisible();
    expect(within(viewer).getByText("2026-06-12 23:01")).toBeVisible();
    expect(within(viewer).getByRole("link", { name: "파일 열기" })).toHaveAttribute(
      "href",
      "https://example.test/after.jpg",
    );
  });

  it("approves the specific order only after a required decision comment", async () => {
    const user = userEvent.setup();
    const approve = vi.fn().mockResolvedValue(true);
    server.use(detailHandler(), evidenceStatusHandler());

    renderQueue({ onApprove: approve, onReject: vi.fn().mockResolvedValue(true) });

    await user.click(
      screen.getByRole("button", { name: "20260612-009 승인" }),
    );

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("20260612-009")).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "승인" }));
    expect(within(dialog).getByText("승인 의견을 입력하세요.")).toBeVisible();
    expect(approve).not.toHaveBeenCalled();

    await user.type(
      within(dialog).getByLabelText("승인 의견"),
      "증빙 확인 후 승인",
    );
    await user.click(within(dialog).getByRole("button", { name: "승인" }));

    expect(approve).toHaveBeenCalledWith(ORDER_B.id, "증빙 확인 후 승인");
  });

  it("rejects through a per-order dialog carrying the correct workOrderId and its own memo", async () => {
    const user = userEvent.setup();
    const reject = vi.fn().mockResolvedValue(true);
    server.use(detailHandler(), evidenceStatusHandler());

    renderQueue({ onApprove: vi.fn().mockResolvedValue(true), onReject: reject });

    await user.click(
      screen.getByRole("button", { name: "20260612-002 반려" }),
    );

    const dialog = screen.getByRole("dialog");
    // The dialog is scoped to order A.
    expect(within(dialog).getByText("20260612-002")).toBeVisible();

    await user.type(
      within(dialog).getByLabelText("반려 메모"),
      "증빙 부족으로 반려",
    );
    await user.click(within(dialog).getByRole("button", { name: "반려" }));

    expect(reject).toHaveBeenCalledWith(ORDER_A.id, "증빙 부족으로 반려");
  });

  it("requires a memo and never carries order A's memo to order B", async () => {
    const user = userEvent.setup();
    const reject = vi.fn().mockResolvedValue(true);
    server.use(detailHandler(), evidenceStatusHandler());

    renderQueue({ onApprove: vi.fn().mockResolvedValue(true), onReject: reject });

    // Open order A's reject dialog, type a memo, then cancel without rejecting.
    await user.click(
      screen.getByRole("button", { name: "20260612-002 반려" }),
    );
    let dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("반려 메모"), "A 전용 메모");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));

    // Now open order B's reject dialog: its memo field must be empty (A's memo
    // is never reused) and a blank submit must be blocked.
    await user.click(
      screen.getByRole("button", { name: "20260612-009 반려" }),
    );
    dialog = screen.getByRole("dialog");
    const memoField = within(dialog).getByLabelText("반려 메모");
    expect(memoField).toHaveValue("");

    // Submitting blank surfaces the required-memo error and never calls onReject.
    await user.click(within(dialog).getByRole("button", { name: "반려" }));
    expect(within(dialog).getByText("반려 메모를 입력하세요.")).toBeVisible();
    expect(reject).not.toHaveBeenCalled();

    // A memo typed for B rejects B (its own id + its own memo).
    await user.type(memoField, "B 전용 메모");
    await user.click(within(dialog).getByRole("button", { name: "반려" }));
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledWith(ORDER_B.id, "B 전용 메모");
  });
});
