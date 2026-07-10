import { useState } from "react";

import type { SupportTicketCategory } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import {
  PolicyGateProvider,
  PolicyGated,
  type PolicyGate,
} from "../../console/policy";
import { toneBadgeClass } from "../../lib/semantic";
import {
  SLO_ESCALATION_TARGETS,
  stageSloEdit,
  withdrawSloRevision,
  approveSloRevision,
  type SloEscalationTarget,
  type SloRules,
  type SloSettingState,
} from "./slo-settings";
import { SUPPORT_CATEGORIES, categoryLabel } from "./support-format";
import { supportSloStrings } from "./supportslo-strings";

// PBAC actions (deny-by-omission via PolicyGated). wire-pending: Phase C —
// Cedar authorize() decisions replace the role-derived gate below (same
// pattern as AutomatePage's AUTOMATE_RUNTIME_GATE).
const ACT = {
  edit: "console.supportslo.setting.edit",
  approveRevision: "console.supportslo.setting.revision.approve",
  withdrawRevision: "console.supportslo.setting.revision.withdraw",
} as const;

export interface SloSettingsCardProps {
  state: SloSettingState;
  onChange: (next: SloSettingState) => void;
  /** ADMIN/SUPER_ADMIN manage the setting; others get a read-only card. */
  canManage: boolean;
  /** Signed-in principal — the four-eyes subject for stage/approve. */
  actor: { id: string; name: string };
  /** Breach tally per type over that type's window (state-derived). */
  breaches: Record<SupportTicketCategory, number>;
}

/**
 * The support SLO policy as a configurable setting object (§4-26): per ticket
 * type a response threshold / evaluation window / escalation target, edited
 * no-code with typed fields (§4-19). Editing the ACTIVE setting stages a
 * pendingRev v+1 (§3.9.0) — the active rules keep driving the board until
 * 적용 승인 (four-eyes: stager never sees the approve control) or 철회.
 */
