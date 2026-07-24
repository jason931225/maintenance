import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AttendanceTransportError,
  type AttendanceException,
  type AttendanceTransport,
} from "./attendanceApi";
import { SubstitutionCandidateDialog } from "./SubstitutionCandidateDialog";

const gap: AttendanceException = {
  id: "exception-1", code: "AT-1", kind: "NO_SHOW", status: "OPEN",
  employee_id: "covered-1", employee_name: "최민석", work_date: "2026-07-23",
  occurred_at: "2026-07-23T06:00:00+09:00", detail: "06:00 상주 미출근",
  evidence: [], links: [], created_at: "2026-07-23T06:00:00+09:00",
};

function renderDialog(listSubstitutionCandidates: AttendanceTransport["listSubstitutionCandidates"]) {
  const onAssign = vi.fn();
  render(
    <SubstitutionCandidateDialog
      gap={gap}
      transport={{ listSubstitutionCandidates } as AttendanceTransport}
      busy={false}
      onClose={vi.fn()}
      onAssign={onAssign}
    />,
  );
  return { onAssign };
}

describe("SubstitutionCandidateDialog", () => {
  it("waits for a valid half-open window, aborts stale searches, and assigns the selected employee ID", async () => {
    const requests: AbortSignal[] = [];
    const listSubstitutionCandidates = vi.fn<AttendanceTransport["listSubstitutionCandidates"]>((query, signal) => {
      if (signal) requests.push(signal);
      return Promise.resolve({
        items: [{ employee_id: "worker-1", employee_name: query.search ? "박대근 검색" : "박대근", branch_id: "branch-1" }],
        total: 1, limit: query.limit, offset: query.offset,
      });
    });
    const { onAssign } = renderDialog(listSubstitutionCandidates);
    const dialog = screen.getByRole("dialog", { name: "대근 편성" });
    expect(listSubstitutionCandidates).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText("시작"), "09:00");
    expect(listSubstitutionCandidates).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText("종료"), "18:00");
    await waitFor(() => expect(listSubstitutionCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ covered_employee_id: "covered-1", cover_date: "2026-07-23", from_minutes: 540, to_minutes: 1080, limit: 25, offset: 0 }),
      expect.any(AbortSignal),
    ));

    await userEvent.type(within(dialog).getByLabelText("이름 검색"), "박");
    await waitFor(() => expect(requests.some((signal) => signal.aborted)).toBe(true));
    await userEvent.type(within(dialog).getByLabelText("현장"), "상주");
    await userEvent.type(within(dialog).getByLabelText("역할"), "경비");
    await userEvent.click(await within(dialog).findByRole("button", { name: "배정" }));
    expect(onAssign).toHaveBeenCalledWith(expect.objectContaining({
      worker_employee_id: "worker-1", covered_employee_id: "covered-1",
    }));
    expect(onAssign.mock.calls[0][0]).not.toHaveProperty("worker_name");
  });

  it("renders denied and retryable server-error candidate states", async () => {
    const listSubstitutionCandidates = vi.fn<AttendanceTransport["listSubstitutionCandidates"]>()
      .mockRejectedValueOnce(new AttendanceTransportError("denied", 403))
      .mockRejectedValueOnce(new AttendanceTransportError("failed", 500))
      .mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 });
    renderDialog(listSubstitutionCandidates);
    const dialog = screen.getByRole("dialog", { name: "대근 편성" });
    await userEvent.type(within(dialog).getByLabelText("시작"), "09:00");
    await userEvent.type(within(dialog).getByLabelText("종료"), "18:00");
    expect(await within(dialog).findByText("대근 가능 인원을 볼 권한이 없습니다.")).toBeVisible();
    await userEvent.type(within(dialog).getByLabelText("이름 검색"), "박");
    expect(await within(dialog).findByRole("button", { name: "다시 시도" })).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    expect(await within(dialog).findByText("배정 가능한 인원이 없습니다.")).toBeVisible();
  });
});
