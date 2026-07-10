import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { PolicyGateProvider } from "../policy";
import { PolicyCanvasScreen } from "./PolicyCanvasScreen";
import {
  DEFAULT_POLICYCANVAS_STRINGS as S,
  DEFAULT_POLICYCANVAS_WIRE_STRINGS as W,
} from "./strings";

const ORG_ID = "00000000-0000-4000-8000-000000000000";
const CATALOG_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_ID = "22222222-2222-4222-8222-222222222222";
const AUTHOR_ID = "33333333-3333-4333-8333-333333333333";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const catalogEntry = {
  id: CATALOG_ID,
  stable_key: "policy.wo_view",
  title: "Work order view",
  effect: "permit",
  status: "enforced",
  source: "promoted_policy",
  validation_status: "valid",
  updated_at: "2026-07-01T00:00:00Z",
};

function draftRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    draft_key: "draft.custom_rule",
    title: "Custom draft rule",
    normalized_row: {
      effect: "permit",
      action: "view",
      resource_type: "work_order",
      conditions: [
        {
          attr: "roles",
          op: "contains",
          value: { kind: "literal", value: "admin" },
        },
      ],
    },
    generated_policy_text: "permit(principal, action, resource);",
    validation_status: "valid",
    validation_errors: [],
    review_status: "draft",
    reviewer_id: null,
    created_by: AUTHOR_ID,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    ...overrides,
  };
}

function useCatalogAndDrafts(
  catalog: unknown[],
  drafts: unknown[],
) {
  server.use(
    http.get("*/api/v1/policy/catalog", () => HttpResponse.json(catalog)),
    http.get("*/api/v1/policy/drafts", () => HttpResponse.json(drafts)),
  );
}

function allowAll({ children }: { children: ReactNode }) {
  return <PolicyGateProvider decide={() => true}>{children}</PolicyGateProvider>;
}

function renderScreen(gated = true) {
  const api = createConsoleApiClient("token");
  return render(
    <PolicyCanvasScreen api={api} orgId={ORG_ID} />,
    gated ? { wrapper: allowAll } : undefined,
  );
}

async function screenReady() {
  await waitFor(() => {
    expect(screen.queryByText(W.loading)).not.toBeInTheDocument();
  });
}

