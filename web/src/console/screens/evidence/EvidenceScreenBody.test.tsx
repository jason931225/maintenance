import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../../api/client";
import { AuthContext, type AuthContextValue } from "../../../context/auth";
import { ko } from "../../../i18n/ko";
import { EvidenceScreenBody } from "./EvidenceScreenBody";

const now = new Date();
const thisMonthIso = now.toISOString();
const soonIso = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const evidenceObjectView = {
  id: "ev-1",
  code: "EV-101",
  title: "현장 CCTV 클립",
  description: null,
  source: { source_type: "MANUAL_UPLOAD", source_id: "src-1", source_code: null },
  classification: "internal",
  record_owner_user_id: "user-1",
  current_custody_stage: "REGISTERED",
  legal_hold_state: "NONE",
  admissibility_status: "ADMISSIBLE",
  admissibility_reasons: [],
  admissibility_inputs: {},
  created_by: "user-1",
  updated_by: "user-1",
  created_at: thisMonthIso,
  updated_at: thisMonthIso,
  disposed_at: null,
};

function renderBody(getImpl: (path: unknown, opts?: unknown) => Promise<unknown>) {
  const api = createConsoleApiClient("evidence-screen-test-token");
  vi.spyOn(api, "GET").mockImplementation(getImpl as never);
  const authValue = {
    session: { access_token: "evidence-screen-test-token", roles: ["ADMIN"] },
    restoring: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    acceptTokens: vi.fn(),
    clearPasskeySetup: vi.fn(),
    api,
    viewAs: undefined,
    enterViewAs: vi.fn(),
    exitViewAs: vi.fn(),
  } as unknown as AuthContextValue;

  return render(
    <AuthContext.Provider value={authValue}>
      <EvidenceScreenBody />
    </AuthContext.Provider>,
  );
}

