import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Topbar } from "./Topbar";

describe("Topbar mobile drawer triggers", () => {
  it("exposes each drawer target and its expanded state", () => {
    render(
      <Topbar
        kbdLabel="Ctrl K"
        onOpenPalette={vi.fn()}
        scopeLabel="그룹 전체"
        scopeOptions={[]}
        selectedScopeId="__union__"
        scopeOpen={false}
        onScopeToggle={vi.fn()}
        onScopeClose={vi.fn()}
        onScopeSelect={vi.fn()}
        userName="전성진"
        userInitial="전"
        userRoleLabel="관리자"
        onOpenNavigation={vi.fn()}
        navigationDrawerOpen
        onOpenComms={vi.fn()}
        commsDrawerOpen={false}
      />,
    );

    expect(screen.getByRole("button", { name: "메뉴 열기" })).toHaveAttribute(
      "aria-controls",
      "console-navigation-drawer",
    );
    expect(screen.getByRole("button", { name: "메뉴 열기" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "커뮤니케이션 열기" })).toHaveAttribute(
      "aria-controls",
      "console-comms-drawer",
    );
    expect(screen.getByRole("button", { name: "커뮤니케이션 열기" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
