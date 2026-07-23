import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";

import { AuthTestProvider } from "../../test/AuthTestProvider";
import type { AuthSession } from "../../context/auth";
import type { ConsoleApiClient } from "../../api/client";
import { ConsoleApp } from "../ConsoleApp";
import { MOUNTED_SCREEN_KEYS } from "./nav";
import { Sidebar } from "./Sidebar";
import type { ThemeMode } from "./theme";

const markConsoleRoute = vi.fn<(screen: string) => void>();
const server = setupServer(
  http.get("*/api/v1/ontology/object-types", () => HttpResponse.json([])),
  http.get("*/api/v1/workflow-studio/definitions", () => HttpResponse.json({ items: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

vi.mock("../rum/rum", () => ({
  initConsoleRum: () => () => {},
  markConsoleRoute: (screen: string) => {
    markConsoleRoute(screen);
  },
}));

function RouterProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-router-location>{`${location.pathname}${location.search}${location.hash}`}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        history back
      </button>
      <button type="button" onClick={() => void navigate(1)}>
        history forward
      </button>
    </>
  );
}

function renderConsole(session: AuthSession, initialEntries: string[] = ["/console"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthTestProvider session={session}>
        <ConsoleApp screenKeys={MOUNTED_SCREEN_KEYS} />
      </AuthTestProvider>
      <RouterProbe />
    </MemoryRouter>,
  );
}

const ADMIN: AuthSession = {
  access_token: "t",
  display_name: "전성진",
  roles: ["ADMIN"],
  org_id: "org-1",
};

const SUPER_ADMIN: AuthSession = {
  ...ADMIN,
  roles: ["SUPER_ADMIN"],
};

function stubViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    matches:
      (query === "(max-width: 767px)" && width <= 767) ||
      (query === "(max-width: 1279px)" && width <= 1279),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList);
}

