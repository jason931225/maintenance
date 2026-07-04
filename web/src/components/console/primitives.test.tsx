import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  Chip,
  ConsoleToast,
  MonoRef,
  ObjectChip,
  SearchInput,
  SectionCard,
  StatBar,
  StatusChip,
} from "./primitives";

describe("console primitives", () => {
  it("renders dense chips from console tokens with a visible focus ring", () => {
    render(
      <Chip tone="accent" icon="pin">
        결재 대기
      </Chip>,
    );

    const chip = screen.getByText("결재 대기");
    expect(chip).toHaveClass("bg-console-accent-bg", "text-console-accent-tx");
    expect(chip).toHaveClass("focus-visible:ring-console-signal");
    expect(screen.getByTestId("console-icon-pin")).toBeInTheDocument();
  });

  it("maps status chips to semantic triads without raw color classes", () => {
    render(<StatusChip status="danger">반려</StatusChip>);

    expect(screen.getByText("반려")).toHaveClass(
      "border-console-danger-bd",
      "bg-console-danger-bg",
      "text-console-danger-tx",
    );
  });

  it("renders monospace references as clickable object links", async () => {
    const onOpen = vi.fn();
    render(<ObjectChip kind="approval" code="AP-3121" label="연차 승인" onOpen={onOpen} />);

    await userEvent.click(screen.getByRole("button", { name: "AP-3121 연차 승인" }));

    expect(onOpen).toHaveBeenCalledWith("AP-3121");
    expect(screen.getByText("AP")).toHaveClass("font-mono");
    expect(screen.getByText("AP-3121")).toHaveClass("font-mono");
  });

  it("keeps KPI strips compact and tokenized", () => {
    render(
      <StatBar
        items={[
          { label: "처리 대기", value: "18", hint: "전일 +3" },
          { label: "SLA", value: "42분", tone: "warn" },
        ]}
      />,
    );

    expect(screen.getByRole("list")).toHaveClass("grid", "gap-2");
    expect(screen.getByText("18")).toHaveClass("text-[15px]", "font-extrabold");
    expect(screen.getByText("SLA").closest("li")).toHaveClass("border-console-warn-bd");
  });

  it("renders section card header actions without nesting cards", () => {
    render(
      <SectionCard title="근태 예외" meta="오늘 6건" action={<button type="button">확인</button>}>
        <MonoRef value="AT-0703-02" />
      </SectionCard>,
    );

    expect(screen.getByRole("region", { name: "근태 예외" })).toHaveClass(
      "border-console-border",
      "bg-console-surface",
    );
    expect(screen.getByText("AT-0703-02")).toHaveClass("font-mono");
  });

  it("supports search clear and escape with localized labels", async () => {
    const onChange = vi.fn();
    const onEscape = vi.fn();
    render(<SearchInput value="AP" onChange={onChange} onEscape={onEscape} />);

    const input = screen.getByRole("searchbox", { name: "검색" });
    input.focus();
    await userEvent.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "검색어 지우기" }));
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(input).toHaveClass("focus-visible:ring-console-signal");
  });

  it("fires toast undo and close actions", async () => {
    const undo = vi.fn();
    const close = vi.fn();
    render(<ConsoleToast message="AP-3124 상신 완료" onUndo={undo} onClose={close} />);

    const toast = screen.getByRole("status");
    expect(toast).toHaveClass("console-motion-toast", "bg-console-ink", "text-console-surface");

    await userEvent.click(screen.getByRole("button", { name: "실행 취소" }));
    await userEvent.click(screen.getByRole("button", { name: "닫기" }));

    expect(undo).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
