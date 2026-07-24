import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { TokenComposer } from "../../components/console/TokenComposer";
import { OBJECT_DND_MIME } from "../../lib/objectDrag";
import { WorkOrderList } from "./WorkOrderList";
import { workOrderListItems } from "../../test/fixtures";

// A minimal store-backed DataTransfer — jsdom's is inert, so the drag source
// and drop target must share one that actually retains setData/getData.
function fakeDataTransfer(): DataTransfer {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
    get types() {
      return Object.keys(store);
    },
    effectAllowed: "none",
  } as unknown as DataTransfer;
}

// WorkOrderList rows deep-link to /work-orders/:id, so a router context is
// required to render the <Link>.
function renderList() {
  return render(
    <MemoryRouter>
      <WorkOrderList workOrders={workOrderListItems} />
    </MemoryRouter>,
  );
}

describe("WorkOrderList", () => {
  it("renders branch-scoped work orders from the read API schema", () => {
    renderList();

    expect(screen.getByRole("heading", { name: "작업지시 목록" })).toBeVisible();
    expect(screen.getByText("20260612-001")).toBeVisible();
    expect(screen.getByText("GTS25DE")).toBeVisible();
    expect(screen.getByText(/케이앤엘/)).toBeVisible();
    expect(screen.getByText(/2026-06-12 18:00/)).toBeVisible();
  });

  it("links each row to the work-order detail view", () => {
    renderList();

    expect(
      screen.getByRole("link", { name: "20260612-001" }),
    ).toHaveAttribute(
      "href",
      `/work-orders/${workOrderListItems[0].id}`,
    );
  });

  it("renders the site's representative contact with a tel link when present (#13)", () => {
    renderList();

    // The first work order's site has a registered contact (name + phone); the
    // phone renders as a single tel: link, and the second order's null contact
    // renders nothing.
    expect(screen.getByText(/현장담당 김씨/)).toBeVisible();
    const tel = screen.getByRole("link", { name: "010-2625-0987" });
    expect(tel).toHaveAttribute("href", "tel:010-2625-0987");
    expect(screen.getAllByRole("link", { name: /010-2625-0987/ })).toHaveLength(
      1,
    );
  });

  it("makes each row a drag source that a token composer resolves into a chip (AC1)", () => {
    renderList();
    const row = screen.getByText("20260612-001").closest("article");
    if (!row) throw new Error("work-order row not found");
    expect(row).toHaveAttribute("draggable", "true");

    // 1. Drag the real row — it writes the object payload onto the transfer.
    const transfer = fakeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: transfer });
    expect(transfer.getData(OBJECT_DND_MIME)).toContain("WO-20260612-001");

    // 2. Drop that SAME transfer on a real composer — the chip inserts + resolves.
    function Composer() {
      const [value, setValue] = useState("");
      return (
        <TokenComposer value={value} onChange={setValue} providers={{}} ariaLabel="작성" />
      );
    }
    render(<Composer />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");
    fireEvent.drop(textarea, { dataTransfer: transfer });

    expect(textarea.value).toContain("!WO-20260612-001");
    const preview = screen.getByTestId("token-composer-preview");
    expect(within(preview).getByRole("button", { name: /WO-20260612-001/ })).toBeInTheDocument();
  });
});
