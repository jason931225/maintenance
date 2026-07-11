import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import { AuthTestProvider } from "../../test/AuthTestProvider";
import type { AuthSession } from "../../context/auth";
import { ConsoleApp } from "../ConsoleApp";
import { Sidebar } from "./Sidebar";
import type { ThemeMode } from "./theme";

const markConsoleRoute = vi.fn();

vi.mock("../rum/rum", () => ({
  initConsoleRum: () => () => {},
  markConsoleRoute: (screen: string) => {
    markConsoleRoute(screen);
  },
}));

function renderConsole(session: AuthSession) {
  return render(
    <MemoryRouter>
      <AuthTestProvider session={session}>
        <ConsoleApp />
      </AuthTestProvider>
    </MemoryRouter>,
  );
}

const ADMIN: AuthSession = {
  access_token: "t",
  display_name: "전성진",
  roles: ["ADMIN"],
  org_id: "org-1",
};

describe("ConsoleShell chrome", () => {
  beforeEach(() => {
    markConsoleRoute.mockClear();
  });

  it("renders the grouped nav, topbar and comms-rail strip", () => {
    renderConsole(ADMIN);
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getByRole("button", { name: "통합 개요" })).toBeInTheDocument();
    // group header
    expect(within(nav).getByText("개요")).toBeInTheDocument();
    // topbar identity + scope
    expect(screen.getByText("전성진")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "범위 선택" })).toBeInTheDocument();
    // comms rail strip present (chrome only)
    expect(screen.getByRole("complementary", { name: "커뮤니케이션" })).toBeInTheDocument();
    // screen body slot
    expect(screen.getByLabelText("화면 본문")).toBeInTheDocument();
  });

  it("nav clicks switch the active screen (aria-current)", () => {
    renderConsole(ADMIN);
    const overview = screen.getByRole("button", { name: "통합 개요" });
    expect(overview).toHaveAttribute("aria-current", "true");

    const audit = screen.getByRole("button", { name: "감사 로그" });
    fireEvent.click(audit);
    expect(audit).toHaveAttribute("aria-current", "true");
    expect(overview).not.toHaveAttribute("aria-current");
    expect(screen.getByLabelText("화면 본문")).toHaveAttribute("data-cshell-screen", "audit");
    expect(markConsoleRoute).toHaveBeenCalledWith("audit");
  });

  it("collapses and expands the sidebar", () => {
    renderConsole(ADMIN);
    const sidebar = document.querySelector("[data-cshell-sidebar]");
    expect(sidebar).toHaveAttribute("data-collapsed", "false");

    fireEvent.click(screen.getByRole("button", { name: "메뉴 접기" }));
    expect(sidebar).toHaveAttribute("data-collapsed", "true");
    // collapsed hides group headers + labels, but still keeps the theme switch reachable.
    expect(screen.queryByText("개요")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "밝은 테마" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "메뉴 펼치기" }));
    expect(sidebar).toHaveAttribute("data-collapsed", "false");
  });

  it("opens the scope switcher listing only the union of authorized entities", async () => {
    renderConsole(ADMIN);
    fireEvent.click(screen.getByRole("button", { name: "범위 선택" }));
    const listbox = await screen.findByRole("listbox", { name: "운영 범위" });
    const options = within(listbox).getAllByRole("option");
    // With no live entities resolved, the switcher shows the union only — never
    // a literal all-orgs entry.
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("그룹 전체");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("dismisses the scope switcher when clicking outside", async () => {
    renderConsole(ADMIN);
    fireEvent.click(screen.getByRole("button", { name: "범위 선택" }));
    await screen.findByRole("listbox", { name: "운영 범위" });

    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "운영 범위" })).not.toBeInTheDocument();
    });
  });

  it("⌘K opens an empty palette surface; Esc closes it", async () => {
    renderConsole(ADMIN);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });
    const dialog = await screen.findByRole("dialog", { name: "검색 팔레트" });
    expect(within(dialog).getByPlaceholderText("사람·업무·문서 검색")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

describe("Sidebar badges", () => {
  const noop = () => {};
  const groups = [
    {
      labelKey: "console.shell.nav.groups.overview",
      labelId: "overview",
      items: [{ screen: "overview", labelKey: "console.shell.nav.overview", icon: "overview" as const }],
    },
  ];
  const base = {
    groups,
    activeScreen: "overview",
    theme: "system" as ThemeMode,
    onSelect: noop,
    onToggleCollapse: noop,
    onCycleTheme: noop,
  };

  it("renders a numeric pill when expanded", () => {
    render(<Sidebar {...base} collapsed={false} badges={{ overview: { count: 5, tone: "urgent" } }} />);
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("clamps to 99+ and renders a dot (no number) when collapsed", () => {
    const { rerender } = render(
      <Sidebar {...base} collapsed={false} badges={{ overview: { count: 150, tone: "neutral" } }} />,
    );
    expect(screen.getByText("99+")).toBeInTheDocument();

    rerender(
      <Sidebar {...base} collapsed badges={{ overview: { count: 150, tone: "neutral" } }} />,
    );
    expect(screen.queryByText("99+")).not.toBeInTheDocument();
  });
});
