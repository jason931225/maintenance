import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TokenText } from "./TokenText";
import type { ObjectKind, ObjectRef } from "./objectKinds";

describe("TokenText (renderer — maps over span DATA, never React elements)", () => {
  it("renders a resolved mention as styled text carrying the resolved id, never the raw id in prose", () => {
    render(
      <TokenText
        text="@u1 확인 부탁"
        resolveObject={(kind, code) =>
          kind === "person" && code === "u1" ? { id: "u1", name: "홍길동" } : undefined
        }
      />,
    );
    const mention = screen.getByText("@홍길동");
    expect(mention).toHaveAttribute("data-mention", "u1");
    expect(screen.getByText(/확인 부탁/)).toBeInTheDocument();
  });

  it("renders an unresolved mention as inert plain text (unknown OR unauthorized — never a dead link)", () => {
    const { container } = render(<TokenText text="@u404 확인" resolveObject={() => undefined} />);
    expect(container).toHaveTextContent("@u404 확인");
    expect(container.querySelector("[data-mention]")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders a resolved object link as a chip and fires onOpen with (kind, code) on click", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const resolveObject = (kind: ObjectKind, code: string): ObjectRef | undefined =>
      kind === "workOrder" && code === "WO-2643"
        ? { id: "wo-1", code: "WO-2643", name: "케이앤엘 · GTS25DE" }
        : undefined;

    render(<TokenText text="작업 #WO-2643 확인" resolveObject={resolveObject} onOpen={onOpen} />);

    const chip = screen.getByRole("button", { name: /WO-2643/ });
    await user.click(chip);
    expect(onOpen).toHaveBeenCalledWith("workOrder", "WO-2643");
  });

  it("never links an unauthorized/unresolved !CODE — it stays literal plain text (deny-by-omission)", () => {
    const { container } = render(<TokenText text="승인 필요 !AP-9999" resolveObject={() => undefined} />);
    expect(container).toHaveTextContent("승인 필요 !AP-9999");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders a code whose prefix matches no registered kind as inert plain text", () => {
    // ZZ- is not a registered prefix → kindFromCode returns undefined → never linked.
    const { container } = render(
      <TokenText text="코드 !ZZ-1 참고" resolveObject={() => ({ id: "x", code: "ZZ-1" })} />,
    );
    expect(container).toHaveTextContent("!ZZ-1");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders tokenless prose unchanged", () => {
    render(<TokenText text="트리거가 없는 평범한 문장" />);
    expect(screen.getByText("트리거가 없는 평범한 문장")).toBeInTheDocument();
  });
});
