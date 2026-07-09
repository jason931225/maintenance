import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { AuthContext, type AuthContextValue, type AuthSession } from "../../context/auth";
import { stepperFixture } from "./demoFixtures";
import { LifecycleCard } from "./LifecycleCard";
import type { Lifecycle } from "./types";

const OBJECT_ID = stepperFixture.objectId;
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

function session(roles: string[]): AuthSession {
  return { access_token: roles.join("-").toLowerCase(), user_id: "user-1", roles };
}

function ctx(s: AuthSession): AuthContextValue {
  return {
    session: s,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: createConsoleApiClient(s.access_token),
  };
}

function renderCard(s: AuthSession) {
  return render(
    <AuthContext.Provider value={ctx(s)}>
      <LifecycleCard objectType="document" objectId={OBJECT_ID} />
    </AuthContext.Provider>,
  );
}

const activeRecord: Lifecycle = {
  ...stepperFixture,
  currentState: "active",
  transitions: [
    { fromState: "approved", toState: "active", reason: "효력 발생 처리", actor: undefined, occurredAt: "2026-06-06T00:00:00Z" },
    ...stepperFixture.transitions,
  ],
};

describe("LifecycleCard (wired to the real BE-LC REST surface)", () => {
  it("reads the lifecycle from GET /api/v1/lifecycles/{type}/{id} and renders the stepper", async () => {
    server.use(
      http.get(`*/api/v1/lifecycles/document/${OBJECT_ID}`, () => HttpResponse.json(stepperFixture)),
    );
    const { container } = renderCard(session(["ADMIN"]));
    await waitFor(() => {
      expect(container.querySelector('[data-step="review"]')).toHaveAttribute("data-step-status", "current");
    });
  });


  it("shows the error state when the lifecycle reload throws", async () => {
    server.use(
      http.get(`*/api/v1/lifecycles/document/${OBJECT_ID}`, () => HttpResponse.error()),
    );
    renderCard(session(["ADMIN"]));
    expect(await screen.findByText("생애주기를 불러오지 못했습니다")).toBeInTheDocument();
  });

  it("fires the real transition mutation with the typed body and reflects the new state", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get(`*/api/v1/lifecycles/document/${OBJECT_ID}`, () => HttpResponse.json(stepperFixture)),
      http.post(`*/api/v1/lifecycles/document/${OBJECT_ID}/transition`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(activeRecord);
      }),
    );
    const user = userEvent.setup();
    const { container } = renderCard(session(["ADMIN"]));
    await screen.findByRole("button", { name: "활성" });
    await user.type(screen.getByPlaceholderText(/사유/), "효력 발생 처리");
    await user.click(screen.getByRole("button", { name: "활성" }));
    await waitFor(() => { expect(bodies).toEqual([{ toState: "active", reason: "효력 발생 처리" }]); });
    // The card re-renders from the server's updated record: active stage current.
    await waitFor(() => {
      expect(container.querySelector('[data-step="active"]')).toHaveAttribute("data-step-status", "current");
    });
  });


  it("keeps only one transition in flight while a mutation is pending", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get(`*/api/v1/lifecycles/document/${OBJECT_ID}`, () => HttpResponse.json(stepperFixture)),
      http.post(`*/api/v1/lifecycles/document/${OBJECT_ID}/transition`, async ({ request }) => {
        bodies.push(await request.json());
        await new Promise((resolve) => setTimeout(resolve, 30));
        return HttpResponse.json(activeRecord);
      }),
    );
    const user = userEvent.setup();
    renderCard(session(["ADMIN"]));
    await screen.findByRole("button", { name: "활성" });
    await user.type(screen.getByPlaceholderText(/사유/), "효력 발생 처리");
    await user.dblClick(screen.getByRole("button", { name: "활성" }));
    await waitFor(() => { expect(bodies).toHaveLength(1); });
  });

  it("fires the real hold mutation with the legal-hold and retention body", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get(`*/api/v1/lifecycles/document/${OBJECT_ID}`, () => HttpResponse.json(stepperFixture)),
      http.post(`*/api/v1/lifecycles/document/${OBJECT_ID}/hold`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...stepperFixture, legalHold: true });
      }),
    );
    const user = userEvent.setup();
    const { container } = renderCard(session(["ADMIN"]));
    await waitFor(() => { expect(container.querySelector('[data-hold-apply]')).toBeInTheDocument(); });
    await user.click(screen.getByRole("checkbox"));
    await user.click(container.querySelector('[data-hold-apply]') as HTMLElement);
    await waitFor(() => { expect(bodies).toEqual([{ legalHold: true }]); });
  });

  it("omits the transition and hold affordances for a persona without lifecycle authority", async () => {
    server.use(
      http.get(`*/api/v1/lifecycles/document/${OBJECT_ID}`, () => HttpResponse.json(stepperFixture)),
    );
    const { container } = renderCard(session(["RECEPTIONIST"]));
    await waitFor(() => {
      expect(container.querySelector('[data-fidelity="lifecycle-history"]')).toBeInTheDocument();
    });
    expect(container.querySelector('[data-fidelity="lifecycle-transitions"]')).toBeNull();
    expect(container.querySelector('[data-fidelity="lifecycle-hold"]')).toBeNull();
  });
});
