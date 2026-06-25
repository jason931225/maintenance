import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import type { LocationConsentState } from "../../api/types";
import { tokenPair } from "../../test/fixtures";
import { LocationConsentPanel } from "./LocationConsentPanel";

const branchId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
let currentState: LocationConsentState = "GRANTED";
const transitionRequests: string[] = [];

const server = setupServer(
  http.get("*/api/v1/location-consent/status", () =>
    HttpResponse.json(consentStatus(currentState)),
  ),
  http.get("*/api/v1/location-consents/ledger", () =>
    HttpResponse.json({
      items: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          consent_id: "00000000-0000-4000-8000-000000000011",
          user_id: userId,
          branch_id: branchId,
          actor: userId,
          action: "consent.grant",
          from_status: "NO_RECORD",
          to_status: currentState,
          occurred_at: "2026-06-12T00:00:00Z",
          created_at: "2026-06-12T00:00:00Z",
        },
      ],
      limit: 10,
      offset: 0,
      total: 1,
    }),
  ),
  http.post("*/api/v1/location-consent/suspend", async ({ request }) => {
    transitionRequests.push(await request.text());
    currentState = "SUSPENDED";
    return HttpResponse.json(consentStatus(currentState));
  }),
  http.post("*/api/v1/location-consent/withdraw", async ({ request }) => {
    transitionRequests.push(await request.text());
    currentState = "WITHDRAWN";
    return HttpResponse.json(consentStatus(currentState));
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  currentState = "GRANTED";
  transitionRequests.length = 0;
});

afterAll(() => {
  server.close();
});

describe("LocationConsentPanel", () => {
  it("keeps consent status usable when ledger loading fails", async () => {
    server.use(
      http.get("*/api/v1/location-consents/ledger", () => HttpResponse.error()),
    );

    render(
      <LocationConsentPanel
        api={createConsoleApiClient(tokenPair.access_token)}
        branchId={branchId}
        session={tokenPair}
      />,
    );

    expect(await screen.findByText("동의됨")).toBeVisible();
    expect(screen.getByRole("button", { name: "GPS 끄기" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps GPS off and withdrawal controls visible and mutates through the API", async () => {
    const user = userEvent.setup();

    render(
      <LocationConsentPanel
        api={createConsoleApiClient(tokenPair.access_token)}
        branchId={branchId}
        session={tokenPair}
      />,
    );

    expect(await screen.findByText("동의됨")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "GPS 끄기" }));
    expect(await screen.findByText("GPS 꺼짐")).toBeVisible();
    expect(screen.getByRole("button", { name: "GPS 켜기" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "동의 철회" }));
    expect(await screen.findByText("철회됨")).toBeVisible();

    await waitFor(() => {
      expect(transitionRequests).toHaveLength(2);
      expect(transitionRequests[0]).toContain(branchId);
      expect(transitionRequests[1]).toContain(branchId);
    });
  });
});

function consentStatus(state: LocationConsentState) {
  return {
    consent_id: "00000000-0000-4000-8000-000000000011",
    user_id: userId,
    branch_id: branchId,
    state,
    may_collect: state === "GRANTED",
    granted_at: state === "NO_RECORD" ? null : "2026-06-12T00:00:00Z",
    suspended_at: state === "SUSPENDED" ? "2026-06-12T00:05:00Z" : null,
    resumed_at: null,
    withdrawn_at: state === "WITHDRAWN" ? "2026-06-12T00:10:00Z" : null,
    updated_at: "2026-06-12T00:10:00Z",
  };
}
