import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SelfServiceAttendancePanel } from "./SelfServiceAttendancePanel";
import { SelfServiceAttendanceTransportError, type SelfServiceAttendanceApi } from "./selfServiceAttendanceApi";

const item = { id: "db-private-id", code: "AT-31", kind: "LATE" as const, status: "OPEN" as const, work_date: "2026-07-12", occurred_at: "2026-07-12T09:02:00+09:00", detail: "출근 기록 확인 필요", evidence: [{ name: "출입기록", size: "24KB" }], resolution: undefined, created_at: "2026-07-12T09:03:00+09:00" };
const page = { items: [item], total: 126, limit: 50, offset: 0 };
const week = { status: "available" as const, projection: { week_start: "2026-07-20", current_hours: 38, projected_hours: 46, tone: "WARN" as const, acknowledged_at: "2026-07-22T08:00:00+09:00" } };
function makeApi(overrides: Partial<SelfServiceAttendanceApi> = {}): SelfServiceAttendanceApi { return { listOwnExceptions: vi.fn().mockResolvedValue(page), getOwnWeek52: vi.fn().mockResolvedValue(week), ...overrides }; }
function renderPanel(api = makeApi(), active = true, sessionIdentity = "session-a") { return { api, ...render(<SelfServiceAttendancePanel api={api} active={active} sessionIdentity={sessionIdentity} now={() => new Date("2026-07-24T12:00:00Z")} />) }; }

describe("SelfServiceAttendancePanel", () => {
  it("uses the exact own-resource contract in parallel, KST Monday, OPEN and 50 paging", async () => {
    const listOwnExceptions = vi.fn().mockResolvedValue(page); const getOwnWeek52 = vi.fn().mockResolvedValue(week); const api = makeApi({ listOwnExceptions, getOwnWeek52 }); renderPanel(api);
    await waitFor(() => { expect(listOwnExceptions).toHaveBeenCalledWith({ month: "2026-07", status: "OPEN", limit: 50, offset: 0 }, expect.any(AbortSignal)); });
    expect(getOwnWeek52).toHaveBeenCalledWith("2026-07-20", expect.any(AbortSignal));
    expect(await screen.findByText("미처리 126")).toBeVisible();
    const query = listOwnExceptions.mock.calls[0][0] as Record<string, unknown>;
    ["branch_id", "employee_id", "actor_id", "manager_id"].forEach((key) => { expect(query).not.toHaveProperty(key); });
  });

  it("renders the full DTO detail without DB IDs and returns keyboard focus", async () => {
    const api = makeApi(); renderPanel(api); const row = await screen.findByRole("button", { name: /출근 기록 확인 필요/ });
    row.focus(); await userEvent.keyboard("{Enter}"); const dialog = await screen.findByRole("dialog", { name: "예외 상세" });
    expect(within(dialog).getByText(/출입기록/)).toBeVisible(); expect(screen.queryByText("db-private-id")).toBeNull();
    await userEvent.keyboard("{Escape}"); await waitFor(() => { expect(row).toHaveFocus(); });
  });

  it("resets a changed month to OPEN and replaces stale rows with loading", async () => {
    let resolveMonth: ((value: typeof page) => void) | undefined; const pendingMonth = new Promise<typeof page>((done) => { resolveMonth = done; }); const listOwnExceptions = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(new Promise(() => undefined)).mockReturnValueOnce(pendingMonth); const api = makeApi({ listOwnExceptions }); renderPanel(api); await screen.findByRole("button", { name: /출근 기록 확인 필요/ });
    await userEvent.click(screen.getByRole("button", { name: "처리됨" }));
    await waitFor(() => { expect(listOwnExceptions).toHaveBeenLastCalledWith({ month: "2026-07", status: "RESOLVED", limit: 50, offset: 0 }, expect.any(AbortSignal)); });
    await userEvent.click(screen.getByRole("button", { name: "이전 달" }));
    expect(screen.getByRole("status")).toHaveTextContent("불러오는 중");
    resolveMonth?.(page);
    await waitFor(() => { expect(listOwnExceptions).toHaveBeenLastCalledWith({ month: "2026-06", status: "OPEN", limit: 50, offset: 0 }, expect.any(AbortSignal)); });
  });

  it("appends an exact next page and preserves first-page count", async () => {
    const listOwnExceptions = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce({ ...page, items: [{ ...item, id: "second", code: "AT-32" }], offset: 50 });
    const api = makeApi({ listOwnExceptions }); renderPanel(api); await screen.findByText("미처리 126");
    await userEvent.click(screen.getByRole("button", { name: "더 보기" }));
    await waitFor(() => { expect(listOwnExceptions).toHaveBeenLastCalledWith({ month: "2026-07", status: "OPEN", limit: 50, offset: 50 }, expect.any(AbortSignal)); });
    expect(await screen.findByText("2 / 126")).toBeVisible();
  });

  it("keeps successful exceptions while Week52 fails, retries its pane, and shows 403 distinctly", async () => {
    const getOwnWeek52 = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(week); const api = makeApi({ getOwnWeek52 }); renderPanel(api);
    expect(await screen.findByRole("button", { name: /출근 기록 확인 필요/ })).toBeVisible(); const alert = await screen.findByRole("alert"); await userEvent.click(within(alert).getByRole("button", { name: "다시 시도" })); expect(await screen.findByRole("strong")).toHaveTextContent("38.0시간");
    const denied = makeApi({ listOwnExceptions: vi.fn().mockRejectedValue(new SelfServiceAttendanceTransportError("no", 403)) }); const { rerender } = renderPanel(denied, true, "session-denied");
    rerender(<SelfServiceAttendancePanel api={denied} active sessionIdentity="session-denied" now={() => new Date("2026-07-24T12:00:00Z")} />); expect(await screen.findByText("권한 없음")).toBeVisible();
  });

  it("fails closed for impossible or non-finite Week52 and uses current hours for bar semantics", async () => {
    const bad = makeApi({ getOwnWeek52: vi.fn().mockResolvedValue({ status: "available", projection: { ...week.projection, current_hours: Number.NaN } }) }); const { rerender } = renderPanel(bad); expect(await screen.findByRole("alert")).toBeVisible();
    const good = makeApi(); rerender(<SelfServiceAttendancePanel api={good} active sessionIdentity="new" now={() => new Date("2026-07-24T12:00:00Z")} />); const bar = await screen.findByRole("progressbar"); expect(bar).toHaveAttribute("aria-valuenow", "38"); expect(screen.getByText("주의")).toBeVisible();
  });

  it("clears data and issues no calls when inactive or session identity is removed", async () => {
    const listOwnExceptions = vi.fn().mockResolvedValue(page); const api = makeApi({ listOwnExceptions }); const { rerender } = renderPanel(api, false); expect(listOwnExceptions).not.toHaveBeenCalled();
    rerender(<SelfServiceAttendancePanel api={api} active sessionIdentity="session" now={() => new Date("2026-07-24T12:00:00Z")} />); await screen.findByRole("button", { name: /출근 기록 확인 필요/ });
    rerender(<SelfServiceAttendancePanel api={api} active={false} sessionIdentity={undefined} now={() => new Date("2026-07-24T12:00:00Z")} />); expect(screen.queryByRole("button", { name: /출근 기록 확인 필요/ })).toBeNull();
  });
});
