import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WindowManagerProvider } from "./WindowManager";
import { PANEL_DEFAULT_WIDTH, QUADRANT_GAP } from "./windowModel";
import {
  usePinnedPanel,
  useWindowManager,
  type WindowManagerContextValue,
} from "./windowManagerContext";

const ENTRY = {
  id: "WO-2643",
  title: "작업지시 2643",
  render: () => <div data-testid="panel-body">본문</div>,
};

function Harness() {
  const { open } = usePinnedPanel();
  const manager = useWindowManager();
  return (
    <div data-testid="content">
      <button data-testid="open" type="button" onClick={() => { open(ENTRY); }}>
        열기
      </button>
      <button data-testid="reset" type="button" onClick={() => { manager.restoreDefault(); }}>
        초기화
      </button>
    </div>
  );
}

function renderHarness() {
  return render(
    <WindowManagerProvider>
      <Harness />
    </WindowManagerProvider>,
  );
}

function hostWrapper() {
  const host = screen.getByTestId("content").parentElement;
  if (!host) throw new Error("host wrapper missing");
  return host;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WindowManagerProvider", () => {
  it("pins an object as a right split and gives host content real padding", () => {
    renderHarness();

    expect(hostWrapper().style.paddingRight).toBe("");
    expect(screen.queryByRole("region", { name: "작업지시 2643" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open"));

    const panel = screen.getByRole("region", { name: "작업지시 2643" });
    expect(panel).toBeVisible();
    expect(screen.getByTestId("panel-body")).toBeVisible();
    // Wide viewport (jsdom innerWidth 1024 → not narrow): the split is a REAL
    // padding-right of panel width + the 2px quadrant gap, not an overlay.
    expect(hostWrapper().style.paddingRight).toBe(`${String(PANEL_DEFAULT_WIDTH + QUADRANT_GAP)}px`);
  });

  it("round-trips minimize → tray chip → restore", () => {
    renderHarness();
    fireEvent.click(screen.getByTestId("open"));

    fireEvent.click(screen.getByRole("button", { name: "최소화" }));

    // Panel gone, host padding released, a restorable tray chip present.
    expect(screen.queryByRole("region", { name: "작업지시 2643" })).not.toBeInTheDocument();
    expect(hostWrapper().style.paddingRight).toBe("");
    const tray = screen.getByRole("group", { name: "작업 트레이" });
    const chip = screen.getByRole("button", { name: "작업지시 2643 복원" });
    expect(tray).toContainElement(chip);

    fireEvent.click(chip);

    expect(screen.getByRole("region", { name: "작업지시 2643" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "작업 트레이" })).not.toBeInTheDocument();
  });

  it("closes the panel back to the default (grid) arrangement", () => {
    renderHarness();
    fireEvent.click(screen.getByTestId("open"));

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));

    expect(screen.queryByRole("region", { name: "작업지시 2643" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "작업 트레이" })).not.toBeInTheDocument();
    expect(hostWrapper().style.paddingRight).toBe("");
  });

  it("restore-default resets every window", () => {
    renderHarness();
    fireEvent.click(screen.getByTestId("open"));
    expect(screen.getByRole("region", { name: "작업지시 2643" })).toBeVisible();

    fireEvent.click(screen.getByTestId("reset"));

    expect(screen.queryByRole("region", { name: "작업지시 2643" })).not.toBeInTheDocument();
  });

  it("exposes the window controls as keyboard-operable, named buttons", () => {
    renderHarness();
    fireEvent.click(screen.getByTestId("open"));

    for (const name of ["최소화", "닫기"]) {
      const control = screen.getByRole("button", { name });
      // Native <button> is inherently keyboard operable (Enter/Space) + focusable.
      expect(control.tagName).toBe("BUTTON");
      expect(control).toHaveAccessibleName(name);
      control.focus();
      expect(control).toHaveFocus();
    }
  });
  const SECOND_ENTRY = {
    id: "WO-2644",
    title: "Work order 2644",
    render: () => <div data-testid="second-panel-body">second</div>,
  };

  function PersistenceHarness({
    onManager,
  }: {
    onManager?: (manager: WindowManagerContextValue) => void;
  }) {
    const manager = useWindowManager();
    const { register } = manager;
    useEffect(() => {
      register(ENTRY);
      register(SECOND_ENTRY);
    }, [register]);
    useEffect(() => {
      onManager?.(manager);
    }, [manager, onManager]);
    return (
      <div
        data-testid="persistence-content"
        data-panel-width={manager.panelWidth}
        data-pinned-id={manager.pinnedId ?? ""}
        data-minimized-ids={manager.minimizedIds.join(",")}
      >
        <button
          data-testid="persist-open-primary"
          type="button"
          onClick={() => {
            manager.open(ENTRY);
          }}
        >
          open primary
        </button>
        <button
          data-testid="persist-open-secondary"
          type="button"
          onClick={() => {
            manager.open(SECOND_ENTRY);
          }}
        >
          open secondary
        </button>
        <button
          data-testid="persist-minimize-primary"
          type="button"
          onClick={() => {
            manager.minimize(ENTRY.id);
          }}
        >
          minimize primary
        </button>
        <button
          data-testid="persist-set-width"
          type="button"
          onClick={() => {
            manager.setPanelWidth(600);
          }}
        >
          set width
        </button>
        <button
          data-testid="persist-save"
          type="button"
          onClick={() => {
            manager.saveLayout();
          }}
        >
          save
        </button>
      </div>
    );
  }

  function renderPersistence(
    authorityPartition: string | undefined,
    onManager?: (manager: WindowManagerContextValue) => void,
    retentionEnabled = true,
  ) {
    return render(
      <WindowManagerProvider
        authorityPartition={authorityPartition}
        retentionEnabled={retentionEnabled}
      >
        <PersistenceHarness onManager={onManager} />
      </WindowManagerProvider>,
    );
  }

  function partitionStorageKey(partition: string): string {
    return `oyatie.console.window.layout.v2.${encodeURIComponent(partition)}`;
  }

  it("persists window ids, pinned/minimized tray state, and width only within the exact incarnation", async () => {
    const partitionA1 = "tenant-a:incarnation-a1";
    const partitionA2 = "tenant-a:incarnation-a2";
    const partitionB = "tenant-b:incarnation-b1";

    const firstA = renderPersistence(partitionA1);
    fireEvent.click(screen.getByTestId("persist-open-primary"));
    fireEvent.click(screen.getByTestId("persist-minimize-primary"));
    fireEvent.click(screen.getByTestId("persist-open-secondary"));
    fireEvent.click(screen.getByTestId("persist-set-width"));
    fireEvent.click(screen.getByTestId("persist-save"));
    expect(
      JSON.parse(
        localStorage.getItem(partitionStorageKey(partitionA1)) ?? "null",
      ),
    ).toEqual({
      states: {
        [ENTRY.id]: "minimized",
        [SECOND_ENTRY.id]: "pinned",
      },
      panelWidth: 600,
    });
    firstA.unmount();

    const b = renderPersistence(partitionB);
    expect(screen.getByTestId("persistence-content")).toHaveAttribute(
      "data-pinned-id",
      "",
    );
    expect(screen.getByTestId("persistence-content")).toHaveAttribute(
      "data-minimized-ids",
      "",
    );
    expect(screen.getByTestId("persistence-content")).toHaveAttribute(
      "data-panel-width",
      String(PANEL_DEFAULT_WIDTH),
    );
    b.unmount();

    const laterA = renderPersistence(partitionA2);
    expect(screen.getByTestId("persistence-content")).toHaveAttribute(
      "data-pinned-id",
      "",
    );
    expect(screen.getByTestId("persistence-content")).toHaveAttribute(
      "data-minimized-ids",
      "",
    );
    laterA.unmount();

    renderPersistence(partitionA1);
    await waitFor(() => {
      expect(
        screen.getByRole("region", { name: SECOND_ENTRY.title }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: new RegExp(ENTRY.title) }),
      ).toBeVisible();
      expect(screen.getByTestId("persistence-content")).toHaveAttribute(
        "data-panel-width",
        "600",
      );
    });
    expect(localStorage.getItem("oyatie.console.window.layout")).toBeNull();
  });

  it("keeps windows in memory while blank authority disables every storage read and write", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    renderPersistence("   ");
    expect(getItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("persist-open-primary"));
    fireEvent.click(screen.getByTestId("persist-set-width"));
    fireEvent.click(screen.getByTestId("persist-save"));
    expect(screen.getByRole("region", { name: ENTRY.title })).toBeVisible();
    expect(screen.getByTestId("persistence-content")).toHaveAttribute(
      "data-panel-width",
      "600",
    );
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(localStorage.getItem("oyatie.console.window.layout")).toBeNull();
  });

  it("does not disable in-memory interaction when persistence is unavailable", () => {
    renderPersistence(undefined, undefined, false);
    fireEvent.click(screen.getByTestId("persist-open-primary"));
    fireEvent.click(screen.getByTestId("persist-set-width"));
    expect(screen.getByRole("region", { name: ENTRY.title })).toBeVisible();
    expect(screen.getByTestId("persistence-content")).toHaveAttribute(
      "data-panel-width",
      "600",
    );
    expect(localStorage.length).toBe(0);
  });

  it("does not let a retained retired-partition writer touch storage", async () => {
    let retained: WindowManagerContextValue | undefined;
    const a = renderPersistence("tenant-a:incarnation-a", (manager) => {
      retained = manager;
    });
    await waitFor(() => {
      expect(retained).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("persist-open-primary"));
    fireEvent.click(screen.getByTestId("persist-save"));
    a.unmount();

    const setItem = vi.spyOn(Storage.prototype, "setItem");
    retained?.saveLayout();
    expect(setItem).not.toHaveBeenCalled();
    renderPersistence("tenant-b:incarnation-b");
    expect(screen.getByTestId("persistence-content")).toHaveAttribute(
      "data-pinned-id",
      "",
    );
  });

  it("keeps simultaneous StrictMode roots isolated by provider incarnation", () => {
    const first = render(
      <StrictMode>
        <WindowManagerProvider authorityPartition="tenant-a:root-a">
          <PersistenceHarness />
        </WindowManagerProvider>
      </StrictMode>,
    );
    const second = render(
      <StrictMode>
        <WindowManagerProvider authorityPartition="tenant-a:root-b">
          <PersistenceHarness />
        </WindowManagerProvider>
      </StrictMode>,
    );
    fireEvent.click(
      within(first.container).getByTestId("persist-open-primary"),
    );
    fireEvent.click(within(first.container).getByTestId("persist-save"));
    expect(
      within(first.container).getByTestId("persistence-content"),
    ).toHaveAttribute("data-pinned-id", ENTRY.id);
    expect(
      within(second.container).getByTestId("persistence-content"),
    ).toHaveAttribute("data-pinned-id", "");
    expect(
      localStorage.getItem(partitionStorageKey("tenant-a:root-a")),
    ).not.toBeNull();
    expect(
      localStorage.getItem(partitionStorageKey("tenant-a:root-b")),
    ).toBeNull();
  });
});