describe("ConsoleShell chrome", () => {
  beforeEach(() => {
    markConsoleRoute.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the grouped nav, topbar and comms rail", () => {
    renderConsole(ADMIN);
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getByRole("button", { name: "통합 개요" })).toBeInTheDocument();
    // group header
    expect(within(nav).getByText("개요")).toBeInTheDocument();
    // topbar identity + scope
    expect(screen.getByText("전성진")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "범위 선택" })).toBeInTheDocument();
    // comms rail — the single "커뮤니케이션" complementary landmark, unchanged
    // from #459's dedupe
    expect(screen.getByRole("complementary", { name: "커뮤니케이션" })).toBeInTheDocument();
    // screen body slot
    expect(screen.getByLabelText("화면 본문")).toBeInTheDocument();
  });

  it("identity chip renders person + team · role from the self-profile (never a raw dev label)", async () => {
    // A dev-auth session with no JWT `name`: the chip must resolve the person
    // and team from GET /api/v1/users/me, not fall back to a debug string.
    const api = {
      GET: vi.fn().mockResolvedValue({
        data: { display_name: "전성진", team: "MANAGEMENT", employee_company: "KnL" },
      }),
    } as unknown as ConsoleApiClient;
    render(
      <MemoryRouter>
        <AuthTestProvider
          session={{ access_token: "t", roles: ["ADMIN"], org_id: "org-1" }}
          overrides={{ api }}
        >
          <ConsoleApp screenKeys={MOUNTED_SCREEN_KEYS} />
        </AuthTestProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("전성진")).toBeInTheDocument();
    // second line: team label · role label (관리 · 관리자), joined — no "dev:" text
    expect(await screen.findByText("관리 · 관리자")).toBeInTheDocument();
    expect(screen.queryByText(/dev:/)).not.toBeInTheDocument();
  });

  it("comms rail is expanded by default on every screen, and the toggle collapses/expands it", () => {
    renderConsole(ADMIN);
    const rail = document.querySelector("[data-cshell-rail]");
    expect(rail).toHaveAttribute("data-cshell-rail-open", "true");
    // Expanded chrome: the collapse control + group icon glyphs are gone,
    // replaced by the panel title and its own collapse button.
    expect(screen.getByRole("button", { name: "커뮤니케이션 접기" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "커뮤니케이션 접기" }));
    expect(rail).not.toHaveAttribute("data-cshell-rail-open");
    expect(screen.getByRole("button", { name: "커뮤니케이션 펼치기" })).toBeInTheDocument();
    // still a single landmark, still present, just the collapsed icon strip now
    expect(screen.getByRole("complementary", { name: "커뮤니케이션" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "커뮤니케이션 펼치기" }));
    expect(rail).toHaveAttribute("data-cshell-rail-open", "true");
  });

  it("switching the active screen keeps the comms rail expanded (shell-level, not per-screen)", () => {
    renderConsole(ADMIN);
    const rail = document.querySelector("[data-cshell-rail]");
    expect(rail).toHaveAttribute("data-cshell-rail-open", "true");

    fireEvent.click(screen.getByRole("button", { name: "감사 로그" }));
    expect(rail).toHaveAttribute("data-cshell-rail-open", "true");
  });

  it("opens a server-linked messenger mention in the canonical registered screen URL", async () => {
    server.use(
      http.get("*/api/v1/me/notifications", () =>
        HttpResponse.json({
          items: [
            {
              id: "mention-1",
              recipient_user_id: "u1",
              category: "메신저",
              kind: "mention",
              text: "배차 관제에서 회원님을 멘션했습니다",
              link: { type: "object", kind: "messenger_thread", id: "thread-channel" },
              unread: true,
              created_at: "2026-07-03T08:50:00Z",
              read_at: null,
              resolved_at: null,
            },
          ],
        }),
      ),
      http.get("*/api/v1/mail/threads", () => HttpResponse.json([])),
    );
    renderConsole(ADMIN, ["/console/audit"]);

    await userEvent.click(
      await screen.findByRole("button", { name: "배차 관제에서 회원님을 멘션했습니다" }),
    );

    await waitFor(() => {
      expect(document.querySelector("[data-router-location]")).toHaveTextContent(
        "/console/messenger?thread=thread-channel",
      );
    });
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
    expect(document.querySelector("[data-router-location]")).toHaveTextContent("/console/audit");
    expect(markConsoleRoute).toHaveBeenCalledWith("audit");
  });

  it("restores a shipped authorized screen from its URL on refresh", () => {
    renderConsole(ADMIN, ["/console/audit"]);
    expect(screen.getByRole("button", { name: "감사 로그" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByLabelText("화면 본문")).toHaveAttribute("data-cshell-screen", "audit");
    expect(markConsoleRoute).toHaveBeenCalledWith("audit");
  });

  it("tracks browser back and forward without emitting duplicate route samples", async () => {
    renderConsole(ADMIN, ["/console/overview"]);
    expect(screen.getByLabelText("화면 본문")).toHaveAttribute("data-cshell-screen", "overview");

    await userEvent.click(screen.getByRole("button", { name: "감사 로그" }));
    expect(screen.getByLabelText("화면 본문")).toHaveAttribute("data-cshell-screen", "audit");

    await userEvent.click(screen.getByRole("button", { name: "history back" }));
    await waitFor(() => {
      expect(screen.getByLabelText("화면 본문")).toHaveAttribute(
        "data-cshell-screen",
        "overview",
      );
    });

    await userEvent.click(screen.getByRole("button", { name: "history forward" }));
    await waitFor(() => {
      expect(screen.getByLabelText("화면 본문")).toHaveAttribute("data-cshell-screen", "audit");
    });
    expect(markConsoleRoute.mock.calls.map(([route]) => route)).toEqual([
      "overview",
      "audit",
      "overview",
      "audit",
    ]);
  });

  it("resets the workflow tab after monitor → Scheduled side menu → Workflow side menu", async () => {
    renderConsole(SUPER_ADMIN, ["/console/workflow?keep=1#anchor"]);

    expect(
      await screen.findByRole("tab", { name: "워크플로", selected: true }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "분석·감시" }));
    expect(document.querySelector("[data-router-location]")?.textContent).toBe(
      "/console/workflow?keep=1&tab=monitors#anchor",
    );

    await userEvent.click(screen.getByRole("button", { name: "예약 작업" }));
    await waitFor(() => {
      expect(document.querySelector("[data-router-location]")?.textContent).toBe(
        "/console/scheduled?keep=1#anchor",
      );
      expect(screen.getByRole("tab", { name: "예약" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    await userEvent.click(screen.getByRole("button", { name: "워크플로 스튜디오" }));
    await waitFor(() => {
      expect(document.querySelector("[data-router-location]")?.textContent).toBe(
        "/console/workflow?keep=1#anchor",
      );
      expect(screen.getByRole("tab", { name: "워크플로" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("replaces invalid, unshipped, and unauthorized URL screens with the safe default", async () => {
    for (const destination of ["unknown", "hr", "policy"]) {
      const view = renderConsole(ADMIN, [`/console/${destination}?keep=1#anchor`]);
      expect(screen.getByLabelText("화면 본문")).toHaveAttribute(
        "data-cshell-screen",
        "overview",
      );
      await waitFor(() => {
        expect(document.querySelector("[data-router-location]")).toHaveTextContent(
          "/console/overview?keep=1#anchor",
        );
      });
      view.unmount();
    }
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

  it("uses a compact, non-dominant comms rail at tablet widths", () => {
    stubViewport(1024);
    renderConsole(ADMIN);

    const rail = document.querySelector("[data-cshell-rail]");
    expect(rail).not.toHaveAttribute("data-cshell-rail-open");
    expect(screen.getByRole("button", { name: "커뮤니케이션 펼치기" })).toBeInTheDocument();
  });

  it("keeps the 768px tablet composition and switches to modal drawers at 767px", async () => {
    stubViewport(768);
    const tablet = renderConsole(ADMIN);
    expect(screen.queryByRole("button", { name: "메뉴 열기" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-cshell-rail]")).not.toHaveAttribute(
      "data-cshell-rail-open",
    );
    tablet.unmount();

    stubViewport(767);
    renderConsole(ADMIN);
    const sidebar = document.querySelector("[data-cshell-sidebar]");
    expect(sidebar).toHaveAttribute("inert");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector("[data-cshell-rail]")).toHaveAttribute("inert");

    const opener = screen.getByRole("button", { name: "메뉴 열기" });
    const outside = screen.getByLabelText("검색 팔레트", { selector: "button" });
    await userEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "주 메뉴" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.querySelector("main")).toHaveAttribute("inert");
    const themeButton = within(dialog).getByRole("button", { name: "밝은 테마" });
    expect(themeButton).toHaveFocus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "검색 팔레트" })).not.toBeInTheDocument();
    expect(themeButton).toHaveFocus();
    expect(themeButton).toHaveStyle({ width: "44px", height: "44px" });
    expect(within(dialog).getByRole("button", { name: "통합 개요" })).toHaveStyle({
      minHeight: "44px",
    });
    expect(within(dialog).getByRole("button", { name: "메뉴 접기" })).toHaveStyle({
      minHeight: "44px",
    });

    outside.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(themeButton).toHaveFocus();

    await userEvent.click(screen.getByLabelText("패널 닫기"));
    expect(opener).toHaveFocus();
    expect(sidebar).toHaveAttribute("inert");
  });

  it.each([390, 320])("keeps mobile shell controls inside a %ipx viewport", async (width) => {
    stubViewport(width);
    renderConsole(ADMIN);
    const root = document.querySelector("[data-cshell-root]");
    expect(root).toHaveStyle({ overflowX: "hidden" });

    await userEvent.click(screen.getByRole("button", { name: "커뮤니케이션 열기" }));
    const rail = screen.getByRole("dialog", { name: "커뮤니케이션" });
    const close = within(rail).getByRole("button", { name: "커뮤니케이션 접기" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog", { name: "검색 팔레트" })).not.toBeInTheDocument();
    expect(close).toHaveFocus();
    expect(rail).toHaveStyle({ width: "86vw", maxWidth: "320px" });
    expect(close).toHaveStyle({
      width: "44px",
      height: "44px",
    });
  });

  it("opens exclusive mobile drawers, locks scrolling, returns focus, and preserves route state", async () => {
    stubViewport(390);
    renderConsole(ADMIN, ["/console/audit?keep=1#anchor"]);

    const menu = screen.getByRole("button", { name: "메뉴 열기" });
    const comms = screen.getByRole("button", { name: "커뮤니케이션 열기" });
    await userEvent.click(menu);
    const sidebar = document.querySelector("[data-cshell-sidebar]");
    expect(sidebar).toHaveAttribute("data-cshell-drawer-open", "true");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(sidebar).not.toHaveAttribute("data-cshell-drawer-open");
    });
    expect(menu).toHaveFocus();

    await userEvent.click(menu);
    await userEvent.click(screen.getByLabelText("패널 닫기"));
    expect(menu).toHaveFocus();

    await userEvent.click(comms);
    expect(sidebar).not.toHaveAttribute("data-cshell-drawer-open");
    expect(sidebar).toHaveAttribute("inert");
    expect(document.querySelector("[data-cshell-rail]")).toHaveAttribute(
      "data-cshell-drawer-open",
      "true",
    );

    await userEvent.click(screen.getByLabelText("패널 닫기"));
    expect(document.body.style.overflow).toBe("");
    expect(comms).toHaveFocus();

    await userEvent.click(menu);
    await userEvent.click(screen.getByRole("button", { name: "통합 개요" }));
    await waitFor(() => {
      expect(document.querySelector("[data-router-location]")).toHaveTextContent(
        "/console/overview?keep=1#anchor",
      );
    });
    expect(sidebar).not.toHaveAttribute("data-cshell-drawer-open");
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
