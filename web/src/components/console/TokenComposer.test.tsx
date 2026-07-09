import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import type { CandidateProvider } from "../../lib/objectCandidates";
import { TokenComposer } from "./TokenComposer";

function makeDataTransfer(store: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => store[type] ?? "",
    setData: () => undefined,
    types: Object.keys(store),
    effectAllowed: "copy",
  } as unknown as DataTransfer;
}

function Harness({
  providers = {},
  initial = "",
}: {
  providers?: Partial<Record<"@" | "#" | "!", CandidateProvider>>;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <TokenComposer
      value={value}
      onChange={setValue}
      providers={providers}
      ariaLabel="작성"
    />
  );
}

describe("TokenComposer", () => {
  it("inserts and resolves a work-order chip when a WO row is dropped (AC1)", () => {
    render(<Harness />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");

    const payload = JSON.stringify({
      kind: "workOrder",
      code: "WO-20260612-001",
      label: "케이앤엘 · 지게차",
    });
    fireEvent.drop(textarea, {
      dataTransfer: makeDataTransfer({ "application/x-oyatie-object": payload }),
    });

    expect(textarea.value).toContain("!WO-20260612-001");
    const preview = screen.getByTestId("token-composer-preview");
    // Resolved → rendered as an interactive object chip, not raw text.
    expect(
      within(preview).getByRole("button", { name: /WO-20260612-001/ }),
    ).toBeInTheDocument();
  });

  it("leaves a hand-typed code that never resolved as inert plain text (AC3 deny-by-omission)", () => {
    render(<Harness initial="예산 초과 !AP-9999 재검토 필요" />);
    const preview = screen.getByTestId("token-composer-preview");

    expect(within(preview).queryByRole("button")).not.toBeInTheDocument();
    expect(preview).toHaveTextContent("!AP-9999");
  });

  it("shows @ candidates from the provider and inserts a mention only on explicit confirm", async () => {
    const provider: CandidateProvider = () =>
      Promise.resolve({
        status: "ok",
        candidates: [
          { kind: "person", code: "11111111-1111-4111-8111-111111111111", label: "홍길동" },
        ],
      });
    render(<Harness providers={{ "@": provider }} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");

    fireEvent.change(textarea, {
      target: { value: "@", selectionStart: 1, selectionEnd: 1 },
    });

    const option = await screen.findByRole("button", { name: /홍길동/ });
    // Space/Enter must NOT auto-select; only click/Tab confirm.
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(textarea.value).toContain("@11111111-1111-4111-8111-111111111111");
    const preview = screen.getByTestId("token-composer-preview");
    expect(preview).toHaveTextContent("@홍길동");
  });
});
