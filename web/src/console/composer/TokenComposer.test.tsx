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
  objectProvider,
  initial = "",
}: {
  providers?: Partial<Record<"@" | "#", CandidateProvider>>;
  objectProvider?: CandidateProvider;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <TokenComposer
      value={value}
      onChange={setValue}
      providers={providers}
      objectProvider={objectProvider}
      ariaLabel="작성"
    />
  );
}

const hong: ObjectCandidate = { kind: "person", code: "u-hong", label: "홍길동", search: "홍길동" };
const kim: ObjectCandidate = { kind: "person", code: "u-kim", label: "김철수", search: "김철수" };
const jeongbi: ObjectCandidate = { kind: "channel", code: "th-1", label: "정비팀", search: "정비팀" };
const wo2643: ObjectCandidate = {
  kind: "workOrder",
  code: "WO-2643",
  id: "wo-1",
  label: "케이앤엘 · GTS25DE",
  search: "케이앤엘",
};

describe("TokenComposer (integration)", () => {
  it("leaves a bare code that never resolved as inert plain text (deny-by-omission)", () => {
    render(<Harness initial="예산 초과 AP-9999 재검토 필요" />);
    const preview = screen.getByTestId("token-composer-preview");
    expect(within(preview).queryByRole("button")).not.toBeInTheDocument();
    expect(preview).toHaveTextContent("AP-9999");
  });

  it("auto-links a BARE object code in the preview via objectProvider — no trigger typed (named acceptance)", async () => {
    render(<Harness objectProvider={ok([wo2643])} initial="WO-2643 배차 확인" />);
    const preview = screen.getByTestId("token-composer-preview");
    // The provider (permission-scoped) resolves the bare code → a live chip.
    expect(await within(preview).findByRole("button", { name: /케이앤엘/ })).toBeInTheDocument();
  });

  it("keeps a bare code inert when objectProvider omits it (PBAC deny-by-omission)", async () => {
    // Provider authorizes only WO-2643; the typed WO-9999 is not returned → inert.
    render(<Harness objectProvider={ok([wo2643])} initial="WO-9999 미권한" />);
    const preview = screen.getByTestId("token-composer-preview");
    await waitFor(() => { expect(preview).toHaveTextContent("WO-9999"); });
    expect(within(preview).queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens the #channel dropdown and confirms a channel on click (navigates as a chip)", async () => {
    render(<Harness providers={{ "#": ok([jeongbi]) }} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");
    fireEvent.change(textarea, { target: { value: "#", selectionStart: 1, selectionEnd: 1 } });

    const option = await screen.findByRole("button", { name: /정비팀/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(textarea.value).toContain("#th-1");
    const preview = screen.getByTestId("token-composer-preview");
    expect(within(preview).getByRole("button", { name: /정비팀/ })).toHaveTextContent("#정비팀");
  });

  it("a casual #23 opens then dismisses the channel dropdown gracefully (no commit) — mirrors @", async () => {
    render(<Harness providers={{ "#": ok([jeongbi]) }} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("작성");
    fireEvent.change(textarea, { target: { value: "이슈 #23", selectionStart: 6, selectionEnd: 6 } });

    // Dropdown opens; "23" matches no channel → empty note, nothing committed.
    expect(await screen.findByText("일치하는 항목이 없습니다")).toBeInTheDocument();
    expect(textarea.value).toBe("이슈 #23");
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
