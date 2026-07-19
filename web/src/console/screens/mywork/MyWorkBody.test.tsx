import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { MyWorkBody } from "./MyWorkBody";
import type { MyWorkApi, TodoSummary } from "./myWorkApi";
import { myWorkStrings, type ActionInboxItem, type ActionInboxResponse } from "./myWorkModel";

const S = myWorkStrings();
const NOW = new Date("2026-07-08T09:00:00Z"); // a Wednesday

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

  it("refreshes the current done filter after a deferred create succeeds", async () => {
    const mutation = deferred<undefined>();
    const filterLoad = deferred<TodoSummary[]>();
    const refreshLoad = deferred<TodoSummary[]>();
    const loadTodos = vi
      .fn<(includeDone: boolean) => Promise<TodoSummary[]>>()
      .mockResolvedValueOnce([todo({ id: "active", text: "진행 중" })])
      .mockImplementation((includeDone) =>
        includeDone
          ? loadTodos.mock.calls.length === 2
            ? filterLoad.promise
            : refreshLoad.promise
          : Promise.resolve([todo({ id: "stale", text: "완료 제외" })]),
      );
    renderBody(stubApi({ loadTodos, createTodo: vi.fn(() => mutation.promise) }));

    await screen.findByText("진행 중");
    await userEvent.type(screen.getByLabelText(S.todos.addPlaceholder), "새 할 일");
    await userEvent.click(screen.getByRole("button", { name: S.todos.addButton }));
    await userEvent.click(screen.getByLabelText(S.todos.showDone));
    filterLoad.resolve([todo({ id: "done", text: "완료 포함", done: true })]);
    expect(await screen.findByText("완료 포함")).toBeVisible();

    mutation.resolve(undefined);
    await waitFor(() => {
      expect(loadTodos).toHaveBeenCalledTimes(3);
    });
    expect(loadTodos).toHaveBeenLastCalledWith(true);
    refreshLoad.resolve([todo({ id: "new", text: "새 할 일", done: true })]);
    expect(await screen.findByText("새 할 일")).toBeVisible();
    expect(screen.queryByText("완료 제외")).not.toBeInTheDocument();
  });

  it("refreshes the current done filter after a deferred toggle succeeds", async () => {
    const mutation = deferred<undefined>();
    const filterLoad = deferred<TodoSummary[]>();
    const refreshLoad = deferred<TodoSummary[]>();
    const loadTodos = vi
      .fn<(includeDone: boolean) => Promise<TodoSummary[]>>()
      .mockResolvedValueOnce([todo({ id: "active", text: "진행 중" })])
      .mockImplementation((includeDone) =>
        includeDone
          ? loadTodos.mock.calls.length === 2
            ? filterLoad.promise
            : refreshLoad.promise
          : Promise.resolve([todo({ id: "stale", text: "완료 제외" })]),
      );
    renderBody(stubApi({ loadTodos, setTodoDone: vi.fn(() => mutation.promise) }));

    await userEvent.click(
      await screen.findByRole("checkbox", { name: S.todos.doneToggle("진행 중") }),
    );
    await userEvent.click(screen.getByLabelText(S.todos.showDone));
    filterLoad.resolve([todo({ id: "active", text: "진행 중", done: true })]);
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: S.todos.doneToggle("진행 중") })).toBeChecked();
    });

    mutation.resolve(undefined);
    await waitFor(() => {
      expect(loadTodos).toHaveBeenCalledTimes(3);
    });
    expect(loadTodos).toHaveBeenLastCalledWith(true);
    refreshLoad.resolve([todo({ id: "active", text: "진행 중", done: true })]);
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: S.todos.doneToggle("진행 중") })).toBeChecked();
    });
  });

  it("refreshes the current done filter after a deferred delete succeeds", async () => {
    const mutation = deferred<undefined>();
    const filterLoad = deferred<TodoSummary[]>();
    const refreshLoad = deferred<TodoSummary[]>();
    const loadTodos = vi
      .fn<(includeDone: boolean) => Promise<TodoSummary[]>>()
      .mockResolvedValueOnce([todo({ id: "active", text: "삭제 대상" })])
      .mockImplementation((includeDone) =>
        includeDone
          ? loadTodos.mock.calls.length === 2
            ? filterLoad.promise
            : refreshLoad.promise
          : Promise.resolve([todo({ id: "stale", text: "삭제 대상" })]),
      );
    renderBody(stubApi({ loadTodos, deleteTodo: vi.fn(() => mutation.promise) }));

    await userEvent.click(
      await screen.findByRole("button", { name: S.todos.deleteLabel("삭제 대상") }),
    );
    await userEvent.click(screen.getByLabelText(S.todos.showDone));
    filterLoad.resolve([todo({ id: "done", text: "완료 항목", done: true })]);
    expect(await screen.findByText("완료 항목")).toBeVisible();

    mutation.resolve(undefined);
    await waitFor(() => {
      expect(loadTodos).toHaveBeenCalledTimes(3);
    });
    expect(loadTodos).toHaveBeenLastCalledWith(true);
    refreshLoad.resolve([todo({ id: "done", text: "완료 항목", done: true })]);
    await waitFor(() => {
      expect(screen.queryByText("삭제 대상")).not.toBeInTheDocument();
      expect(screen.getByText("완료 항목")).toBeVisible();
    });
  });

  it("keeps the current done-filter result when a deferred mutation fails", async () => {
    const mutation = deferred<undefined>();
    const filterLoad = deferred<TodoSummary[]>();
    const loadTodos = vi
      .fn<(includeDone: boolean) => Promise<TodoSummary[]>>()
      .mockResolvedValueOnce([todo({ id: "active", text: "진행 중" })])
      .mockImplementation((includeDone) =>
        includeDone
          ? filterLoad.promise
          : Promise.resolve([todo({ id: "stale", text: "완료 제외" })]),
      );
    renderBody(stubApi({ loadTodos, setTodoDone: vi.fn(() => mutation.promise) }));

    await userEvent.click(
      await screen.findByRole("checkbox", { name: S.todos.doneToggle("진행 중") }),
    );
    await userEvent.click(screen.getByLabelText(S.todos.showDone));
    filterLoad.resolve([todo({ id: "done", text: "완료 포함", done: true })]);
    expect(await screen.findByText("완료 포함")).toBeVisible();

    mutation.reject(new Error("mutation failed"));
    expect(await screen.findByRole("alert")).toHaveTextContent(S.todos.mutateFailed);
    expect(loadTodos).toHaveBeenCalledTimes(2);
    expect(screen.getByText("완료 포함")).toBeVisible();
    expect(screen.queryByText("완료 제외")).not.toBeInTheDocument();
  });

  it("ignores an older todo response after the done filter starts a newer load", async () => {
    const active = deferred<TodoSummary[]>();
    const withDone = deferred<TodoSummary[]>();
    const loadTodos = vi.fn((includeDone: boolean) => (includeDone ? withDone.promise : active.promise));
    renderBody(stubApi({ loadTodos }));

    await waitFor(() => {
      expect(loadTodos).toHaveBeenCalledWith(false);
    });
    await userEvent.click(screen.getByLabelText(S.todos.showDone));
    await waitFor(() => {
      expect(loadTodos).toHaveBeenCalledWith(true);
    });

    withDone.resolve([todo({ id: "new", text: "최신 완료 포함" })]);
    expect(await screen.findByText("최신 완료 포함")).toBeVisible();
    await act(async () => {
      active.resolve([todo({ id: "old", text: "오래된 미완료" })]);
      await active.promise;
    });

    await waitFor(() => {
      expect(screen.getByText("최신 완료 포함")).toBeVisible();
      expect(screen.queryByText("오래된 미완료")).not.toBeInTheDocument();
    });
  });

  it("ignores an older todo error after a newer load succeeds", async () => {
    const active = deferred<TodoSummary[]>();
    const withDone = deferred<TodoSummary[]>();
    const loadTodos = vi.fn((includeDone: boolean) => (includeDone ? withDone.promise : active.promise));
    renderBody(stubApi({ loadTodos }));

    await waitFor(() => {
      expect(loadTodos).toHaveBeenCalledWith(false);
    });
    await userEvent.click(screen.getByLabelText(S.todos.showDone));
    withDone.resolve([todo({ id: "new", text: "최신 목록" })]);
    expect(await screen.findByText("최신 목록")).toBeVisible();

    await act(async () => {
      active.reject(new Error("stale"));
      await active.promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(screen.getByText("최신 목록")).toBeVisible();
      expect(screen.queryByText(S.error)).not.toBeInTheDocument();
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

  it("synchronously withholds prior-api todo and inbox state", async () => {
    const apiA = stubApi({
      loadInbox: vi.fn().mockResolvedValue({
        total: 1,
        items: [item({ kind: "work", id: "a-work", title: "테넌트 A 업무" })],
      }),
      loadTodos: vi.fn().mockResolvedValue([todo({ id: "a-todo", text: "테넌트 A 할 일" })]),
    });
    const nextInbox = deferred<ActionInboxResponse>();
    const nextTodos = deferred<TodoSummary[]>();
    const apiB = stubApi({
      loadInbox: vi.fn(() => nextInbox.promise),
      loadTodos: vi.fn(() => nextTodos.promise),
    });
    const view = renderBody(apiA);

    expect(await screen.findByText("테넌트 A 할 일")).toBeVisible();
    expect(await screen.findByText("테넌트 A 업무")).toBeVisible();

    view.rerender(
      <MemoryRouter>
        <MyWorkBody api={apiB} now={NOW} />
      </MemoryRouter>,
    );

    expect(screen.queryByText("테넌트 A 할 일")).not.toBeInTheDocument();
    expect(screen.queryByText("테넌트 A 업무")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      nextInbox.resolve({ total: 0, items: [] });
      nextTodos.resolve([]);
      await Promise.all([nextInbox.promise, nextTodos.promise]);
    });
  });

  it("does not let an old-api create continuation refresh or replace new-api todos", async () => {
    const mutation = deferred<undefined>();
    const apiALoadTodos = vi
      .fn<() => Promise<TodoSummary[]>>()
      .mockResolvedValueOnce([todo({ id: "a", text: "테넌트 A 할 일" })])
      .mockResolvedValueOnce([todo({ id: "a-stale", text: "테넌트 A 오래된 새로고침" })]);
    const apiA = stubApi({
      loadTodos: apiALoadTodos,
      createTodo: vi.fn(() => mutation.promise),
    });
    const apiBLoadTodos = vi
      .fn<() => Promise<TodoSummary[]>>()
      .mockResolvedValue([todo({ id: "b", text: "테넌트 B 할 일" })]);
    const apiB = stubApi({ loadTodos: apiBLoadTodos });
    const view = renderBody(apiA);

    await screen.findByText("테넌트 A 할 일");
    await userEvent.type(screen.getByLabelText(S.todos.addPlaceholder), "A에서 만든 일");
    await userEvent.click(screen.getByRole("button", { name: S.todos.addButton }));

    view.rerender(
      <MemoryRouter>
        <MyWorkBody api={apiB} now={NOW} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("테넌트 B 할 일")).toBeVisible();

    await act(async () => {
      mutation.resolve(undefined);
      await mutation.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiALoadTodos).toHaveBeenCalledTimes(1);
    expect(apiBLoadTodos).toHaveBeenCalledTimes(1);
    expect(screen.getByText("테넌트 B 할 일")).toBeVisible();
    expect(screen.queryByText("테넌트 A 오래된 새로고침")).not.toBeInTheDocument();
  });

  it("does not let an old-api toggle continuation refresh or replace new-api todos", async () => {
    const mutation = deferred<undefined>();
    const apiALoadTodos = vi
      .fn<() => Promise<TodoSummary[]>>()
      .mockResolvedValueOnce([todo({ id: "a", text: "테넌트 A 토글 대상" })])
      .mockResolvedValueOnce([todo({ id: "a-stale", text: "테넌트 A 오래된 토글 새로고침" })]);
    const apiA = stubApi({
      loadTodos: apiALoadTodos,
      setTodoDone: vi.fn(() => mutation.promise),
    });
    const apiBLoadTodos = vi
      .fn<() => Promise<TodoSummary[]>>()
      .mockResolvedValue([todo({ id: "b", text: "테넌트 B 할 일" })]);
    const apiB = stubApi({ loadTodos: apiBLoadTodos });
    const view = renderBody(apiA);

    await userEvent.click(
      await screen.findByRole("checkbox", { name: S.todos.doneToggle("테넌트 A 토글 대상") }),
    );

    view.rerender(
      <MemoryRouter>
        <MyWorkBody api={apiB} now={NOW} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("테넌트 B 할 일")).toBeVisible();

    await act(async () => {
      mutation.resolve(undefined);
      await mutation.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiALoadTodos).toHaveBeenCalledTimes(1);
    expect(apiBLoadTodos).toHaveBeenCalledTimes(1);
    expect(screen.getByText("테넌트 B 할 일")).toBeVisible();
    expect(screen.queryByText("테넌트 A 오래된 토글 새로고침")).not.toBeInTheDocument();
  });

  it("does not let an old-api delete continuation refresh or replace new-api todos", async () => {
    const mutation = deferred<undefined>();
    const apiALoadTodos = vi
      .fn<() => Promise<TodoSummary[]>>()
      .mockResolvedValueOnce([todo({ id: "a", text: "테넌트 A 삭제 대상" })])
      .mockResolvedValueOnce([todo({ id: "a-stale", text: "테넌트 A 오래된 삭제 새로고침" })]);
    const apiA = stubApi({
      loadTodos: apiALoadTodos,
      deleteTodo: vi.fn(() => mutation.promise),
    });
    const apiBLoadTodos = vi
      .fn<() => Promise<TodoSummary[]>>()
      .mockResolvedValue([todo({ id: "b", text: "테넌트 B 할 일" })]);
    const apiB = stubApi({ loadTodos: apiBLoadTodos });
    const view = renderBody(apiA);

    await screen.findByText("테넌트 A 삭제 대상");
    await userEvent.click(
      screen.getByRole("button", { name: S.todos.deleteLabel("테넌트 A 삭제 대상") }),
    );

    view.rerender(
      <MemoryRouter>
        <MyWorkBody api={apiB} now={NOW} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("테넌트 B 할 일")).toBeVisible();

    await act(async () => {
      mutation.resolve(undefined);
      await mutation.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiALoadTodos).toHaveBeenCalledTimes(1);
    expect(apiBLoadTodos).toHaveBeenCalledTimes(1);
    expect(screen.getByText("테넌트 B 할 일")).toBeVisible();
    expect(screen.queryByText("테넌트 A 오래된 삭제 새로고침")).not.toBeInTheDocument();
  });
});
