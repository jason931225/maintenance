import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ko } from "../../i18n/ko";
import { AuditFeed } from "./AuditFeed";

const server = setupServer();
const T = ko.console.audit;

const auditItems = [
  {
    id: "audit-1",
    actor: "11111111-1111-4111-8111-111111111111",
    action: "payroll.view",
    target_type: "payroll_run",
    target_id: "PS-2026-07",
    branch_id: "branch-1",
    before_snap: null,
    after_snap: { decision: "permit" },
    trace_id: "trace-alpha-00000000000000000001",
    span_id: "span-alpha",
    occurred_at: "2025-03-15T08:30:15Z",
  },
  {
    id: "audit-2",
    actor: null,
    action: "policy.forbid",
    target_type: "policy",
    target_id: "POL-44",
    branch_id: null,
    before_snap: { status: "draft" },
    after_snap: { status: "active" },
    trace_id: "trace-beta-00000000000000000002",
    span_id: "span-beta",
    occurred_at: "2025-03-14T11:10:00Z",
  },
];

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function useAuditHandler() {
  server.use(
    http.get("*/api/audit", ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.get("offset")).toBe("0");
      expect(request.headers.get("authorization")).toBe("Bearer audit-token");
      return HttpResponse.json({ items: auditItems, limit: 50, offset: 0 });
    }),
  );
}

describe("AuditFeed", () => {
  it("renders live GET /api/audit records grouped by day with collapsed details by default", async () => {
    useAuditHandler();

    render(<AuditFeed bearerToken="audit-token" />);

    expect(await screen.findByText("PS-2026-07")).toBeVisible();
    expect(screen.getByText("POL-44")).toBeVisible();
    expect(screen.getByText("payroll.view")).toBeVisible();
    expect(screen.getByText("policy.forbid")).toBeVisible();

    const firstDay = T.day.absolute(new Date("2025-03-15T08:30:15Z"));
    const secondDay = T.day.absolute(new Date("2025-03-14T11:10:00Z"));
    expect(screen.getByRole("button", { name: T.actions.toggleDay(firstDay) })).toBeVisible();
    expect(screen.getByRole("button", { name: T.actions.toggleDay(secondDay) })).toBeVisible();
    expect(screen.queryByText("trace-alpha-00000000000000000001")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: T.actions.expandEntry("PS-2026-07") }));

    expect(screen.getByText("trace-alpha-00000000000000000001")).toBeVisible();
    expect(screen.getByText((content) => content.includes('"decision": "permit"'))).toBeVisible();
  });

  it("filters loaded records by trace ID", async () => {
    useAuditHandler();

    render(<AuditFeed bearerToken="audit-token" />);
    expect(await screen.findByText("PS-2026-07")).toBeVisible();

    fireEvent.change(screen.getByLabelText(T.search.label), { target: { value: "trace-beta" } });

    await waitFor(() => {
      expect(screen.queryByText("PS-2026-07")).not.toBeInTheDocument();
    });
    expect(screen.getByText("POL-44")).toBeVisible();
  });

  it("collapses and expands day groups without losing fetched data", async () => {
    useAuditHandler();

    render(<AuditFeed bearerToken="audit-token" />);
    expect(await screen.findByText("PS-2026-07")).toBeVisible();
    const firstDay = T.day.absolute(new Date("2025-03-15T08:30:15Z"));
    const groupToggle = screen.getByRole("button", { name: T.actions.toggleDay(firstDay) });

    fireEvent.click(groupToggle);

    expect(screen.queryByText("PS-2026-07")).not.toBeInTheDocument();
    expect(within(groupToggle).getByText(T.status.collapsed)).toBeVisible();

    fireEvent.click(groupToggle);

    expect(screen.getByText("PS-2026-07")).toBeVisible();
    expect(within(groupToggle).getByText(T.status.expanded)).toBeVisible();
  });

  it("renders endpoint failures as a chip status", async () => {
    server.use(http.get("*/api/audit", () => HttpResponse.json({ error: "boom" }, { status: 503 })));

    render(<AuditFeed bearerToken="audit-token" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(T.status.error);
  });
});
