// GovernedObjectCard — ObjectCard with its kinetic/dynamic layers wired to the
// real action + governance REST (§16 gate chain, §20 override, lifecycle
// preflight). Composition keeps ObjectCard presentational: the card's action /
// edit gestures route into the flows below instead of bare host callbacks.
import { useCallback, useState, type CSSProperties, type ReactNode } from "react";

import {
  executeOntologyAction,
  fetchInstanceHistory,
  preflightOntologyAction,
  type ActionPreflight,
  type GateLine,
  type InstanceRevision,
  type OntologyActionRequest,
} from "../../api/ontologyActions";
import {
  decideGovernanceApproval,
  openGovernanceOverride,
  preflightLifecycleTransition,
  type LifecyclePreflight,
  type OverridePending,
  type WireLifecycleState,
} from "../../api/governance";
import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated, usePolicyGate } from "../policy";
import { ObjectCard } from "./ObjectCard";
import { objectCardGovStrings } from "./strings";
import {
  OBJECT_CARD_ACTIONS,
  type ObjectCardAction,
  type ObjectCardDescriptor,
  type ObjectCardHandlers,
  type ObjectCardRevision,
  type ObjectLifecycleState,
} from "./types";

const T = ko.console.objectcard;

/** Base legal FSM edges (governance domain LIFECYCLE_TRANSITIONS). */
const NEXT_STATES: Record<ObjectLifecycleState, ObjectLifecycleState[]> = {
  draft: ["active", "archived"],
  active: ["locked", "archived"],
  locked: ["active", "archived"],
  archived: ["active", "disposed"],
  disposed: [],
};

function toWireState(state: ObjectLifecycleState): WireLifecycleState {
  return state.toUpperCase() as WireLifecycleState;
}

const panelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  padding: "var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const panelTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const gateRowStyle: CSSProperties = {
  ...rowStyle,
  justifyContent: "space-between",
  padding: "var(--sp-2) 0",
  borderBottom: "1px solid var(--border-soft)",
};

const monoStyle: CSSProperties = {
  color: "var(--faint)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const reasonTextStyle: CSSProperties = {
  margin: 0,
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-medium)",
};

const buttonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--signal)",
  background: "var(--signal)",
};

const textareaStyle: CSSProperties = {
  minHeight: 60,
  minWidth: 0,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "var(--sp-2) var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
  resize: "vertical",
};

const fieldStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

function gateTone(status: GateLine["status"]): "neutral" | "ok" | "warn" | "danger" {
  switch (status) {
    case "satisfied":
      return "ok";
    case "pending":
      return "warn";
    case "denied":
      return "danger";
    default:
      return "neutral";
  }
}

function GateLines({ gates }: { gates: GateLine[] }) {
  const S = objectCardGovStrings();
  return (
    <div style={{ display: "grid" }}>
      {gates.map((gate) => (
        <div key={gate.gate} style={gateRowStyle}>
          <span style={rowStyle}>
            <StatusChip tone="neutral">{S.gates[gate.gate]}</StatusChip>
            {gate.reason ? <span style={reasonTextStyle}>{gate.reason}</span> : null}
          </span>
          <StatusChip
            tone={gateTone(gate.status)}
            role={gate.status === "denied" ? "alert" : "status"}
          >
            {S.gateStatus[gate.status]}
          </StatusChip>
        </div>
      ))}
    </div>
  );
}

function ErrorChip({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <StatusChip tone="danger" role="alert">
      {message}
    </StatusChip>
  );
}

// ── Action preflight → execute flow ──────────────────────────────────────

interface ActionFlow {
  action: ObjectCardAction;
  fourEyesRef: string;
  preflight: ActionPreflight | null;
  checking: boolean;
  executing: boolean;
  checklistAck: boolean;
  reason: string;
  error: string | null;
}

// Local-time "YYYY-MM-DD HH:mm" (console purity forbids importing lib/datetime).
function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toCardRevisions(rows: InstanceRevision[]): ObjectCardRevision[] {
  // rows are version-desc; the fixity chain verifies each row's prev_hash
  // against the next-older row's row_hash (genesis verifies by presence).
  return rows.map((row, index) => {
    const older = rows.at(index + 1);
    return {
      version: row.version,
      at: formatStamp(row.validFrom),
      actor: row.actor ?? "",
      reason: row.reason ?? undefined,
      hashVerified:
        row.rowHash.length > 0 && (older ? row.prevHash === older.rowHash : true),
      action: row.actionTypeId ?? undefined,
    };
  });
}