describe("PolicyCanvasScreen", () => {
  it("loads the catalog and drafts from the API and renders the P→R→A→E canvas", async () => {
    useCatalogAndDrafts([catalogEntry], [draftRecord()]);
    renderScreen();
    await screenReady();

    const nav = screen.getByRole("navigation", { name: S.catalogLabel });
    expect(
      within(nav).getByRole("button", {
        name: S.policyAria(catalogEntry.title),
      }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("button", {
        name: S.policyAria("Custom draft rule"),
      }),
    ).toBeInTheDocument();
    expect(within(nav).getByText(W.catalogStatus.enforced)).toBeInTheDocument();
    expect(screen.getByText(S.denyDefaultChip)).toBeInTheDocument();
    expect(screen.getByText(S.forbidWinsChip)).toBeInTheDocument();
    for (const title of Object.values(S.blocks)) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
    // the first draft is selected and its API blocks drive the rule line
    const rule = screen.getByLabelText(S.ruleLineLabel);
    expect(rule.textContent).toContain("work_order");
    expect(rule.textContent).toContain("permitted");
  });

  it("hides authoring affordances without a policy gate (deny-by-omission)", async () => {
    useCatalogAndDrafts([catalogEntry], [draftRecord()]);
    renderScreen(false);
    await screenReady();
    expect(
      screen.queryByRole("button", { name: S.addPolicy }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: S.saveDraft }),
    ).not.toBeInTheDocument();
  });

  it("shows the load-failed state with a retry action", async () => {
    server.use(
      http.get("*/api/v1/policy/catalog", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        ),
      ),
      http.get("*/api/v1/policy/drafts", () => HttpResponse.json([])),
    );
    renderScreen();
    await screenReady();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(W.loadFailed);
    expect(screen.getByRole("button", { name: W.retry })).toBeInTheDocument();
  });

  it("shows the empty state when the tenant has no policies", async () => {
    useCatalogAndDrafts([], []);
    renderScreen();
    await screenReady();
    expect(screen.getByText(W.emptyCatalog)).toBeInTheDocument();
    // next action stays available
    expect(screen.getByRole("button", { name: S.addPolicy })).toBeInTheDocument();
  });

  it("round-trips a draft edit through PUT /policy/drafts/{id}", async () => {
    const user = userEvent.setup();
    useCatalogAndDrafts([], [draftRecord()]);
    const updated = vi.fn();
    server.use(
      http.put("*/api/v1/policy/drafts/:draftId", async ({ request }) => {
        const body = (await request.json()) as {
          title?: string;
          blocks: Record<string, unknown>;
        };
        updated(body);
        return HttpResponse.json(
          draftRecord({ title: body.title, normalized_row: body.blocks }),
        );
      }),
    );
    renderScreen();
    await screenReady();

    await user.click(screen.getByRole("button", { name: S.effectLabels.forbid }));
    await user.click(screen.getByRole("button", { name: S.saveDraft }));

    expect(await screen.findByText(S.draftSaved)).toBeInTheDocument();
    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Custom draft rule",
        blocks: expect.objectContaining({
          effect: "forbid",
          action: "view",
          resource_type: "work_order",
        }),
      }),
    );
    expect(screen.getByLabelText(S.ruleLineLabel).textContent).toContain(
      "forbidden",
    );
  });

  it("creates a new draft through POST /policy/drafts", async () => {
    const user = userEvent.setup();
    useCatalogAndDrafts([], [draftRecord()]);
    const created = vi.fn();
    server.use(
      http.post("*/api/v1/policy/drafts", async ({ request }) => {
        const body = (await request.json()) as {
          draft_key: string;
          title: string;
          blocks: Record<string, unknown>;
        };
        created(body);
        return HttpResponse.json(
          draftRecord({
            id: "44444444-4444-4444-8444-444444444444",
            draft_key: body.draft_key,
            title: body.title,
            normalized_row: body.blocks,
          }),
          { status: 201 },
        );
      }),
    );
    renderScreen();
    await screenReady();

    await user.click(screen.getByRole("button", { name: S.addPolicy }));
    const nameInput = screen.getByRole("textbox", { name: S.nameLabel });
    await user.clear(nameInput);
    await user.type(nameInput, "Export guard v2");
    await user.type(
      screen.getByRole("textbox", { name: S.objectTypeLabel }),
      "hr_record",
    );
    await user.click(screen.getByRole("button", { name: S.saveDraft }));

    expect(await screen.findByText(S.draftSaved)).toBeInTheDocument();
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        draft_key: expect.stringMatching(/^draft\.[a-f0-9]{12}$/),
        title: "Export guard v2",
        blocks: expect.objectContaining({ resource_type: "hr_record" }),
      }),
    );
    expect(
      within(
        screen.getByRole("navigation", { name: S.catalogLabel }),
      ).getByRole("button", { name: S.policyAria("Export guard v2") }),
    ).toBeInTheDocument();
  });

  it("surfaces strict-validation errors from POST /validate", async () => {
    const user = userEvent.setup();
    useCatalogAndDrafts([], [draftRecord()]);
    server.use(
      http.post("*/api/v1/policy/drafts/:draftId/validate", () =>
        HttpResponse.json(
          draftRecord({
            validation_status: "invalid",
            validation_errors: ["unknown action nope"],
          }),
        ),
      ),
    );
    renderScreen();
    await screenReady();

    await user.click(screen.getByRole("button", { name: W.validate }));
    const errors = await screen.findByRole("alert");
    expect(errors).toHaveAccessibleName(W.validationErrorsLabel);
    expect(within(errors).getByText("unknown action nope")).toBeInTheDocument();
  });

  it("submits a valid draft into review_pending and freezes it (draft FSM)", async () => {
    const user = userEvent.setup();
    useCatalogAndDrafts([], [draftRecord()]);
    server.use(
      http.post("*/api/v1/policy/drafts/:draftId/submit", () =>
        HttpResponse.json(draftRecord({ review_status: "review_pending" })),
      ),
    );
    renderScreen();
    await screenReady();

    await user.click(screen.getByRole("button", { name: S.pendingRev.approve }));
    expect(
      (await screen.findAllByText(W.reviewStatus.review_pending)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: S.nameLabel })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: S.pendingRev.approve }),
    ).not.toBeInTheDocument();
  });

  it("records a four-eyes review decision via POST /review", async () => {
    const user = userEvent.setup();
    useCatalogAndDrafts(
      [],
      [draftRecord({ review_status: "review_pending" })],
    );
    const reviewed = vi.fn();
    server.use(
      http.post(
        "*/api/v1/policy/drafts/:draftId/review",
        async ({ request }) => {
          reviewed(await request.json());
          return HttpResponse.json(
            draftRecord({ review_status: "approved_for_promotion" }),
          );
        },
      ),
    );
    renderScreen();
    await screenReady();

    await user.click(screen.getByRole("button", { name: W.reviewApprove }));
    expect(
      (await screen.findAllByText(W.reviewStatus.approved_for_promotion))
        .length,
    ).toBeGreaterThan(0);
    expect(reviewed).toHaveBeenCalledWith({ decision: "approve" });
  });

  it("simulates an allow decision through POST /policy/simulate", async () => {
    const user = userEvent.setup();
    useCatalogAndDrafts([], [draftRecord()]);
    const simulated = vi.fn();
    server.use(
      http.post("*/api/v1/policy/simulate", async ({ request }) => {
        simulated(await request.json());
        return HttpResponse.json({
          outcome: {
            effect: "allow",
            determining_policies: ["cedar-policy-1"],
            errors: [],
            reason: "permit matched",
          },
        });
      }),
    );
    renderScreen();
    await screenReady();

    await user.type(
      screen.getByRole("textbox", { name: W.subjectUserId }),
      "user-7",
    );
    await user.type(
      screen.getByRole("textbox", { name: W.subjectRoles }),
      "admin, dispatcher",
    );
    await user.click(screen.getByRole("button", { name: W.run }));

    expect((await screen.findAllByText(S.simulator.allow)).length)
      .toBeGreaterThan(0);
    expect(screen.getByText(S.simulator.reasons.permit)).toBeInTheDocument();
    const audit = screen.getByLabelText(S.simulator.auditPreviewLabel);
    expect(within(audit).getByText("cedar-policy-1")).toBeInTheDocument();
    expect(simulated).toHaveBeenCalledWith({
      request: {
        subject: {
          org: ORG_ID,
          user_id: "user-7",
          roles: ["admin", "dispatcher"],
        },
        action: "view",
        resource: { org: ORG_ID, resource_type: "work_order" },
      },
      include_draft_id: DRAFT_ID,
    });
  });

  it("renders a forbid-won deny from the simulate API", async () => {
    const user = userEvent.setup();
    useCatalogAndDrafts([], [draftRecord()]);
    server.use(
      http.post("*/api/v1/policy/simulate", () =>
        HttpResponse.json({
          outcome: {
            effect: "deny",
            determining_policies: ["tenant-guardrail"],
            errors: [],
            reason: "forbid wins",
          },
        }),
      ),
    );
    renderScreen();
    await screenReady();

    await user.click(screen.getByRole("button", { name: W.run }));
    expect((await screen.findAllByText(S.simulator.deny)).length)
      .toBeGreaterThan(0);
    expect(screen.getByText(S.simulator.reasons.forbid)).toBeInTheDocument();
    const audit = screen.getByLabelText(S.simulator.auditPreviewLabel);
    expect(within(audit).getByText("tenant-guardrail")).toBeInTheDocument();
  });

  it("keeps the deny-by-omission presentation when nothing matches", async () => {
    const user = userEvent.setup();
    useCatalogAndDrafts([], [draftRecord()]);
    server.use(
      http.post("*/api/v1/policy/simulate", () =>
        HttpResponse.json({
          outcome: {
            effect: "deny",
            determining_policies: [],
            errors: [],
            reason: "no policy matched; deny by omission",
          },
        }),
      ),
    );
    renderScreen();
    await screenReady();

    await user.click(screen.getByRole("button", { name: W.run }));
    expect((await screen.findAllByText(S.simulator.deny)).length)
      .toBeGreaterThan(0);
    expect(screen.getByText(S.simulator.reasons.omission)).toBeInTheDocument();
    const audit = screen.getByLabelText(S.simulator.auditPreviewLabel);
    expect(
      within(audit).getByText(S.simulator.noMatchedPolicy),
    ).toBeInTheDocument();
  });

  it("flags a staged revision from the API draft/catalog key linkage (§3.9.0)", async () => {
    const user = userEvent.setup();
    useCatalogAndDrafts(
      [catalogEntry],
      [
        draftRecord({
          draft_key: catalogEntry.stable_key,
          title: catalogEntry.title,
        }),
      ],
    );
    renderScreen();
    await screenReady();

    const nav = screen.getByRole("navigation", { name: S.catalogLabel });
    expect(within(nav).getByText(W.pendingRevBanner)).toBeInTheDocument();
    await user.click(
      within(nav).getByRole("button", {
        name: S.policyAria(catalogEntry.title),
      }),
    );
    // the staged revision opens editable with the pendingRev banner: the
    // chip now shows in both the nav item and the banner
    expect(screen.getAllByText(W.pendingRevBanner).length).toBeGreaterThan(1);
    expect(
      screen.getAllByText(W.catalogStatus.enforced).length,
    ).toBeGreaterThan(1);
    expect(screen.getByLabelText(S.ruleLineLabel)).toBeInTheDocument();
  });

  it("shows an enforced policy read-only and stages a revision draft on request", async () => {
    const user = userEvent.setup();
    useCatalogAndDrafts([catalogEntry], []);
    const created = vi.fn();
    server.use(
      http.post("*/api/v1/policy/drafts", async ({ request }) => {
        const body = (await request.json()) as {
          draft_key: string;
          title: string;
          blocks: Record<string, unknown>;
        };
        created(body);
        return HttpResponse.json(
          draftRecord({
            id: "55555555-5555-4555-8555-555555555555",
            draft_key: body.draft_key,
            title: body.title,
            normalized_row: body.blocks,
          }),
          { status: 201 },
        );
      }),
    );
    renderScreen();
    await screenReady();

    // enforced policies are read-only until a revision draft is staged
    expect(
      screen.queryByRole("textbox", { name: S.nameLabel }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: W.startRevision }));
    await user.type(
      screen.getByRole("textbox", { name: S.objectTypeLabel }),
      "work_order",
    );
    await user.click(screen.getByRole("button", { name: S.saveDraft }));

    expect(await screen.findByText(S.draftSaved)).toBeInTheDocument();
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        draft_key: catalogEntry.stable_key,
        title: catalogEntry.title,
      }),
    );
  });

  it("discards local edits on withdraw, restoring the server draft", async () => {
    const user = userEvent.setup();
    useCatalogAndDrafts([], [draftRecord()]);
    renderScreen();
    await screenReady();

    await user.click(screen.getByRole("button", { name: S.effectLabels.forbid }));
    expect(screen.getByLabelText(S.ruleLineLabel).textContent).toContain(
      "forbidden",
    );
    await user.click(
      screen.getByRole("button", { name: S.pendingRev.withdraw }),
    );
    expect(screen.getByLabelText(S.ruleLineLabel).textContent).toContain(
      "permitted",
    );
    expect(screen.getByRole("button", { name: S.saveDraft })).toBeDisabled();
  });
});
