import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import type { CandidateProvider } from "./candidates";
import { TokenComposer } from "./TokenComposer";
import type { ObjectCandidate } from "./objectKinds";

function ok(candidates: ObjectCandidate[]): CandidateProvider {
  return () => Promise.resolve({ status: "ok", candidates });
}

function Harness({
  providers = {},
  initial = "",
}: {
  providers?: Partial<Record<"@" | "#" | "!", CandidateProvider>>;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return <TokenComposer value={value} onChange={setValue} providers={providers} ariaLabel="작성" />;
}

const hong: ObjectCandidate = { kind: "person", code: "u-hong", label: "홍길동", search: "홍길동" };
const kim: ObjectCandidate = { kind: "person", code: "u-kim", label: "김철수", search: "김철수" };

describe("TokenComposer (integration)", () => {
  it("leaves a hand-typed code that never resolved as inert plain text (deny-by-omission)", () => {
    render(<Harness initial="예산 초과 !AP-9999 재검토 필요" />);
    const preview = screen.getByTestId("token-composer-preview");
    expect(within(preview).queryByRole("button")).not.toBeInTheDocument();
    expect(preview).toHaveTextContent("!AP-9999");
  });

  it("only lists candidates the provider returned — an unlisted code cannot be selected (PBAC omission)", async () => {
    // Provider returns ONLY 홍길동; 김철수 is not authorized → never appears.
    render(<Harness providers={{ "@": ok([hong]) }} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });

    await screen.findByRole("button", { name: /홍길동/ });
    expect(screen.queryByRole("button", { name: /김철수/ })).not.toBeInTheDocument();
  });

  it("inserts a mention only on explicit confirm (click) — resolving it in the preview", async () => {
    render(<Harness providers={{ "@": ok([hong]) }} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });

    const option = await screen.findByRole("button", { name: /홍길동/ });
    fireEvent.mouseDown(option); // preventDefaults, keeps caret
    fireEvent.click(option);

    expect(textarea.value).toContain("@u-hong");
    expect(screen.getByTestId("token-composer-preview")).toHaveTextContent("@홍길동");
  });

  it("Space and Enter do NOT auto-select a candidate (normal typing never hijacked)", async () => {
    render(<Harness providers={{ "@": ok([hong]) }} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");
    fireEvent.change(textarea, { target: { value: "@홍", selectionStart: 2, selectionEnd: 2 } });
    await screen.findByRole("button", { name: /홍길동/ });

    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: " " });
    // No token committed by Enter/Space — the raw text is untouched.
    expect(textarea.value).toBe("@홍");
  });

  it("Tab confirms the highlighted candidate (the second explicit gesture)", async () => {
    render(<Harness providers={{ "@": ok([hong, kim]) }} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
    await screen.findByRole("button", { name: /홍길동/ });

    fireEvent.keyDown(textarea, { key: "ArrowDown" }); // highlight first
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toContain("@u-hong");
  });

  it("fetches once per trigger open and narrows client-side as the query grows (no refetch)", async () => {
    let calls = 0;
    const provider: CandidateProvider = () => {
      calls += 1;
      return Promise.resolve({ status: "ok", candidates: [hong, kim] });
    };
    render(<Harness providers={{ "@": provider }} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");

    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
    await screen.findByRole("button", { name: /홍길동/ });
    expect(screen.getByRole("button", { name: /김철수/ })).toBeInTheDocument();
    expect(calls).toBe(1);

    fireEvent.change(textarea, { target: { value: "@홍", selectionStart: 2, selectionEnd: 2 } });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /김철수/ })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /홍길동/ })).toBeInTheDocument();
    expect(calls).toBe(1);
  });

  it("shows an explicit error row when the provider fails (never a silent empty)", async () => {
    render(<Harness providers={{ "@": () => Promise.resolve({ status: "error" }) }} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
    expect(await screen.findByText("후보를 불러오지 못했습니다")).toBeInTheDocument();
  });

  it("closes the candidate dropdown when the field loses focus", async () => {
    render(<Harness providers={{ "@": ok([hong]) }} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
    await screen.findByRole("button", { name: /홍길동/ });

    fireEvent.blur(textarea);
    expect(screen.queryByRole("button", { name: /홍길동/ })).not.toBeInTheDocument();
  });

  it("does not open a dropdown for a trigger with no provider (types as plain text)", () => {
    render(<Harness providers={{}} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
    expect(screen.queryByTestId("token-composer-dropdown")).not.toBeInTheDocument();
  });
});
