import { useEffect, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
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
  commitEngineSloRule,
  ENGINE_SLO_WINDOWS,
  ENGINE_TICKET_TYPES,
  fetchEngineSloRules,
  type EngineSloRule,
  type EngineSloRules,
  type EngineSloWindow,
  type EngineTicketType,
} from "./slo-settings";
import { supportSloStrings, supportSloStringsFilled } from "./supportslo-strings";

// PBAC actions (deny-by-omission via PolicyGated). wire-pending: Phase C —
// Cedar authorize() decisions replace the role-derived gate below (same
// pattern as AutomatePage's AUTOMATE_RUNTIME_GATE).
const ACT = {
  edit: "console.supportslo.setting.edit",
  approveRevision: "console.supportslo.setting.revision.approve",
  withdrawRevision: "console.supportslo.setting.revision.withdraw",
} as const;

export interface SloSettingsCardProps {
  api: ConsoleApiClient;
  /** ADMIN/SUPER_ADMIN manage the setting; others get a read-only card. */
  canManage: boolean;
  /** Signed-in principal — the four-eyes subject for stage/approve. */
  actor: { id: string; name: string };
}

interface PendingRevision {
  rules: EngineSloRules;
  stagedById: string;
  stagedByName: string;
}

type ReadState = "loading" | "idle" | "error";

/**
 * The support SLO policy as a real, governed setting object (§4-26): per
 * ticket_type (incident/request/change — the engine's seeded taxonomy) a
 * threshold(min)/window/escalation target, listed and committed through
 * GET /ontology/instances?type=support_slo_setting and
 * POST /ontology/actions/create/execute (be2-config-objects). Editing stages
 * a local pendingRev (§3.9.0) — nothing hits the network until 적용 승인
 * (four-eyes: the stager never sees the approve control), which commits the
 * real revision; 철회 discards the local draft, never a network call.
 */
