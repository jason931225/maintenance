import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { EvidenceUpload } from "./EvidenceUpload";
import { ko } from "../../i18n/ko";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
});
afterAll(() => {
  server.close();
});

const WORK_ORDER_ID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_ID = "22222222-2222-4222-8222-222222222222";

function session(): AuthSession {
  return {
    access_token: "mechanic-token",
    user_id: "user-1",
    roles: ["MECHANIC"],
    branches: ["33333333-3333-4333-8333-333333333333"],
  };
}

function makeAuthContext(): AuthContextValue {
  return {
    session: session(),
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: createConsoleApiClient("mechanic-token"),
  };
}

function renderUpload() {
  return render(
    <AuthContext.Provider value={makeAuthContext()}>
      <EvidenceUpload workOrderId={WORK_ORDER_ID} />
    </AuthContext.Provider>,
  );
}

function imageFile(name = "evidence.jpg", type = "image/jpeg", size = 1024) {
  const file = new File([new Uint8Array(size)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("EvidenceUpload", () => {
  it("rejects a disallowed file type before any presign request", async () => {
    const presign = vi.fn();
    server.use(
      http.post("*/api/v1/evidence/staging-presign", () => {
        presign();
        return HttpResponse.json({}, { status: 200 });
      }),
    );
    renderUpload();

    const input = screen.getByLabelText<HTMLInputElement>(
      ko.workOrder.evidence.pickFiles,
    );
    // Drive the change directly so the disallowed file reaches the handler even
    // though the input's `accept` attr would filter it in a real browser; the
    // component re-validates the MIME and rejects it.
    fireEvent.change(input, {
      target: { files: [imageFile("doc.pdf", "application/pdf")] },
    });

    expect(
      await screen.findByText((content) =>
        content.includes(ko.workOrder.evidence.rejectedType),
      ),
    ).toBeInTheDocument();
    expect(presign).not.toHaveBeenCalled();
  });

  it("rejects an oversize image before any presign request", async () => {
    const presign = vi.fn();
    server.use(
      http.post("*/api/v1/evidence/staging-presign", () => {
        presign();
        return HttpResponse.json({}, { status: 200 });
      }),
    );
    const user = userEvent.setup();
    renderUpload();

    const input = screen.getByLabelText(ko.workOrder.evidence.pickFiles);
    await user.upload(
      input,
      imageFile("big.jpg", "image/jpeg", 26 * 1024 * 1024),
    );

    expect(
      await screen.findByText((content) =>
        content.includes(ko.workOrder.evidence.rejectedSizeImage),
      ),
    ).toBeInTheDocument();
    expect(presign).not.toHaveBeenCalled();
  });

  it("uploads to the presigned staging URL and polls to READY", async () => {
    let putReceived = false;
    let statusCalls = 0;
    server.use(
      http.post("*/api/v1/evidence/staging-presign", () =>
        HttpResponse.json({
          id: EVIDENCE_ID,
          work_order_id: WORK_ORDER_ID,
          stage: "DURING",
          media_kind: "IMAGE",
          processing_status: "PROCESSING",
          upload: {
            method: "PUT",
            url: "http://storage.local/primary/orgs/abc/work-orders/x/DURING/staging/y.img",
            headers: [["content-type", "image/jpeg"]],
            expires_in_secs: 300,
          },
        }),
      ),
      http.put("http://storage.local/*", () => {
        putReceived = true;
        return new HttpResponse(null, { status: 200 });
      }),
      http.get("*/api/v1/evidence/:evidenceId/status", () => {
        statusCalls += 1;
        return HttpResponse.json({
          id: EVIDENCE_ID,
          work_order_id: WORK_ORDER_ID,
          stage: "DURING",
          processing_status: statusCalls >= 1 ? "READY" : "PROCESSING",
          content_type: "image/jpeg",
        });
      }),
    );

    const user = userEvent.setup();
    renderUpload();
    const input = screen.getByLabelText(ko.workOrder.evidence.pickFiles);
    await user.upload(input, imageFile());

    // PROCESSING is shown immediately after the presign + PUT.
    await screen.findByText((content) =>
      content.includes(ko.workOrder.evidence.statusProcessing),
    );
    expect(putReceived).toBe(true);

    // The poll resolves to READY (status endpoint returns READY on first poll).
    await waitFor(
      () => {
        expect(
          screen.getByText((content) =>
            content.includes(ko.workOrder.evidence.statusReady),
          ),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });
});