export function SloSettingsCard({
  state,
  onChange,
  canManage,
  actor,
  breaches,
}: SloSettingsCardProps) {
  const S = supportSloStrings();
  const [draft, setDraft] = useState<SloRules | null>(null);
  const gate: PolicyGate = {
    can: (action) =>
      canManage &&
      Object.values(ACT).includes(action as (typeof ACT)[keyof typeof ACT]),
  };

  function saveDraft(): void {
    if (!draft) return;
    // §3.9.0: the setting is ACTIVE, so an edit stages — never a hot swap.
    onChange(stageSloEdit(state, draft, actor));
    setDraft(null);
  }

  const shown = draft ?? state.pending?.rules ?? state.active;

  return (
    <PolicyGateProvider gate={gate}>
      <Card className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">
              {S.settings.title}
            </h2>
            <Badge className={toneBadgeClass("info")}>
              {S.settings.scopeChip}
            </Badge>
            <Badge>{S.settings.version(state.version)}</Badge>
          </div>
          {draft ? (
            <div className="flex items-center gap-2">
              <PolicyGated action={ACT.edit}>
                <Button type="button" variant="secondary" onClick={saveDraft}>
                  {S.settings.save}
                </Button>
              </PolicyGated>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDraft(null);
                }}
              >
                {S.settings.cancel}
              </Button>
            </div>
          ) : (
            <PolicyGated action={ACT.edit}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDraft(
                    structuredClone(state.pending?.rules ?? state.active),
                  );
                }}
              >
                {S.settings.edit}
              </Button>
            </PolicyGated>
          )}
        </div>

        {state.pending ? (
          <div
            role="status"
            aria-label={S.settings.pending(state.pending.version)}
            className="flex flex-wrap items-center gap-2 rounded-md border border-tone-warning-border bg-tone-warning-bg p-3"
          >
            <Badge className={toneBadgeClass("warning")}>
              {S.settings.pending(state.pending.version)}
            </Badge>
            <Badge>{S.settings.stagedBy(state.pending.stagedByName)}</Badge>
            <Badge className={toneBadgeClass("info")}>
              {S.settings.keepActive}
            </Badge>
            {/* Four-eyes: the stager never sees the approve control. */}
            {state.pending.stagedById !== actor.id ? (
              <PolicyGated action={ACT.approveRevision}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    onChange(approveSloRevision(state, actor.id));
                  }}
                >
                  {S.settings.approve}
                </Button>
              </PolicyGated>
            ) : null}
            <PolicyGated action={ACT.withdrawRevision}>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onChange(withdrawSloRevision(state));
                }}
              >
                {S.settings.withdraw}
              </Button>
            </PolicyGated>
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-steel">
                <th scope="col" className="py-2 pr-3">
                  {S.settings.category}
                </th>
                <th scope="col" className="py-2 pr-3">
                  {S.settings.threshold}
                </th>
                <th scope="col" className="py-2 pr-3">
                  {S.settings.window}
                </th>
                <th scope="col" className="py-2 pr-3">
                  {S.settings.escalation}
                </th>
                <th scope="col" className="py-2">
                  {S.settings.breachColumn}
                </th>
              </tr>
            </thead>
            <tbody>
              {SUPPORT_CATEGORIES.map((category) => (
                <SloRuleRow
                  key={category}
                  category={category}
                  rules={shown}
                  draft={draft}
                  breachCount={breaches[category]}
                  onDraftChange={setDraft}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </PolicyGateProvider>
  );
}

function SloRuleRow({
  category,
  rules,
  draft,
  breachCount,
  onDraftChange,
}: {
  category: SupportTicketCategory;
  rules: SloRules;
  draft: SloRules | null;
  breachCount: number;
  onDraftChange: (next: SloRules) => void;
}) {
  const S = supportSloStrings();
  const rule = rules[category];
  const label = categoryLabel(category);

  function patch(patchRule: Partial<SloRules[SupportTicketCategory]>): void {
    if (!draft) return;
    onDraftChange({
      ...draft,
      [category]: { ...draft[category], ...patchRule },
    });
  }

  return (
    <tr className="border-t border-line">
      <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">
        {label}
      </th>
      <td className="py-2 pr-3">
        {draft ? (
          <Input
            type="number"
            min={1}
            className="w-24"
            aria-label={S.settings.fieldAria(label, S.settings.threshold)}
            value={rule.thresholdHours}
            onChange={(event) => {
              patch({
                thresholdHours: Math.max(1, Number(event.currentTarget.value)),
              });
            }}
          />
        ) : (
          <span className="text-ink">{rule.thresholdHours}</span>
        )}
      </td>
      <td className="py-2 pr-3">
        {draft ? (
          <Input
            type="number"
            min={1}
            className="w-24"
            aria-label={S.settings.fieldAria(label, S.settings.window)}
            value={rule.windowDays}
            onChange={(event) => {
              patch({
                windowDays: Math.max(1, Number(event.currentTarget.value)),
              });
            }}
          />
        ) : (
          <span className="text-ink">{rule.windowDays}</span>
        )}
      </td>
      <td className="py-2 pr-3">
        {draft ? (
          <Select
            aria-label={S.settings.fieldAria(label, S.settings.escalation)}
            value={rule.escalationTarget}
            onChange={(event) => {
              patch({
                escalationTarget: event.currentTarget
                  .value as SloEscalationTarget,
              });
            }}
          >
            {SLO_ESCALATION_TARGETS.map((target) => (
              <option key={target} value={target}>
                {S.settings.targets[target]}
              </option>
            ))}
          </Select>
        ) : (
          <Badge>{S.settings.targets[rule.escalationTarget]}</Badge>
        )}
      </td>
      <td className="py-2">
        <Badge
          className={
            breachCount > 0
              ? toneBadgeClass("warning")
              : toneBadgeClass("neutral")
          }
        >
          {S.settings.breaches(breachCount)}
        </Badge>
      </td>
    </tr>
  );
}
