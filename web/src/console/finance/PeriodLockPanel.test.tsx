import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { ApiCallError } from "../../api/ontologyActions";
import { ko } from "../../i18n/ko";
import { PeriodLockPanel } from "./PeriodLockPanel";

const copy = ko.console.modules.finance.periodLock;
const activeLock = {
  id: "11111111-1111-4111-8111-111111111111",
  domain: "accounting" as const,
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  reason: "월 마감 검토 완료",
  lockedAt: "2026-07-01T01:00:00Z",
};
const historicalLock = {
  ...activeLock,
  id: "22222222-2222-4222-8222-222222222222",
  periodStart: "2026-05-01",
  periodEnd: "2026-05-31",
  lockedAt: "2026-06-01T01:00:00Z",
  unlockedAt: "2026-06-02T01:00:00Z",
  unlockReason: "정정 전표 처리",
};

function renderPanel(
  getImpl?: (path: unknown, options: unknown) => Promise<unknown>,
) {
  const api = createConsoleApiClient("period-lock-test-token");
  const GET = vi
    .spyOn(api, "GET")
    .mockImplementation(
      (getImpl ??
        (() =>
          Promise.resolve({
            data: { items: [historicalLock, activeLock] },
          }))) as never,
    );
  const POST = vi
    .spyOn(api, "POST")
    .mockImplementation(() => Promise.resolve({ data: activeLock }) as never);
  return {
    api,
    GET,
    POST,
    ...render(<PeriodLockPanel api={api} authorityKey="user-a" />),
  };
}

describe("PeriodLockPanel", () => {
  afterEach(cleanup);
  it("loads accounting lock history newest-first and distinguishes active from immutable unlocked history", async () => {
    const { GET } = renderPanel();

    const region = await screen.findByRole("region", { name: copy.title });
    expect(within(region).getByText(copy.active)).toBeVisible();
    expect(within(region).getByText(copy.history)).toBeVisible();
    const rows = within(region).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("2026-06-01");
    expect(rows[2]).toHaveTextContent("2026-05-01");
    const headers = within(rows[0]).getAllByRole("columnheader");
    const activeCells = within(rows[1]).getAllByRole("cell");
    expect(headers.map((header) => header.textContent)).toEqual([
      copy.status, copy.domain, copy.start, copy.end, copy.reason,
      copy.lockedAt, copy.unlockedAt, copy.unlockReasonLabel, copy.actions,
    ]);
    expect(activeCells).toHaveLength(headers.length);
    expect(activeCells[6]).toBeEmptyDOMElement();
    expect(activeCells[7]).toBeEmptyDOMElement();
    expect(within(activeCells[8]).getByRole("button", { name: copy.unlock })).toBeVisible();
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/period-locks",
      expect.objectContaining({ params: { query: { domain: "accounting" } } }),
    );
  });

  it("validates accounting date range and reason locally, then posts the exact generated request body", async () => {
    const { POST } = renderPanel();
    await screen.findByRole("region", { name: copy.title });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: copy.create }));
    expect(POST).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(copy.errors.start);

    await user.type(screen.getByLabelText(copy.start), "2026-07-31");
    await user.type(screen.getByLabelText(copy.end), "2026-07-01");
    await user.type(screen.getByLabelText(copy.reason), "  결산 확정  ");
    await user.click(screen.getByRole("button", { name: copy.create }));
    expect(screen.getByRole("alert")).toHaveTextContent(copy.errors.range);
    expect(POST).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(copy.end));
    await user.type(screen.getByLabelText(copy.end), "2026-07-31");
    await user.click(screen.getByRole("button", { name: copy.create }));

    await waitFor(() => {
      expect(POST).toHaveBeenCalledWith("/api/v1/period-locks", {
        body: {
          domain: "accounting",
          periodStart: "2026-07-31",
          periodEnd: "2026-07-31",
          reason: "결산 확정",
        },
      });
    });
  });

  it("leaves rendered history untouched and reports a 409 conflict truthfully", async () => {
    const { POST } = renderPanel();
    POST.mockImplementationOnce(
      () => Promise.reject(new ApiCallError(409)) as never,
    );
    await screen.findByRole("region", { name: copy.title });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(copy.start), "2026-07-01");
    await user.type(screen.getByLabelText(copy.end), "2026-07-31");
    await user.type(screen.getByLabelText(copy.reason), "중복 확인");
    await user.click(screen.getByRole("button", { name: copy.create }));

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.conflict);
    expect(screen.getAllByText("월 마감 검토 완료")).toHaveLength(2);
  });

  it("requires an unlock reason, sends one unlock request, then refreshes immutable history", async () => {
    const api = createConsoleApiClient("period-lock-test-token");
    const GET = vi
      .spyOn(api, "GET")
      .mockResolvedValueOnce({ data: { items: [activeLock] } })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              ...activeLock,
              unlockedAt: "2026-07-02T01:00:00Z",
              unlockReason: "오류 정정",
            },
          ],
        },
      });
    const POST = vi
      .spyOn(api, "POST")
      .mockResolvedValue({
        data: {
          ...activeLock,
          unlockedAt: "2026-07-02T01:00:00Z",
          unlockReason: "오류 정정",
        },
      });
    render(<PeriodLockPanel api={api} authorityKey="user-a" />);
    await screen.findByText("월 마감 검토 완료");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: copy.unlock }));
    expect(POST).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      copy.errors.unlockReason,
    );
    await user.type(
      screen.getByLabelText(copy.unlockReason(activeLock.id)),
      "  오류 정정  ",
    );
    await user.click(screen.getByRole("button", { name: copy.unlock }));

    await waitFor(() => {
      expect(POST).toHaveBeenCalledTimes(1);
    });
    expect(POST).toHaveBeenCalledWith("/api/v1/period-locks/{lockId}/unlock", {
      params: { path: { lockId: activeLock.id } },
      body: { reason: "오류 정정" },
    });
    await waitFor(() => {
      expect(GET).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText(copy.unlocked)).toBeVisible();
  });

  it("aborts its active list request when session authority changes or the panel unmounts", async () => {
    const api = createConsoleApiClient("period-lock-test-token");
    const GET = vi
      .spyOn(api, "GET")
      .mockImplementation(() => new Promise(() => {}) as never);
    const view = render(<PeriodLockPanel api={api} authorityKey="user-a" />);
    await waitFor(() => {
      expect(GET).toHaveBeenCalledTimes(1);
    });
    const firstOptions = GET.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(firstOptions.signal).toBeInstanceOf(AbortSignal);
    view.rerender(<PeriodLockPanel api={api} authorityKey="user-b" />);
    expect(firstOptions.signal?.aborted).toBe(true);
    view.unmount();
  });
});
