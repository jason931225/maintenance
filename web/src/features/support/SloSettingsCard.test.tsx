import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  defaultSloSettings,
  stageSloEdit,
  type SloSettingState,
} from "./slo-settings";
import { SloSettingsCard } from "./SloSettingsCard";
import { KO_CONSOLE_SUPPORTSLO as T } from "./supportslo-ko.test";

const NO_BREACHES = {
  SYSTEM_BUG: 0,
  ACCESS_REQUEST: 0,
  OPERATIONAL: 0,
  EQUIPMENT_INQUIRY: 0,
  COMPLAINT: 0,
  OTHER: 0,
};

const ADMIN = { id: "u-admin", name: "관리자A" };
const OTHER_ADMIN = { id: "u-admin-2", name: "관리자B" };

function Harness({
  initial = defaultSloSettings(),
  canManage = true,
  actor = ADMIN,
}: {
  initial?: SloSettingState;
  canManage?: boolean;
  actor?: { id: string; name: string };
}) {
  const [state, setState] = useState(initial);
  return (
    <SloSettingsCard
      state={state}
      onChange={setState}
      canManage={canManage}
      actor={actor}
      breaches={NO_BREACHES}
    />
  );
}

describe("SloSettingsCard", () => {
  it("renders the active per-type rules with the SLO scope chip", () => {
    render(<Harness />);
    expect(screen.getByText(T.settings.title)).toBeVisible();
    expect(screen.getByText(T.settings.scopeChip)).toBeVisible();
    // §4-26: internal target is labeled SLO, never SLA (contractual).
    expect(screen.queryByText(/SLA/)).toBeNull();
    expect(screen.getByText(T.settings.version(1))).toBeVisible();
    // One row per ticket type with its escalation target.
    expect(screen.getAllByText(T.settings.targets.TEAM_LEAD).length).toBe(4);
    expect(screen.getByText(T.settings.targets.ADMIN)).toBeVisible();
    expect(screen.getByText(T.settings.targets.DEDICATED)).toBeVisible();
  });

  it("hides every management control from non-managers (deny-by-omission)", () => {
    render(<Harness canManage={false} />);
    expect(screen.queryByRole("button", { name: T.settings.edit })).toBeNull();
  });

  it("stages an edit as 개정 대기 v+1 instead of hot-swapping the active rules", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: T.settings.edit }));
    const threshold = screen.getByLabelText(
      T.settings.fieldAria("시스템 오류", T.settings.threshold),
    );
    await user.clear(threshold);
    await user.type(threshold, "2");
    await user.click(screen.getByRole("button", { name: T.settings.save }));

    // Staged, not applied: pending banner up, version still v1.
    expect(screen.getByText(T.settings.pending(2))).toBeVisible();
    expect(screen.getByText(T.settings.keepActive)).toBeVisible();
    expect(screen.getByText(T.settings.stagedBy(ADMIN.name))).toBeVisible();
    expect(screen.getByText(T.settings.version(1))).toBeVisible();
    // Four-eyes: the stager gets 철회 but never the approve control.
    expect(
      screen.getByRole("button", { name: T.settings.withdraw }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: T.settings.approve }),
    ).toBeNull();
  });

  it("lets a second admin 적용 승인 the staged revision (four-eyes)", async () => {
    const user = userEvent.setup();
    const staged = stageSloEdit(
      defaultSloSettings(),
      defaultSloSettings().active,
      ADMIN,
    );
    render(<Harness initial={staged} actor={OTHER_ADMIN} />);

    await user.click(screen.getByRole("button", { name: T.settings.approve }));
    expect(screen.getByText(T.settings.version(2))).toBeVisible();
    expect(screen.queryByText(T.settings.pending(2))).toBeNull();
  });

  it("철회 drops the staged revision and keeps the active setting", async () => {
    const user = userEvent.setup();
    const staged = stageSloEdit(
      defaultSloSettings(),
      defaultSloSettings().active,
      ADMIN,
    );
    render(<Harness initial={staged} />);

    await user.click(screen.getByRole("button", { name: T.settings.withdraw }));
    expect(screen.queryByText(T.settings.pending(2))).toBeNull();
    expect(screen.getByText(T.settings.version(1))).toBeVisible();
  });
});
