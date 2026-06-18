import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppRouter } from "../AppRouter";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";
import { branchId } from "../test/fixtures";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

beforeEach(() => {
  // jsdom has no object-URL plumbing; stub it so saveBlob() does not throw.
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
  globalThis.URL.revokeObjectURL = vi.fn();
  // Stub anchor.click so the synthetic download does not hit jsdom navigation.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

function makeAuthContext(session: AuthSession): AuthContextValue {
  const api = createConsoleApiClient(session.access_token);
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    api,
  };
}

function renderApp(ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/reporting"]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const adminSession: AuthSession = {
  access_token: "a",
  user_id: "manager-1",
  roles: ["ADMIN"],
  branches: [branchId],
};

const mechanicSession: AuthSession = {
  access_token: "m",
  user_id: "mech-1",
  roles: ["MECHANIC"],
  branches: [branchId],
};

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function workbookResponse() {
  return new HttpResponse(new Blob([new Uint8Array([0x50, 0x4b])]), {
    headers: {
      "Content-Type": XLSX_MIME,
      "Content-Disposition": 'attachment; filename="work-diary-2026-06-12.xlsx"',
    },
  });
}

describe("ReportingPage export", () => {
  it("downloads the work-diary workbook through the export endpoint", async () => {
    const user = userEvent.setup();
    const exported = vi.fn();
    server.use(
      http.get("*/api/v1/exports/work-diary", ({ request }) => {
        exported(new URL(request.url).searchParams.get("date"));
        return workbookResponse();
      }),
    );

    renderApp(makeAuthContext(adminSession));

    const dateInput = await screen.findByLabelText("기준 날짜");
    await user.clear(dateInput);
    await user.type(dateInput, "2026-06-12");
    await user.click(screen.getByRole("button", { name: "엑셀 내려받기" }));

    await waitFor(() => {
      expect(exported).toHaveBeenCalledWith("2026-06-12");
    });
    expect(
      await screen.findByText("업무일지 보고서를 내려받았습니다."),
    ).toBeVisible();
  });

  it("downloads the daily-status workbook when that report is selected", async () => {
    const user = userEvent.setup();
    const exported = vi.fn();
    server.use(
      http.get("*/api/v1/exports/daily-status", ({ request }) => {
        exported(new URL(request.url).searchParams.get("date"));
        return workbookResponse();
      }),
    );

    renderApp(makeAuthContext(adminSession));

    await user.selectOptions(
      await screen.findByLabelText("보고서 종류"),
      "daily-status",
    );
    const dateInput = screen.getByLabelText("기준 날짜");
    await user.clear(dateInput);
    await user.type(dateInput, "2026-06-12");
    await user.click(screen.getByRole("button", { name: "엑셀 내려받기" }));

    await waitFor(() => {
      expect(exported).toHaveBeenCalledWith("2026-06-12");
    });
  });

  it("surfaces an error when the export fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/exports/work-diary", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        ),
      ),
    );

    renderApp(makeAuthContext(adminSession));

    await user.click(
      await screen.findByRole("button", { name: "엑셀 내려받기" }),
    );

    expect(
      await screen.findByText(
        "보고서를 생성하지 못했습니다. 날짜를 확인하고 다시 시도하세요.",
      ),
    ).toBeVisible();
  });

  it("lets a mechanic download (ExcelDownload is allowed for every role)", async () => {
    const user = userEvent.setup();
    const exported = vi.fn();
    server.use(
      http.get("*/api/v1/exports/work-diary", () => {
        exported();
        return workbookResponse();
      }),
    );

    renderApp(makeAuthContext(mechanicSession));

    await user.click(
      await screen.findByRole("button", { name: "엑셀 내려받기" }),
    );

    await waitFor(() => {
      expect(exported).toHaveBeenCalled();
    });
  });
});