describe("EvidenceScreenBody", () => {
  it("renders the 문서·기록물 shell with a real stat strip and the 증거 row, retention drilled from the lifecycle API", async () => {
    renderBody(async (path: unknown, opts?: unknown) => {
      await Promise.resolve();
      if (path === "/api/v1/evidence/objects") {
        return { data: { items: [evidenceObjectView], limit: 200, offset: 0, total: 1 } };
      }
      if (path === "/api/v1/users") {
        return { data: { items: [{ id: "user-1", display_name: "정하늘" }] } };
      }
      if (path === "/api/v1/lifecycles/{objectType}/{objectId}") {
        const params = (opts as { params: { path: { objectType: string; objectId: string } } }).params;
        expect(params.path.objectType).toBe("evidence_object");
        return {
          data: {
            objectType: "evidence_object",
            objectId: params.path.objectId,
            currentState: "active",
            legalHold: false,
            retentionUntil: soonIso,
            createdAt: thisMonthIso,
            updatedAt: thisMonthIso,
            transitions: [],
          },
        };
      }
      throw new Error(`unexpected GET ${String(path)}`);
    });

    expect(screen.getByRole("heading", { name: "문서·기록물" })).toBeVisible();
    expect(await screen.findByText("EV-101")).toBeVisible();
    expect(screen.getByText("현장 CCTV 클립")).toBeVisible();
    expect(screen.getByText("정하늘")).toBeVisible();

    // Real stat strip — total + this-month + expiring-soon, computed, not zeros.
    const totalButton = screen.getByRole("button", { name: /총 기록물/ });
    expect(totalButton).toHaveTextContent("1");
    const expiringButton = screen.getByRole("button", { name: /보존 만료 임박/ });
    await waitFor(() => {
      expect(expiringButton).toHaveTextContent("1");
    });
  });

  it("drills the 보존 만료 임박 stat into a filtered table", async () => {
    renderBody(async (path: unknown) => {
      await Promise.resolve();
      if (path === "/api/v1/evidence/objects") {
        return { data: { items: [evidenceObjectView], limit: 200, offset: 0, total: 1 } };
      }
      if (path === "/api/v1/users") return { data: { items: [] } };
      if (path === "/api/v1/lifecycles/{objectType}/{objectId}") {
        return {
          data: {
            objectType: "evidence_object",
            objectId: "ev-1",
            currentState: "active",
            legalHold: false,
            retentionUntil: soonIso,
            createdAt: thisMonthIso,
            updatedAt: thisMonthIso,
            transitions: [],
          },
        };
      }
      throw new Error(`unexpected GET ${String(path)}`);
    });

    await screen.findByText("EV-101");
    const expiringButton = await screen.findByRole("button", { name: /보존 만료 임박/ });
    await waitFor(() => {
      expect(expiringButton).toHaveTextContent("1");
    });
    await userEvent.click(expiringButton);
    expect(screen.getByText("EV-101")).toBeVisible();
  });

  it("filters the table by the 코드·제목·작성자 search input", async () => {
    const second = { ...evidenceObjectView, id: "ev-2", code: "EV-202", title: "무단결근 소명 녹취" };
    renderBody(async (path: unknown) => {
      await Promise.resolve();
      if (path === "/api/v1/evidence/objects") {
        return { data: { items: [evidenceObjectView, second], limit: 200, offset: 0, total: 2 } };
      }
      if (path === "/api/v1/users") return { data: { items: [] } };
      return { data: undefined, response: { status: 404 } };
    });

    expect(await screen.findByText("EV-101")).toBeVisible();
    expect(screen.getByText("EV-202")).toBeVisible();

    const searchLabel = `${ko.console.documents.columns.code}·${ko.console.documents.columns.title}·${ko.console.documents.columns.owner}`;
    await userEvent.type(screen.getByRole("searchbox", { name: searchLabel }), "무단결근");
    expect(screen.queryByText("EV-101")).not.toBeInTheDocument();
    expect(screen.getByText("EV-202")).toBeVisible();
  });

  it("shows an empty-until-backend chip for a 유형 tab with no real domain wired (never fabricates rows)", async () => {
    renderBody(async (path: unknown) => {
      await Promise.resolve();
      if (path === "/api/v1/evidence/objects") {
        return { data: { items: [evidenceObjectView], limit: 200, offset: 0, total: 1 } };
      }
      if (path === "/api/v1/users") return { data: { items: [] } };
      return { data: undefined, response: { status: 404 } };
    });

    await screen.findByText("EV-101");
    await userEvent.click(screen.getByRole("tab", { name: "계약" }));
    expect(screen.queryByText("EV-101")).not.toBeInTheDocument();
    expect(screen.getByText("이 문서 유형은 아직 연동되지 않았습니다")).toBeVisible();
  });

  it("기록물 등재 has no real create endpoint yet, so it honestly surfaces a pending notice instead of faking a registration (§4-25-⑥)", async () => {
    renderBody(async (path: unknown) => {
      await Promise.resolve();
      if (path === "/api/v1/evidence/objects") {
        return { data: { items: [evidenceObjectView], limit: 200, offset: 0, total: 1 } };
      }
      if (path === "/api/v1/users") return { data: { items: [] } };
      return { data: undefined, response: { status: 404 } };
    });
    await screen.findByText("EV-101");

    expect(screen.queryByRole("status")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: ko.console.documents.actions.register }));
    expect(screen.getByRole("status")).toHaveTextContent(
      ko.console.documents.actions.registerUnavailable,
    );
    // No fabricated row was added and the real table is untouched.
    expect(screen.getByText("EV-101")).toBeVisible();
  });

  it("내보내기 downloads a CSV of the rows actually on screen (real export, not a fabricated bulk one)", async () => {
    renderBody(async (path: unknown) => {
      await Promise.resolve();
      if (path === "/api/v1/evidence/objects") {
        return { data: { items: [evidenceObjectView], limit: 200, offset: 0, total: 1 } };
      }
      if (path === "/api/v1/users") return { data: { items: [{ id: "user-1", display_name: "정하늘" }] } };
      return { data: undefined, response: { status: 404 } };
    });
    await screen.findByText("EV-101");

    const createObjectURL = vi.fn().mockReturnValue("blob:mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await userEvent.click(screen.getByRole("button", { name: ko.console.documents.actions.export }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const [blob] = createObjectURL.mock.calls[0] as [Blob];
    const csv = await blob.text();
    expect(csv).toContain("EV-101");
    expect(csv).toContain("정하늘");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows the list-load error state with a working retry", async () => {
    let calls = 0;
    renderBody(async (path: unknown) => {
      await Promise.resolve();
      if (path === "/api/v1/evidence/objects") {
        calls += 1;
        if (calls === 1) throw new Error("network down");
        return { data: { items: [], limit: 200, offset: 0, total: 0 } };
      }
      return { data: undefined, response: { status: 404 } };
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeVisible();
    });
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => {
      expect(screen.getByText("표시할 기록물이 없습니다")).toBeVisible();
    });
  });
});
