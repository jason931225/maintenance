import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { MyWorkBody } from "./MyWorkBody";
import type { MyWorkApi, TodoSummary } from "./myWorkApi";
import { myWorkStrings, type ActionInboxItem, type ActionInboxResponse } from "./myWorkModel";

const S = myWorkStrings();
const NOW = new Date("2026-07-08T09:00:00Z"); // a Wednesday

function item(over: Partial<ActionInboxItem> & Pick<ActionInboxItem, "kind" | "id">): ActionInboxItem {
  return {
    kind: over.kind,
    id: over.id,
    urg: "wait",
    ref: "R-1",
    title: "t",
    dueTone: "neutral",
    links: [],
    done: false,
    ...over,
  };
}

const inbox: ActionInboxResponse = {
  total: 2,
  items: [
    item({ kind: "work", id: "work:1", title: "정비 점검", due: "2026-07-08T12:00:00Z", dueTone: "warn" }),
    item({ kind: "approval", id: "approval:1", title: "예산 결재", due: "2026-07-10T12:00:00Z" }),
  ],
};

function todo(over: Partial<TodoSummary> & Pick<TodoSummary, "id" | "text">): TodoSummary {
  return {
    owner_user_id: "00000000-0000-0000-0000-000000000001",
    scopes: [],
    links: [],
    done: false,
    created_at: "2026-07-08T00:00:00Z",
    updated_at: "2026-07-08T00:00:00Z",
    done_at: null,
    ...over,
  };
}

function stubApi(over?: Partial<MyWorkApi>): MyWorkApi {
  return {
    loadInbox: vi.fn().mockResolvedValue(inbox),
    loadTodos: vi.fn().mockResolvedValue([todo({ id: "t1", text: "보고서 초안" })]),
    createTodo: vi.fn().mockResolvedValue(undefined),
    setTodoDone: vi.fn().mockResolvedValue(undefined),
    deleteTodo: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function renderBody(api: MyWorkApi, props?: Partial<Parameters<typeof MyWorkBody>[0]>) {
  return render(
    <MemoryRouter>
      <MyWorkBody api={api} now={NOW} {...props} />
    </MemoryRouter>,
  );
}

describe("MyWorkBody", () => {
  it("renders personal todos and assigned action-inbox items", async () => {
    renderBody(stubApi());
    await screen.findByText("보고서 초안");
    expect(screen.getByText("정비 점검")).toBeInTheDocument();
    expect(screen.getByText("예산 결재")).toBeInTheDocument();
  });

  it("creates a todo and reloads the list", async () => {
    const createTodo = vi.fn().mockResolvedValue(undefined);
    const loadTodos = vi.fn().mockResolvedValue([todo({ id: "t1", text: "보고서 초안" })]);
    renderBody(stubApi({ createTodo, loadTodos }));
    await screen.findByText("보고서 초안");
    await userEvent.type(screen.getByLabelText(S.todos.addPlaceholder), "새 할 일");
    await userEvent.click(screen.getByRole("button", { name: S.todos.addButton }));
    await waitFor(() => {
      expect(createTodo).toHaveBeenCalledWith("새 할 일");
    });
    // loadTodos runs once on mount + once after create.
    expect(loadTodos.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("toggles a todo done", async () => {
    const setTodoDone = vi.fn().mockResolvedValue(undefined);
    renderBody(stubApi({ setTodoDone }));
    const checkbox = await screen.findByRole("checkbox", { name: S.todos.doneToggle("보고서 초안") });
    await userEvent.click(checkbox);
    await waitFor(() => {
      expect(setTodoDone).toHaveBeenCalledWith("t1", true);
    });
  });

  it("deletes a todo", async () => {
    const deleteTodo = vi.fn().mockResolvedValue(undefined);
    renderBody(stubApi({ deleteTodo }));
    await screen.findByText("보고서 초안");
    await userEvent.click(screen.getByRole("button", { name: S.todos.deleteLabel("보고서 초안") }));
    await waitFor(() => {
      expect(deleteTodo).toHaveBeenCalledWith("t1");
    });
  });

  it("reloads todos with done included when 완료 항목 표시 is checked", async () => {
    const loadTodos = vi.fn().mockResolvedValue([todo({ id: "t1", text: "보고서 초안" })]);
    renderBody(stubApi({ loadTodos }));
    await screen.findByText("보고서 초안");
    await userEvent.click(screen.getByLabelText(S.todos.showDone));
    await waitFor(() => {
      expect(loadTodos).toHaveBeenCalledWith(true);
    });
  });

  it("filters assigned items to a clicked day using real due dates", async () => {
    renderBody(stubApi());
    await screen.findByText("정비 점검");
    // Wednesday 8th has the 정비 point-check due; clicking Thursday 9th (no due
    // item) empties the list.
    const assigned = screen.getByLabelText(S.assigned.title, { selector: "section" });
    await userEvent.click(within(assigned).getByRole("button", { name: /목 .*9/ }));
    await screen.findByText(S.assigned.empty);
    // Clicking Wednesday 8th brings the 정비 item back.
    await userEvent.click(within(assigned).getByRole("button", { name: /수 .*8/ }));
    await screen.findByText("정비 점검");
  });

  it("drills an assigned item via onOpen", async () => {
    const onOpen = vi.fn();
    renderBody(stubApi(), { onOpen });
    await screen.findByText("정비 점검");
    const workRow = screen.getByText("정비 점검").closest("li");
    await userEvent.click(within(workRow as HTMLElement).getByRole("button", { name: S.assigned.open }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "work:1" }));
  });

  it("surfaces an inbox error with retry", async () => {
    const api = stubApi({
      loadInbox: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(inbox),
    });
    renderBody(api);
    const alerts = await screen.findAllByRole("alert");
    const inboxAlert = alerts.find((a) => within(a).queryByRole("button", { name: S.retry }));
    await userEvent.click(within(inboxAlert as HTMLElement).getByRole("button", { name: S.retry }));
    await screen.findByText("정비 점검");
  });
});
