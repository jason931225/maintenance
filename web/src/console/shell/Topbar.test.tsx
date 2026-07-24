import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    expect(
      screen.getByRole("button", { name: "커뮤니케이션 열기" }),
    ).toHaveAttribute("aria-controls", "console-comms-drawer");
    expect(
      screen.getByRole("button", { name: "커뮤니케이션 열기" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Topbar account menu", () => {
  it("replaces the inert identity chrome with an accessible logout menu", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn();
    const onLocalRoleSwitch = vi.fn();
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
        onLogout={onLogout}
        onLocalRoleSwitch={onLocalRoleSwitch}
        localRoleSwitchLabel="다른 계정으로 전환"
      />,
    );

    await user.click(screen.getByRole("button", { name: "사용자 메뉴" }));
    expect(screen.getByRole("menu")).toBeVisible();
    await user.click(
      screen.getByRole("menuitem", { name: "다른 계정으로 전환" }),
    );
    expect(onLocalRoleSwitch).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "사용자 메뉴" }));
    await user.click(screen.getByRole("menuitem", { name: "로그아웃" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

describe("Topbar local role switch containment", () => {
  it("does not render the local action when a callback lacks the DEV-only label", async () => {
    const user = userEvent.setup();
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
        onLogout={vi.fn()}
        onLocalRoleSwitch={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "사용자 메뉴" }));
    expect(
      screen.queryByRole("menuitem", { name: "다른 계정으로 전환" }),
    ).not.toBeInTheDocument();
  });
});

describe("Topbar account menu keyboard behavior", () => {
  it("focuses, roves, and restores focus on Escape, outside click, and actions", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn();
    const onLocalRoleSwitch = vi.fn();
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
        onLogout={onLogout}
        onLocalRoleSwitch={onLocalRoleSwitch}
        localRoleSwitchLabel="다른 계정으로 전환"
      />,
    );

    const trigger = screen.getByRole("button", { name: "사용자 메뉴" });
    await user.click(trigger);
    const switchItem = screen.getByRole("menuitem", {
      name: "다른 계정으로 전환",
    });
    const logoutItem = screen.getByRole("menuitem", { name: "로그아웃" });
    expect(switchItem).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(logoutItem).toHaveFocus();
    await user.keyboard("{Home}");
    expect(switchItem).toHaveFocus();
    await user.keyboard("{End}");
    expect(logoutItem).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(switchItem).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(
      screen.getByRole("menuitem", { name: "다른 계정으로 전환" }),
    );
    expect(onLocalRoleSwitch).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });
});