export function SloSettingsCard({ api, canManage, actor }: SloSettingsCardProps) {
  const S = supportSloStringsFilled().engine;
  const [readState, setReadState] = useState<ReadState>("loading");
  const [objectTypeId, setObjectTypeId] = useState<string | null>(null);
  const [active, setActive] = useState<EngineSloRules | null>(null);
  const [pending, setPending] = useState<PendingRevision | null>(null);
  const [draft, setDraft] = useState<EngineSloRules | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchEngineSloRules(api)
      .then(({ objectTypeId: typeId, rules }) => {
        if (cancelled) return;
        setObjectTypeId(typeId);
        setActive(rules);
        setReadState("idle");
      })
      .catch(() => {
        if (!cancelled) setReadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const gate: PolicyGate = {
    can: (action) =>
      canManage &&
      Object.values(ACT).includes(action as (typeof ACT)[keyof typeof ACT]),
  };

  function saveDraft(): void {
    if (!draft) return;
    // §3.9.0: local stage only — no network call until 적용 승인.
    setPending({ rules: draft, stagedById: actor.id, stagedByName: actor.name });
    setDraft(null);
  }

  function withdraw(): void {
    setPending(null);
  }

  function approve(): void {
    if (!pending || !objectTypeId || pending.stagedById === actor.id) return;
    setCommitting(true);
    setCommitError(false);
    void (async () => {
      try {
        const committed = await Promise.all(
          ENGINE_TICKET_TYPES.map((ticketType) =>
            commitEngineSloRule(api, objectTypeId, pending.rules[ticketType]),
          ),
        );
        const next: EngineSloRules = { ...pending.rules };
        for (const rule of committed) next[rule.ticketType] = rule;
        setActive(next);
        setPending(null);
      } catch {
        setCommitError(true);
      } finally {
        setCommitting(false);
      }
    })();
  }

  if (readState === "loading") {
    return (
      <Card>
        <p className="text-sm text-steel">{S.loading}</p>
      </Card>
    );
  }
  if (readState === "error" || !active) {
    return (
      <Card>
        <p className="text-sm text-steel">{S.error}</p>
      </Card>
    );
  }

  const shown = draft ?? pending?.rules ?? active;
  // Next version the pending stage would commit as — the max across the 3
  // real per-ticket-type revisions + 1 (never a fabricated counter).
  const nextVersion = Math.max(...ENGINE_TICKET_TYPES.map((t) => active[t].version)) + 1;

  return (
    <PolicyGateProvider gate={gate}>
      <Card className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">{S.title}</h2>
            <Badge className={toneBadgeClass("info")}>{supportSloStrings().settings.scopeChip}</Badge>
          </div>
          {draft ? (
            <div className="flex items-center gap-2">
              <PolicyGated action={ACT.edit}>
                <Button type="button" variant="secondary" onClick={saveDraft}>
                  {supportSloStrings().settings.save}
                </Button>
              </PolicyGated>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDraft(null);
                }}
              >
                {supportSloStrings().settings.cancel}
              </Button>
            </div>
          ) : (
            <PolicyGated action={ACT.edit}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDraft(structuredClone(pending?.rules ?? active));
                }}
              >
                {supportSloStrings().settings.edit}
              </Button>
            </PolicyGated>
          )}
        </div>

        {pending ? (
          <div
            role="status"
            aria-label={supportSloStrings().settings.pending(nextVersion)}
            className="flex flex-wrap items-center gap-2 rounded-md border border-tone-warning-border bg-tone-warning-bg p-3"
          >
            <Badge className={toneBadgeClass("warning")}>{supportSloStrings().settings.pending(nextVersion)}</Badge>
            <Badge>{supportSloStrings().settings.stagedBy(pending.stagedByName)}</Badge>
            <Badge className={toneBadgeClass("info")}>{supportSloStrings().settings.keepActive}</Badge>
            {commitError ? <Badge className={toneBadgeClass("danger")}>{S.error}</Badge> : null}
            {/* Four-eyes: the stager never sees the approve control. */}
            {pending.stagedById !== actor.id ? (
              <PolicyGated action={ACT.approveRevision}>
                <Button type="button" variant="secondary" disabled={committing} onClick={approve}>
                  {S.commit}
                </Button>
              </PolicyGated>
            ) : null}
            <PolicyGated action={ACT.withdrawRevision}>
              <Button type="button" variant="ghost" onClick={withdraw}>
                {supportSloStrings().settings.withdraw}
              </Button>
            </PolicyGated>
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-steel">
                <th scope="col" className="py-2 pr-3">{supportSloStrings().settings.category}</th>
                <th scope="col" className="py-2 pr-3">{S.thresholdMinutes}</th>
                <th scope="col" className="py-2 pr-3">{S.windowLabel}</th>
                <th scope="col" className="py-2 pr-3">{S.escalationLabel}</th>
                <th scope="col" className="py-2">{S.revisionColumn}</th>
              </tr>
            </thead>
            <tbody>
              {ENGINE_TICKET_TYPES.map((ticketType) => (
                <EngineSloRuleRow
                  key={ticketType}
                  ticketType={ticketType}
                  rules={shown}
                  draft={draft}
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

function EngineSloRuleRow({
  ticketType,
  rules,
  draft,
  onDraftChange,
}: {
  ticketType: EngineTicketType;
  rules: EngineSloRules;
  draft: EngineSloRules | null;
  onDraftChange: (next: EngineSloRules) => void;
}) {
  const S = supportSloStringsFilled().engine;
  const rule = rules[ticketType];
  const label = S.ticketTypes[ticketType];

  function patch(patchRule: Partial<EngineSloRule>): void {
    if (!draft) return;
    onDraftChange({ ...draft, [ticketType]: { ...draft[ticketType], ...patchRule } });
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
            aria-label={S.fieldAria(label, S.thresholdMinutes)}
            value={rule.thresholdMinutes}
            onChange={(event) => {
              patch({ thresholdMinutes: Math.max(1, Number(event.currentTarget.value)) });
            }}
          />
        ) : (
          <span className="text-ink">{rule.thresholdMinutes}</span>
        )}
      </td>
      <td className="py-2 pr-3">
        {draft ? (
          <Select
            aria-label={S.fieldAria(label, S.windowLabel)}
            value={rule.window}
            onChange={(event) => {
              patch({ window: event.currentTarget.value as EngineSloWindow });
            }}
          >
            {ENGINE_SLO_WINDOWS.map((window) => (
              <option key={window} value={window}>
                {S.windows[window]}
              </option>
            ))}
          </Select>
        ) : (
          <Badge>{S.windows[rule.window]}</Badge>
        )}
      </td>
      <td className="py-2 pr-3">
        {draft ? (
          <Input
            className="w-40"
            aria-label={S.fieldAria(label, S.escalationLabel)}
            value={rule.escalationTarget}
            onChange={(event) => {
              patch({ escalationTarget: event.currentTarget.value });
            }}
          />
        ) : (
          <span className="text-ink">{rule.escalationTarget || S.notSaved}</span>
        )}
      </td>
      <td className="py-2">
        <Badge className={rule.instanceId ? toneBadgeClass("neutral") : toneBadgeClass("warning")}>
          {rule.instanceId ? S.lastRevision(rule.version) : S.notSaved}
        </Badge>
      </td>
    </tr>
  );
}
