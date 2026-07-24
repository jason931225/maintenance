import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthSession } from "../../context/auth";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import { TodayPanel } from "./TodayPanel";

const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const TODO_ID = "80000000-0000-4000-8000-000000000001";

const session: AuthSession = {
  access_token: "test-token",
  user_id: USER_ID,
  roles: ["MECHANIC"],
  branches: [],
};

const createRequests: unknown[] = [];
const doneRequests: { todoId: string; body: unknown }[] = [];
const deleteRequests: string[] = [];

const openTodo = {
  id: TODO_ID,
  owner_user_id: USER_ID,
  text: "지게차 12호 점검 일정 잡기",
  scopes: [{ kind: "site", id: "site-1", label: "창원 1공장" }],
  links: [],
  done: false,
  created_at: "2026-07-09T08:00:00Z",
  updated_at: "2026-07-09T08:00:00Z",
  done_at: null,
};

const server = setupServer(
  http.get("*/api/v1/me/todos", () =>
    HttpResponse.json({ items: [openTodo] }),
  ),
  http.get("*/api/v1/hr/attendance-records/me", () =>
    HttpResponse.json({
      items: [
        {
          id: "90000000-0000-4000-8000-000000000001",
          kind: "CLOCK_IN",
          occurred_at: "2026-07-09T09:00:00Z",
          state_after: "CLOCKED_IN",
          note: null,
          payroll_material_ref_id: "90000000-0000-4000-8000-000000000002",
          duplicate: false,
        },
      ],
    }),
  ),
  http.post("*/api/v1/me/todos", async ({ request }) => {
    const body = await request.json();
    createRequests.push(body);
    return HttpResponse.json(
      {
        ...openTodo,
        id: "80000000-0000-4000-8000-000000000002",
        text: (body as { text: string }).text,
        scopes: [],
      },
      { status: 201 },
    );
  }),
  http.post("*/api/v1/me/todos/:todoId/done", async ({ request, params }) => {
    const body = await request.json();
    doneRequests.push({ todoId: String(params.todoId), body });
    return HttpResponse.json({
      ...openTodo,
      done: (body as { done: boolean }).done,
      done_at: "2026-07-09T10:00:00Z",
    });
  }),
  http.delete("*/api/v1/me/todos/:todoId", ({ params }) => {
    deleteRequests.push(String(params.todoId));
    return new HttpResponse(null, { status: 204 });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  createRequests.length = 0;
  doneRequests.length = 0;
  deleteRequests.length = 0;
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function renderPanel() {
  return render(
    <AuthTestProvider session={session}>
      <MemoryRouter>
        <TodayPanel />
      </MemoryRouter>
    </AuthTestProvider>,
  );
}

describe("TodayPanel", () => {
  it("renders todos with scope chips and the punch-status chip", async () => {
    renderPanel();
    expect(
      await screen.findByText("지게차 12호 점검 일정 잡기"),
    ).toBeVisible();
    expect(screen.getByText("창원 1공장")).toBeVisible();
    expect(await screen.findByText("근무 중")).toBeVisible();
    expect(screen.getByRole("link", { name: "근태 기록 열기" })).toHaveAttribute(
      "href",
      "/attendance",
    );
  });

  it("creates a todo through the real endpoint", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("지게차 12호 점검 일정 잡기");

    await user.type(
      screen.getByRole("textbox", { name: "할 일 추가" }),
      "월간 보고서 검토",
    );
    await user.click(screen.getByRole("button", { name: "추가" }));
    await waitFor(() => {
      expect(createRequests).toHaveLength(1);
    });
    expect(createRequests[0]).toEqual({
      text: "월간 보고서 검토",
      scopes: [],
      links: [],
    });
  });

  it("marks a todo done with explicit state (undo-capable)", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("지게차 12호 점검 일정 잡기");

    await user.click(
      screen.getByRole("checkbox", {
        name: "지게차 12호 점검 일정 잡기 완료로 표시",
      }),
    );
    await waitFor(() => {
      expect(doneRequests).toHaveLength(1);
    });
    expect(doneRequests[0]).toEqual({ todoId: TODO_ID, body: { done: true } });
  });

  it("deletes a todo through the real endpoint", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("지게차 12호 점검 일정 잡기");

    await user.click(
      screen.getByRole("button", { name: "지게차 12호 점검 일정 잡기 삭제" }),
    );
    await waitFor(() => {
      expect(deleteRequests).toEqual([TODO_ID]);
    });
  });

  it("shows the todos error state with retry when the list read fails", async () => {
    server.use(
      http.get("*/api/v1/me/todos", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderPanel();
    expect(
      await screen.findByText("할 일을 불러오지 못했습니다."),
    ).toBeVisible();
  });

  it("shows the empty state when there are no todos", async () => {
    server.use(
      http.get("*/api/v1/me/todos", () => HttpResponse.json({ items: [] })),
    );
    renderPanel();
    expect(
      await screen.findByText("등록된 할 일이 없습니다."),
    ).toBeVisible();
  });
});
