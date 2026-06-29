import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WallBoard } from "./WallBoard";
import { kpiReport, workOrderListItems } from "../../test/fixtures";

afterEach(() => {
  vi.useRealTimers();
});

describe("WallBoard", () => {
  it("shows a low-density exception strip and auto-refreshes on the configured interval", () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();

    render(
      <WallBoard
        isLoading={false}
        now={new Date("2026-06-12T12:00:00Z")}
        refreshIntervalMs={5_000}
        report={kpiReport}
        workOrders={workOrderListItems}
        onRefresh={onRefresh}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "일일현황 월보드" }),
    ).toBeVisible();
    expect(screen.getByText("미배정 긴급")).toBeVisible();
    expect(screen.getByText("승인 대기")).toBeVisible();
    expect(screen.getByText("목표 초과")).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "월보드 관련 화면" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "운영 현황" })).toHaveAttribute(
      "href",
      "/ops",
    );
    expect(screen.getByRole("link", { name: "지원 티켓" })).toHaveAttribute(
      "href",
      "/support",
    );
    expect(screen.getAllByText("1")[0]).toBeVisible();

    vi.advanceTimersByTime(5_000);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
