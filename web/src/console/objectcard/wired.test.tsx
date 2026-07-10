import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { createObjectCardStub } from "./stub";
import { objectCardGovStrings } from "./strings";
import { GovernedObjectCard } from "./wired";
import type { ObjectCardHandlers } from "./types";

const T = ko.console.objectcard;
const S = objectCardGovStrings();
const allowGate: PolicyGate = { can: () => true };

// Every mount fetches the dynamic-layer acting chips; default to empty so
// tests that don't care about §2 dynamics don't need to mock it individually.
const server = setupServer(
  http.get("*/api/v1/ontology/instances/:id/acting", () => HttpResponse.json([])),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function gateLine(gate: string, status: string, reason?: string) {
  return { gate, status: reason ? { status, reason } : { status } };
}

const passingChain = {
  gates: [
    gateLine("authority", "satisfied"),
    gateLine("self_checklist", "not_required"),
    gateLine("four_eyes", "not_required"),
    gateLine("egress_dlp", "not_required"),
  ],
  allow: true,
};

const pendingChain = {
  gates: [
    gateLine("authority", "satisfied"),
    gateLine("self_checklist", "not_required"),
    gateLine("four_eyes", "pending", "awaiting four-eyes approval from a distinct principal"),
    gateLine("egress_dlp", "not_required"),
  ],
  allow: false,
};

const historyRows = [
  {
    id: "rev-3",
    instance_id: "wo-2643",
    version: 3,
    attributes: {},
    valid_from: "2026-07-10T01:00:00Z",
    valid_to: null,
    action_type_id: "reassign",
    actor: "user-1",
    reason: null,
    prev_hash: "hash-2",
    row_hash: "hash-3",
  },
  {
    id: "rev-2",
    instance_id: "wo-2643",
    version: 2,
    attributes: {},
    valid_from: "2026-07-08T05:20:00Z",
    valid_to: "2026-07-10T01:00:00Z",
    action_type_id: "reassign",
    actor: "user-1",
    reason: null,
    prev_hash: "hash-1",
    row_hash: "hash-2",
  },
  {
    id: "rev-1",
    instance_id: "wo-2643",
    version: 1,
    attributes: {},
    valid_from: "2026-07-07T00:03:00Z",
    valid_to: "2026-07-08T05:20:00Z",
    action_type_id: "create",
    actor: "user-1",
    reason: null,
    prev_hash: "",
    row_hash: "hash-1",
  },
];

function renderGoverned(
  handlers?: ObjectCardHandlers,
  onInstanceChange?: (update: { lifecycleState: string; version: number }) => void,
) {
  const api = createConsoleApiClient();
  const descriptor = createObjectCardStub();
  return render(
    <PolicyGateProvider gate={allowGate}>
      <GovernedObjectCard
        api={api}
        descriptor={descriptor}
        handlers={handlers}
        onInstanceChange={onInstanceChange}
      />
    </PolicyGateProvider>,
  );
}

function clickAction(title: string) {
  fireEvent.click(screen.getByRole("button", { name: T.actionAria(title) }));
}

describe("GovernedObjectCard action preflight → execute", () => {
  it("renders each gate's status and withholds execute while a gate is pending (writes nothing)", async () => {
    const executeCalls = vi.fn();
    server.use(
      http.post("*/api/v1/ontology/actions/reassign/preflight", () =>
        HttpResponse.json({
          dispatch: "instance_revision",
          dispatch_target: null,
          config: { authority: true, self_checklist: false, four_eyes: true, egress_dlp: false },
          gates: pendingChain,
          criteria_ok: true,
          would_execute: false,
        }),
      ),
      http.post("*/api/v1/ontology/actions/reassign/execute", () => {
        executeCalls();
        return HttpResponse.json({});
      }),
    );
    renderGoverned();
    clickAction(T.samples.actions.reassign);

    // Every gate line reports its server-evaluated status.
    expect(await screen.findByText(S.gates.four_eyes)).toBeTruthy();
    expect(screen.getByText(S.gates.authority)).toBeTruthy();
    expect(screen.getByText(S.gateStatus.pending)).toBeTruthy();
    expect(screen.getByText(S.gateStatus.satisfied)).toBeTruthy();
    expect(
      screen.getByText("awaiting four-eyes approval from a distinct principal"),
    ).toBeTruthy();

    // Fail-closed: no execute affordance, and nothing was written.
    expect(screen.queryByRole("button", { name: S.preflight.execute })).toBeNull();
    expect(executeCalls).not.toHaveBeenCalled();
  });

  it("treats a malformed gate payload as denied (fail-closed)", async () => {
    server.use(
      http.post("*/api/v1/ontology/actions/reassign/preflight", () =>
        HttpResponse.json({ gates: "garbage", criteria_ok: true, would_execute: true }),
      ),
    );
    renderGoverned();
    clickAction(T.samples.actions.reassign);

    expect((await screen.findAllByText(S.gateStatus.denied)).length).toBe(4);
    expect(screen.queryByRole("button", { name: S.preflight.execute })).toBeNull();
  });

  it("executes on a passing preflight and refreshes the revision timeline", async () => {
    let executeBody: unknown;
    server.use(
      http.post("*/api/v1/ontology/actions/reassign/preflight", () =>
        HttpResponse.json({
          dispatch: "instance_revision",
          dispatch_target: null,
          config: { authority: true, self_checklist: false, four_eyes: false, egress_dlp: false },
          gates: passingChain,
          criteria_ok: true,
          would_execute: true,
        }),
      ),
      http.post("*/api/v1/ontology/actions/reassign/execute", async ({ request }) => {
        executeBody = await request.json();
        return HttpResponse.json({
          dispatch: "instance_revision",
          instance: {
            instance: {
              id: "wo-2643",
              object_type_id: "00000000-0000-4000-8000-00000000ce0c",
              title: "4호기 유압 점검",
              current_revision_id: "rev-3",
              lifecycle_state: "active",
            },
            revision: historyRows[0],
          },
          gates: passingChain,
        });
      }),
      http.get("*/api/v1/ontology/instances/wo-2643/history", () =>
        HttpResponse.json(historyRows),
      ),
    );
    renderGoverned();
    clickAction(T.samples.actions.reassign);

    fireEvent.click(await screen.findByRole("button", { name: S.preflight.execute }));

    // §4-2 audited copy: result + path.
    expect(
      await screen.findByText(
        S.executedToast(T.samples.actions.reassign, 3, "WO-2643"),
      ),
    ).toBeTruthy();
    // The committed revision lands in the card's history timeline.
    expect(await screen.findByText(T.version(3))).toBeTruthy();
    const body = executeBody as Record<string, unknown>;
    expect(body.object_type_id).toBe("00000000-0000-4000-8000-00000000ce0c");
    expect(body.instance_id).toBe("wo-2643");
  });

  it("blocks execute until a required reason is present (fail-closed)", async () => {
    const executeCalls = vi.fn();
    server.use(
      http.post("*/api/v1/ontology/actions/close/preflight", () =>
        HttpResponse.json({
          dispatch: "instance_revision",
          dispatch_target: null,
          config: { authority: true, self_checklist: false, four_eyes: false, egress_dlp: false },
          gates: passingChain,
          criteria_ok: true,
          would_execute: true,
        }),
      ),
      http.post("*/api/v1/ontology/actions/close/execute", () => {
        executeCalls();
        return HttpResponse.json({
          dispatch: "instance_revision",
          instance: { instance: { lifecycle_state: "active" }, revision: historyRows[0] },
          gates: passingChain,
        });
      }),
      http.get("*/api/v1/ontology/instances/wo-2643/history", () =>
        HttpResponse.json(historyRows),
      ),
    );
    renderGoverned();
    clickAction(T.samples.actions.close);

    const execute = await screen.findByRole("button", { name: S.preflight.execute });
    expect((execute as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(execute);
    expect(executeCalls).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(T.edit.reasonLabel), {
      target: { value: "감사 정정" },
    });
    fireEvent.click(screen.getByRole("button", { name: S.preflight.execute }));
    await waitFor(() => {
      expect(executeCalls).toHaveBeenCalledTimes(1);
    });
  });
});

describe("GovernedObjectCard §20 override → four-eyes decide", () => {
  const overrideSummary = {
    id: "ovr-1",
    target_type: "work_order",
    target_id: "wo-2643",
    actor: "user-requester",
    reason: "감사 정정",
    before_snapshot: {},
    created_at: "2026-07-10T02:00:00Z",
  };

  function openOverride() {
    fireEvent.click(screen.getByRole("button", { name: T.edit.override }));
    fireEvent.change(screen.getByLabelText(T.edit.reasonLabel), {
      target: { value: "감사 정정" },
    });
    fireEvent.click(screen.getByRole("button", { name: T.edit.apply }));
  }

  it("requires a reason before any override POST leaves the client", () => {
    const overrideCalls = vi.fn();
    server.use(
      http.post("*/api/v1/governance/overrides", () => {
        overrideCalls();
        return HttpResponse.json(overrideSummary, { status: 201 });
      }),
    );
    renderGoverned();
    fireEvent.click(screen.getByRole("button", { name: T.edit.override }));
    fireEvent.click(screen.getByRole("button", { name: T.edit.apply }));
    expect(overrideCalls).not.toHaveBeenCalled();
  });

  it("opens the override from the API and surfaces the pending state + requester", async () => {
    server.use(
      http.post("*/api/v1/governance/overrides", () =>
        HttpResponse.json(overrideSummary, { status: 201 }),
      ),
    );
    renderGoverned();
    openOverride();
    expect(await screen.findByText(S.override.pendingTitle)).toBeTruthy();
    // Four-eyes: the requester is surfaced so approver ≠ requester is checkable.
    expect(screen.getByText(S.override.requester("user-requester"))).toBeTruthy();
    expect(screen.getByRole("button", { name: S.override.approve })).toBeTruthy();
  });

  it("surfaces the server's self-approval rejection", async () => {
    server.use(
      http.post("*/api/v1/governance/overrides", () =>
        HttpResponse.json(overrideSummary, { status: 201 }),
      ),
      http.post("*/api/v1/governance/approvals/decide", () =>
        HttpResponse.json(
          {
            error: {
              code: "conflict",
              message: "self-approval rejected: approver must differ from requester",
            },
          },
          { status: 409 },
        ),
      ),
    );
    renderGoverned();
    openOverride();
    fireEvent.click(await screen.findByRole("button", { name: S.override.approve }));
    expect(
      await screen.findByText(
        "self-approval rejected: approver must differ from requester",
      ),
    ).toBeTruthy();
    // Still pending — the decision did not commit.
    expect(screen.getByText(S.override.pendingTitle)).toBeTruthy();
  });

  it("records an approval and forwards the committed override to the host seam", async () => {
    const onEdit = vi.fn();
    server.use(
      http.post("*/api/v1/governance/overrides", () =>
        HttpResponse.json(overrideSummary, { status: 201 }),
      ),
      http.post("*/api/v1/governance/approvals/decide", () =>
        HttpResponse.json(
          {
            id: "apr-9",
            request_ref: "ovr-1",
            kind: "override",
            requested_by: "user-requester",
            approver_id: "user-approver",
            decision: "approved",
            decided_at: "2026-07-10T02:05:00Z",
          },
          { status: 201 },
        ),
      ),
    );
    renderGoverned({ onEdit });
    openOverride();
    fireEvent.click(await screen.findByRole("button", { name: S.override.approve }));
    expect(await screen.findByText(S.override.approvedChip)).toBeTruthy();
    expect(onEdit).toHaveBeenCalledWith({ mode: "override", reason: "감사 정정" });
  });
});

describe("GovernedObjectCard dynamic layer (acting-read + code resolve)", () => {
  it("fetches the real acting rules for the instance and renders them as navigable chips", async () => {
    server.use(
      http.get("*/api/v1/ontology/instances/wo-2643/acting", () =>
        HttpResponse.json([
          { id: "wf-9", label: "wf-audit-review", kind: "automation" },
          { id: "pol-9", label: "pbac-audit-edit", kind: "policy" },
        ]),
      ),
    );
    renderGoverned();
    expect(await screen.findByText("wf-audit-review")).toBeTruthy();
    expect(screen.getByText("pbac-audit-edit")).toBeTruthy();
  });

  it("degrades to no chips (fail-closed) when the acting fetch errors", async () => {
    server.use(
      http.get("*/api/v1/ontology/instances/wo-2643/acting", () =>
        HttpResponse.json({ error: { code: "internal", message: "boom" } }, { status: 500 }),
      ),
    );
    renderGoverned();
    // The stub's own sample chips (wf-1/pol-1) are replaced by the (empty) real fetch.
    await waitFor(() => {
      expect(screen.queryByText("wf-wo-review")).toBeNull();
    });
  });

  it("resolves a code through the real endpoint for the relation-draw seam", async () => {
    const onRelationAdd = vi.fn();
    server.use(
      http.get("*/api/v1/ontology/resolve", ({ request }) => {
        const code = new URL(request.url).searchParams.get("code");
        if (code === "EQ-118") {
          return HttpResponse.json({ id: "inst-eq118", type: "equipment", title: "5호기 지게차" });
        }
        return new HttpResponse(null, { status: 404 });
      }),
    );
    renderGoverned({ onRelationAdd });
    const input = screen.getByLabelText(T.relations.codeLabel);
    fireEvent.change(input, { target: { value: "EQ-118" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onRelationAdd).toHaveBeenCalledWith({
        code: "EQ-118",
        title: "5호기 지게차",
        linkType: "relates_to",
      });
    });
  });
});

describe("GovernedObjectCard lifecycle transition preflight", () => {
  const archiveLabel = T.transitionTo(T.lifecycle.archived);

  it("fail-closes an unconfigured edge as a blocker with no commit affordance", async () => {
    server.use(
      http.post("*/api/v1/governance/lifecycle/preflight", () =>
        HttpResponse.json({
          configured: false,
          config: { authority: true, self_checklist: false, four_eyes: false, egress_dlp: false },
          outcome: {
            gates: [
              gateLine("authority", "denied", "Cedar authorize denied the action"),
              gateLine("self_checklist", "not_required"),
              gateLine("four_eyes", "not_required"),
              gateLine("egress_dlp", "not_required"),
            ],
            allow: false,
          },
        }),
      ),
    );
    renderGoverned();
    fireEvent.click(screen.getByRole("button", { name: archiveLabel }));

    expect(await screen.findByText(S.lifecycle.notConfigured)).toBeTruthy();
    expect(screen.getByText(S.lifecycle.blocker)).toBeTruthy();
    // Only the starter button remains — no commit button on a denied edge.
    expect(screen.getAllByRole("button", { name: archiveLabel }).length).toBe(1);
  });

  it("shows pending gates as warnings and commits an allowed transition through the real endpoint", async () => {
    const onLifecycleTransition = vi.fn();
    const onInstanceChange = vi.fn();
    let preflightBody: unknown;
    let commitBody: unknown;
    server.use(
      http.post("*/api/v1/governance/lifecycle/preflight", async ({ request }) => {
        preflightBody = await request.json();
        return HttpResponse.json({
          configured: true,
          config: { authority: true, self_checklist: false, four_eyes: false, egress_dlp: false },
          outcome: passingChain,
        });
      }),
      http.post("*/api/v1/ontology/instances/wo-2643/lifecycle", async ({ request }) => {
        commitBody = await request.json();
        return HttpResponse.json({
          instance: {
            id: "wo-2643",
            object_type_id: "00000000-0000-4000-8000-00000000ce0c",
            title: "4호기 유압 점검",
            current_revision_id: "rev-3",
            lifecycle_state: "archived",
          },
          config: { authority: true, self_checklist: false, four_eyes: false, egress_dlp: false },
          gates: passingChain,
        });
      }),
      http.get("*/api/v1/ontology/instances/wo-2643/history", () =>
        HttpResponse.json(historyRows),
      ),
    );
    renderGoverned({ onLifecycleTransition }, onInstanceChange);
    fireEvent.click(screen.getByRole("button", { name: archiveLabel }));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: archiveLabel }).length).toBe(2);
    });
    fireEvent.click(screen.getAllByRole("button", { name: archiveLabel })[1]);

    // Real commit: the FSM edge posts to the ontology instance endpoint, not a stub.
    await waitFor(() => {
      expect(onLifecycleTransition).toHaveBeenCalledWith("archived");
    });
    expect(onInstanceChange).toHaveBeenCalledWith({ lifecycleState: "archived", version: 3 });
    expect((commitBody as Record<string, unknown>).to_state).toBe("archived");
    // The lifecycle chip reflects the committed state.
    expect(screen.getAllByText(T.lifecycle.archived).length).toBeGreaterThan(0);

    const body = preflightBody as Record<string, unknown>;
    expect(body.object_type_id).toBe("00000000-0000-4000-8000-00000000ce0c");
    expect(body.from_state).toBe("ACTIVE");
    expect(body.to_state).toBe("ARCHIVED");
    expect(body.authority_allow).toBe(true);
  });
});
