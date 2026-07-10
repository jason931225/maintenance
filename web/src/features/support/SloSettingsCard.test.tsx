import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { SloSettingsCard } from "./SloSettingsCard";
import { KO_CONSOLE_SUPPORTSLO as T } from "./supportslo-ko.test";
import { supportSloStringsFilled } from "./supportslo-strings";

// ko.console.supportslo.engine is not wired yet (this lane never edits
// ko.ts) — the component reads the English ENGINE_FALLBACK via
// supportSloStringsFilled(); assert against that same source of truth.
const E = supportSloStringsFilled().engine;

const ADMIN = { id: "u-admin", name: "관리자A" };
const OTHER_ADMIN = { id: "u-admin-2", name: "관리자B" };

/** Real REST shapes (api/ontology.ts + api/ontologyActions.ts). */
function mockApi(
  seeded: { ticket_type: string; threshold_minutes: number; window: string; escalation_target: string; version: number }[] = [],
): ConsoleApiClient {
  return {
    GET: vi.fn((path: string) => {
      if (path === "/api/v1/ontology/object-types/{key}") {
        return Promise.resolve({
          data: {
            object_type: { id: "slo-type", stable_key: "support_slo_setting", title: "SLO 설정", backing_kind: "instance", schema_version: 1, lifecycle_state: "published" },
            title_property_key: "ticket_type",
            backing_table: null,
            primary_key_property: null,
            properties: [],
            links: [],
            actions: [],
            analytics: [],
          },
          error: undefined,
          response: { status: 200 },
        });
      }
      if (path === "/api/v1/ontology/instances") {
        return Promise.resolve({
          data: seeded.map((rule, index) => ({
            instance: { id: `slo-${rule.ticket_type}`, object_type_id: "slo-type", title: rule.ticket_type, current_revision_id: `rev-${String(index)}`, lifecycle_state: "active" },
            revision: {
              id: `rev-${String(index)}`,
              instance_id: `slo-${rule.ticket_type}`,
              version: rule.version,
              attributes: rule,
              valid_from: "2026-07-10T00:00:00Z",
              valid_to: null,
              action_type_id: null,
              actor: null,
              reason: null,
              prev_hash: "0".repeat(64),
              row_hash: "a".repeat(64),
            },
          })),
          error: undefined,
          response: { status: 200 },
        });
      }
      return Promise.resolve({ data: [], error: undefined, response: { status: 200 } });
    }),
    POST: vi.fn((_path: string, options: { body: { params: Record<string, unknown> } }) =>
      Promise.resolve({
        data: {
          instance: {
            instance: { id: `slo-${String(options.body.params.ticket_type)}`, title: String(options.body.params.ticket_type), lifecycle_state: "active" },
            revision: { version: 2, attributes: options.body.params },
          },
          gates: { allow: true, gates: [] },
        },
        error: undefined,
        response: { status: 200 },
      }),
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ConsoleApiClient;
}

const SEEDED = [
  { ticket_type: "incident", threshold_minutes: 480, window: "business_hours", escalation_target: "on-call", version: 1 },
  { ticket_type: "request", threshold_minutes: 1440, window: "business_hours", escalation_target: "team-lead", version: 1 },
  { ticket_type: "change", threshold_minutes: 2880, window: "calendar", escalation_target: "admin", version: 1 },
];

/** Toggle the signed-in principal without remounting the card's fetched state. */
function Harness({ api }: { api: ConsoleApiClient }) {
  const [actor, setActor] = useState(ADMIN);
  return (
    <div>
      <button type="button" onClick={() => { setActor(OTHER_ADMIN); }}>
        switch-to-other-admin
      </button>
      <SloSettingsCard api={api} canManage actor={actor} />
    </div>
  );
}

describe("SloSettingsCard", () => {
  it("lists the real support_slo_setting engine instances", async () => {
    render(<SloSettingsCard api={mockApi(SEEDED)} canManage actor={ADMIN} />);
    expect(await screen.findByText(E.title)).toBeVisible();
    expect(screen.getByText("on-call")).toBeVisible();
    expect(screen.getByText("team-lead")).toBeVisible();
    expect(screen.getAllByText(E.lastRevision(1)).length).toBeGreaterThan(0);
  });

  it("shows the honest not-saved state for a ticket type with no instance yet", async () => {
    render(<SloSettingsCard api={mockApi([])} canManage actor={ADMIN} />);
    await screen.findByText(E.title);
    expect(screen.getAllByText(E.notSaved).length).toBeGreaterThan(0);
  });

  it("hides every management control from non-managers (deny-by-omission)", async () => {
    render(<SloSettingsCard api={mockApi(SEEDED)} canManage={false} actor={ADMIN} />);
    await screen.findByText(E.title);
    expect(screen.queryByRole("button", { name: T.settings.edit })).toBeNull();
  });

  it("stages an edit locally (no network) instead of hot-swapping the active rules", async () => {
    const user = userEvent.setup();
    const api = mockApi(SEEDED);
    render(<SloSettingsCard api={api} canManage actor={ADMIN} />);
    await screen.findByText(E.title);

    await user.click(screen.getByRole("button", { name: T.settings.edit }));
    const threshold = screen.getByLabelText(
      E.fieldAria(E.ticketTypes.incident, E.thresholdMinutes),
    );
    await user.clear(threshold);
    await user.type(threshold, "30");
    await user.click(screen.getByRole("button", { name: T.settings.save }));

    // Staged, not committed: pending banner up, no POST yet.
    expect(screen.getByText(T.settings.stagedBy(ADMIN.name))).toBeVisible();
    expect(screen.getByText(T.settings.keepActive)).toBeVisible();
    expect(api.POST).not.toHaveBeenCalled();
    // Four-eyes: the stager gets 철회 but never the approve control.
    expect(screen.getByRole("button", { name: T.settings.withdraw })).toBeVisible();
    expect(screen.queryByRole("button", { name: E.commit })).toBeNull();
  });

  it("lets a second admin 적용 승인 the staged revision — commits the real instance revision", async () => {
    const user = userEvent.setup();
    const api = mockApi(SEEDED);
    render(<Harness api={api} />);
    await screen.findByText(E.title);

    await user.click(screen.getByRole("button", { name: T.settings.edit }));
    const escalation = screen.getByLabelText(
      E.fieldAria(E.ticketTypes.incident, E.escalationLabel),
    );
    await user.clear(escalation);
    await user.type(escalation, "sre-oncall");
    await user.click(screen.getByRole("button", { name: T.settings.save }));

    await user.click(screen.getByRole("button", { name: "switch-to-other-admin" }));
    await user.click(screen.getByRole("button", { name: E.commit }));

    // 적용 승인 is what actually hits the network — one commit per ticket type.
    expect(await screen.findByText("sre-oncall")).toBeVisible();
    expect(api.POST).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(T.settings.stagedBy(ADMIN.name))).toBeNull();
  });

  it("철회 drops the staged revision without any network call", async () => {
    const user = userEvent.setup();
    const api = mockApi(SEEDED);
    render(<SloSettingsCard api={api} canManage actor={ADMIN} />);
    await screen.findByText(E.title);

    await user.click(screen.getByRole("button", { name: T.settings.edit }));
    await user.click(screen.getByRole("button", { name: T.settings.save }));
    expect(screen.getByText(T.settings.stagedBy(ADMIN.name))).toBeVisible();

    await user.click(screen.getByRole("button", { name: T.settings.withdraw }));
    expect(screen.queryByText(T.settings.stagedBy(ADMIN.name))).toBeNull();
    expect(api.POST).not.toHaveBeenCalled();
  });
});