export interface GovernedObjectCardProps {
  api: ConsoleApiClient;
  descriptor: ObjectCardDescriptor;
  /** Host seam for the semantic layer + endpoints that do not exist yet. */
  handlers?: ObjectCardHandlers;
  /** Extra request fields (typed params, a shared four-eyes ref) per action. */
  buildActionRequest?: (
    action: ObjectCardAction,
  ) => Partial<OntologyActionRequest> | undefined;
  /** Fired after a committed execute (new revision appended). */
  onInstanceChange?: (update: {
    lifecycleState: string;
    version: number;
  }) => void;
}

export function GovernedObjectCard({
  api,
  descriptor,
  handlers,
  buildActionRequest,
  onInstanceChange,
}: GovernedObjectCardProps) {
  const S = objectCardGovStrings();
  const gate = usePolicyGate();

  const [actionFlow, setActionFlow] = useState<ActionFlow | null>(null);
  const [override, setOverride] = useState<OverridePending | null>(null);
  const [overrideDecision, setOverrideDecision] = useState<
    "approved" | "rejected" | null
  >(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [lifecycleTarget, setLifecycleTarget] =
    useState<ObjectLifecycleState | null>(null);
  const [lifecyclePreflight, setLifecyclePreflight] =
    useState<LifecyclePreflight | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [history, setHistory] = useState<ObjectCardRevision[] | null>(null);
  const [lifecycleState, setLifecycleState] =
    useState<ObjectLifecycleState | null>(null);

  const typeId = descriptor.objectType.id;
  const currentState = lifecycleState ?? descriptor.lifecycleState;

  const actionBody = useCallback(
    (flow: Pick<ActionFlow, "action" | "fourEyesRef" | "checklistAck" | "reason">) => {
      const body: OntologyActionRequest = {
        object_type_id: typeId ?? "",
        instance_id: descriptor.id,
        reason: flow.reason.trim() || undefined,
        checklist_all_acknowledged: flow.checklistAck || undefined,
        four_eyes_request_ref: flow.fourEyesRef,
        ...buildActionRequest?.(flow.action),
      };
      return body;
    },
    [typeId, descriptor.id, buildActionRequest],
  );

  const runPreflight = useCallback(
    async (flow: ActionFlow) => {
      setActionFlow({ ...flow, checking: true, error: null });
      try {
        const preflight = await preflightOntologyAction(
          api,
          flow.action.key,
          actionBody(flow),
        );
        setActionFlow({ ...flow, checking: false, preflight, error: null });
      } catch (error) {
        setActionFlow({
          ...flow,
          checking: false,
          preflight: null,
          error: error instanceof Error ? error.message : S.preflight.failed,
        });
      }
    },
    [api, actionBody, S.preflight.failed],
  );

  function startAction(action: ObjectCardAction) {
    setToast(null);
    if (!typeId) {
      setActionFlow({
        action,
        fourEyesRef: crypto.randomUUID(),
        preflight: null,
        checking: false,
        executing: false,
        checklistAck: false,
        reason: "",
        error: S.missingTypeId,
      });
      return;
    }
    void runPreflight({
      action,
      fourEyesRef: crypto.randomUUID(),
      preflight: null,
      checking: false,
      executing: false,
      checklistAck: false,
      reason: "",
      error: null,
    });
  }

  async function execute(flow: ActionFlow) {
    // Fail-closed: never call execute unless preflight allowed it and a
    // required reason is present.
    if (!flow.preflight?.wouldExecute) return;
    if (flow.action.requiresReason && flow.reason.trim().length === 0) {
      setActionFlow({ ...flow, error: T.edit.reasonRequired });
      return;
    }
    setActionFlow({ ...flow, executing: true, error: null });
    try {
      const result = await executeOntologyAction(
        api,
        flow.action.key,
        actionBody(flow),
      );
      setToast(
        S.executedToast(flow.action.title, result.instance.version, descriptor.code),
      );
      const states: ObjectLifecycleState[] = [
        "draft",
        "active",
        "locked",
        "archived",
        "disposed",
      ];
      const nextState = states.find((s) => s === result.instance.lifecycleState);
      if (nextState) setLifecycleState(nextState);
      onInstanceChange?.({
        lifecycleState: result.instance.lifecycleState,
        version: result.instance.version,
      });
      setActionFlow(null);
      // A committed execute appended a revision — refresh the timeline.
      try {
        setHistory(toCardRevisions(await fetchInstanceHistory(api, descriptor.id)));
      } catch {
        // Keep the pre-execute timeline; the toast already reports the commit.
      }
    } catch (error) {
      setActionFlow({
        ...flow,
        executing: false,
        error: error instanceof Error ? error.message : S.preflight.failed,
      });
    }
  }

  // ── §20 override → four-eyes decide flow ─────────────────────────────

  async function onEdit(ctx: { mode: "direct" | "override"; reason?: string }) {
    if (ctx.mode === "direct") {
      handlers?.onEdit?.(ctx);
      return;
    }
    setOverrideError(null);
    setOverrideDecision(null);
    try {
      const pending = await openGovernanceOverride(api, {
        target_type: descriptor.objectType.key,
        target_id: descriptor.id,
        reason: ctx.reason ?? "",
        before_snapshot: Object.fromEntries(
          descriptor.properties.map((property) => [property.key, property.value]),
        ),
      });
      setOverride(pending);
    } catch (error) {
      setOverrideError(
        error instanceof Error ? error.message : S.override.failed,
      );
    }
  }

  async function decideOverride(decision: "approved" | "rejected") {
    if (!override) return;
    setOverrideError(null);
    try {
      const decided = await decideGovernanceApproval(api, {
        request_ref: override.id,
        kind: "override",
        requested_by: override.actor,
        decision,
      });
      setOverrideDecision(decided.decision);
      if (decided.decision === "approved") {
        handlers?.onEdit?.({ mode: "override", reason: override.reason });
      }
    } catch (error) {
      // Self-approval (approver == requester) lands here with the server's
      // message; the requester line above keeps the distinct-principal rule visible.
      setOverrideError(
        error instanceof Error ? error.message : S.override.failed,
      );
    }
  }

  // ── Lifecycle transition preflight ───────────────────────────────────

  async function startTransition(target: ObjectLifecycleState) {
    setLifecycleTarget(target);
    setLifecyclePreflight(null);
    setLifecycleError(null);
    if (!typeId) {
      setLifecycleError(S.missingTypeId);
      return;
    }
    try {
      setLifecyclePreflight(
        await preflightLifecycleTransition(api, {
          object_type_id: typeId,
          from_state: toWireState(currentState),
          to_state: toWireState(target),
          authority_allow: gate.can(OBJECT_CARD_ACTIONS.lifecycleTransition, {
            kind: "object",
            id: descriptor.id,
          }),
        }),
      );
    } catch (error) {
      setLifecycleError(
        error instanceof Error ? error.message : S.lifecycle.failed,
      );
    }
  }

  function commitTransition(target: ObjectLifecycleState) {
    // Only reachable when the preflight allowed the edge (fail-closed).
    // wire-pending: HANDOFF §lifecycle — POST /api/v1/ontology/instances/{id}/lifecycle
    // does not exist yet (ontology REST has no transition write); the
    // preflight-allowed transition is handed to the host seam until it lands.
    handlers?.onLifecycleTransition?.(target);
    setLifecycleTarget(null);
    setLifecyclePreflight(null);
  }

  const view: ObjectCardDescriptor = {
    ...descriptor,
    lifecycleState: currentState,
    history: history ?? descriptor.history,
  };

  const wiredHandlers: ObjectCardHandlers = {
    ...handlers,
    onAction: (action) => {
      startAction(action);
    },
    onEdit: (ctx) => {
      void onEdit(ctx);
    },
  };

  return (
    <div style={{ display: "grid", gap: "var(--sp-4)" }}>
      {toast ? (
        <StatusChip tone="ok" role="status">
          {toast}
        </StatusChip>
      ) : null}

      <ObjectCard descriptor={view} handlers={wiredHandlers} />

      {actionFlow ? (
        <ActionPreflightPanel
          flow={actionFlow}
          onChecklistAck={(checklistAck) => {
            void runPreflight({ ...actionFlow, checklistAck });
          }}
          onReason={(reason) => {
            setActionFlow({ ...actionFlow, reason });
          }}
          onExecute={() => {
            void execute(actionFlow);
          }}
          onClose={() => {
            setActionFlow(null);
          }}
        />
      ) : null}

      {override ? (
        <OverridePanel
          pending={override}
          decision={overrideDecision}
          error={overrideError}
          onDecide={(decision) => {
            void decideOverride(decision);
          }}
        />
      ) : (
        <ErrorChip message={overrideError} />
      )}

      <TransitionBar
        objectId={descriptor.id}
        current={currentState}
        target={lifecycleTarget}
        preflight={lifecyclePreflight}
        error={lifecycleError}
        onStart={(target) => {
          void startTransition(target);
        }}
        onCommit={commitTransition}
      />
    </div>
  );
}

function ActionPreflightPanel({
  flow,
  onChecklistAck,
  onReason,
  onExecute,
  onClose,
}: {
  flow: ActionFlow;
  onChecklistAck: (ack: boolean) => void;
  onReason: (reason: string) => void;
  onExecute: () => void;
  onClose: () => void;
}) {
  const S = objectCardGovStrings();
  const title = S.preflight.title(flow.action.title);
  const preflight = flow.preflight;
  const needsChecklist = preflight?.gates.gates.some(
    (g) => g.gate === "self_checklist" && g.status !== "not_required",
  );
  const showsFourEyes = preflight?.gates.gates.some(
    (g) => g.gate === "four_eyes" && g.status === "pending",
  );
  const reasonMissing =
    flow.action.requiresReason === true && flow.reason.trim().length === 0;
  return (
    <section aria-label={title} style={panelStyle}>
      <div style={rowStyle}>
        <h3 style={panelTitleStyle}>{title}</h3>
        {flow.checking ? (
          <StatusChip tone="info" role="status">
            {S.preflight.checking}
          </StatusChip>
        ) : null}
      </div>
      {preflight ? <GateLines gates={preflight.gates.gates} /> : null}
      {preflight && !preflight.criteriaOk && preflight.criteriaError ? (
        <StatusChip tone="danger" role="alert">
          {preflight.criteriaError}
        </StatusChip>
      ) : null}
      {showsFourEyes ? <span style={monoStyle}>{flow.fourEyesRef}</span> : null}
      {needsChecklist ? (
        <label style={{ ...rowStyle, color: "var(--steel)", fontSize: "var(--text-sm)" }}>
          <input
            type="checkbox"
            checked={flow.checklistAck}
            onChange={(event) => {
              onChecklistAck(event.target.checked);
            }}
          />
          {S.preflight.checklistAck}
        </label>
      ) : null}
      {flow.action.requiresReason ? (
        <label style={fieldStyle}>
          {T.edit.reasonLabel}
          <textarea
            aria-label={T.edit.reasonLabel}
            value={flow.reason}
            placeholder={T.edit.reasonPlaceholder}
            onChange={(event) => {
              onReason(event.target.value);
            }}
            style={textareaStyle}
          />
        </label>
      ) : null}
      <ErrorChip message={flow.error} />
      <div style={rowStyle}>
        {preflight?.wouldExecute ? (
          <button
            type="button"
            data-window-control="true"
            disabled={flow.executing || reasonMissing}
            onClick={onExecute}
            style={primaryButtonStyle}
          >
            {flow.executing ? S.preflight.executing : S.preflight.execute}
          </button>
        ) : null}
        <button
          type="button"
          data-window-control="true"
          onClick={onClose}
          style={buttonStyle}
        >
          {S.preflight.close}
        </button>
      </div>
    </section>
  );
}

function OverridePanel({
  pending,
  decision,
  error,
  onDecide,
}: {
  pending: OverridePending;
  decision: "approved" | "rejected" | null;
  error: string | null;
  onDecide: (decision: "approved" | "rejected") => void;
}) {
  const S = objectCardGovStrings();
  return (
    <section aria-label={S.override.pendingTitle} style={panelStyle}>
      <div style={rowStyle}>
        <StatusChip tone={decision ? (decision === "approved" ? "ok" : "danger") : "warn"} role="status">
          {decision
            ? decision === "approved"
              ? S.override.approvedChip
              : S.override.rejectedChip
            : S.override.pendingTitle}
        </StatusChip>
        <StatusChip tone="warn">{T.edit.fourEyes}</StatusChip>
        <span style={monoStyle}>{S.override.requester(pending.actor)}</span>
      </div>
      <p style={reasonTextStyle}>{pending.reason}</p>
      <ErrorChip message={error} />
      {decision === null ? (
        <PolicyGated
          action={OBJECT_CARD_ACTIONS.approvalDecide}
          resource={{ kind: "override", id: pending.id }}
        >
          <div style={rowStyle}>
            <button
              type="button"
              data-window-control="true"
              onClick={() => {
                onDecide("approved");
              }}
              style={primaryButtonStyle}
            >
              {S.override.approve}
            </button>
            <button
              type="button"
              data-window-control="true"
              onClick={() => {
                onDecide("rejected");
              }}
              style={buttonStyle}
            >
              {S.override.reject}
            </button>
          </div>
        </PolicyGated>
      ) : null}
    </section>
  );
}

function TransitionBar({
  objectId,
  current,
  target,
  preflight,
  error,
  onStart,
  onCommit,
}: {
  objectId: string;
  current: ObjectLifecycleState;
  target: ObjectLifecycleState | null;
  preflight: LifecyclePreflight | null;
  error: string | null;
  onStart: (target: ObjectLifecycleState) => void;
  onCommit: (target: ObjectLifecycleState) => void;
}) {
  const S = objectCardGovStrings();
  const nextStates = NEXT_STATES[current];
  if (nextStates.length === 0 && !target) return null;
  const allow = preflight !== null && preflight.configured && preflight.gates.allow;
  let panel: ReactNode = null;
  if (target) {
    panel = (
      <section aria-label={S.lifecycle.preflightTitle(T.lifecycle[target])} style={panelStyle}>
        <div style={rowStyle}>
          <h3 style={panelTitleStyle}>{S.lifecycle.preflightTitle(T.lifecycle[target])}</h3>
          {preflight && !preflight.configured ? (
            <StatusChip tone="danger" role="alert">
              {S.lifecycle.notConfigured}
            </StatusChip>
          ) : null}
        </div>
        {preflight ? (
          <>
            <GateLines gates={preflight.gates.gates} />
            {/* Blocker vs warning rollup: denied = blocker, pending = warning. */}
            <div style={rowStyle}>
              {preflight.gates.gates.some((g) => g.status === "denied") ||
              !preflight.configured ? (
                <StatusChip tone="danger" role="alert">
                  {S.lifecycle.blocker}
                </StatusChip>
              ) : null}
              {preflight.gates.gates.some((g) => g.status === "pending") ? (
                <StatusChip tone="warn" role="status">
                  {S.lifecycle.warning}
                </StatusChip>
              ) : null}
            </div>
          </>
        ) : null}
        <ErrorChip message={error} />
        {allow ? (
          <button
            type="button"
            data-window-control="true"
            onClick={() => {
              onCommit(target);
            }}
            style={primaryButtonStyle}
          >
            {T.transitionTo(T.lifecycle[target])}
          </button>
        ) : null}
      </section>
    );
  }
  return (
    <PolicyGated
      action={OBJECT_CARD_ACTIONS.lifecycleTransition}
      resource={{ kind: "object", id: objectId }}
    >
      <div style={{ display: "grid", gap: "var(--sp-3)" }}>
        <div style={rowStyle}>
          {nextStates.map((state) => (
            <button
              key={state}
              type="button"
              data-window-control="true"
              onClick={() => {
                onStart(state);
              }}
              style={buttonStyle}
            >
              {T.transitionTo(T.lifecycle[state])}
            </button>
          ))}
        </div>
        {panel}
      </div>
    </PolicyGated>
  );
}
