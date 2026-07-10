import { useEffect, useState, type ReactNode } from "react";

import { authorizeBulk, subjectFingerprint, type AuthorizeSubject } from "../../api/authorizeBulk";
import { useAuth } from "../../context/auth";
import {
  DENY_ALL,
  decisionGate,
  PolicyGateContext,
  usePolicyGate,
  type PolicyDecider,
  type PolicyGate,
  type PolicyResource,
} from "./PolicyGateContext";
import { DEFAULT_POLICY_GATE_STRINGS, type PolicyGateStrings } from "./strings";

export function PolicyGateProvider({
  gate,
  decide,
  children,
}: {
  gate?: PolicyGate;
  decide?: PolicyDecider;
  children: ReactNode;
}) {
  const value = gate ?? (decide ? { can: decide } : DENY_ALL);
  return (
    <PolicyGateContext.Provider value={value}>
      {children}
    </PolicyGateContext.Provider>
  );
}

type GateStatus = "pending" | "ready" | "error";

/**
 * Real authorization boundary for a console surface. At mount (and whenever the
 * subject's roles change) it batch-resolves `actions` through
 * POST /api/v1/policy/authorize/bulk and provides the resolved gate to every
 * {@link PolicyGated} descendant.
 *
 * Semantics (never optimistic):
 *  - pending: DENY_ALL (gated affordances absent until Allow arrives)
 *  - error:   DENY_ALL + a fail-closed error banner with a retry action
 *  - no subject (org/user absent): DENY_ALL
 *
 * This replaces the per-surface local allow-list stubs. Deny is audited
 * server-side by the bulk handler.
 */
export function BulkPolicyGateProvider({
  actions,
  children,
  strings = DEFAULT_POLICY_GATE_STRINGS,
}: {
  actions: readonly string[];
  children: ReactNode;
  strings?: PolicyGateStrings;
}) {
  const { api, session } = useAuth();

  // Content keys (strings, not object/array identities) so the resolve effect
  // fires only on real changes: an inline `actions` literal or a fresh `roles`
  // array with the same contents does not re-fetch.
  const orgId = session?.org_id;
  const userId = session?.user_id;
  const rolesKey = (session?.roles ?? []).join("\n");
  const actionKey = [...actions].sort().join("\n");
  const subjectKey =
    orgId && userId
      ? subjectFingerprint({ org: orgId, userId, roles: rolesKey ? rolesKey.split("\n") : [] })
      : undefined;
  // Identifies exactly which (subject, action-set) an outcome answers.
  const requestKey = subjectKey ? `${subjectKey} ${actionKey}` : undefined;

  const [attempt, setAttempt] = useState(0);
  // Resolved outcome, stamped with the request + retry it answers. `gate: null`
  // means that request failed (fail closed). setState happens ONLY in the async
  // callbacks below, never synchronously in the effect body.
  const [outcome, setOutcome] = useState<{
    key: string;
    attempt: number;
    gate: PolicyGate | null;
  }>();

  useEffect(() => {
    if (!requestKey || !orgId || !userId) return undefined;
    let active = true;
    const subject: AuthorizeSubject = {
      org: orgId,
      userId,
      roles: rolesKey ? rolesKey.split("\n") : [],
    };
    const list = actionKey ? actionKey.split("\n") : [];
    authorizeBulk(api, subject, list)
      .then((decisions) => {
        if (active) setOutcome({ key: requestKey, attempt, gate: decisionGate(decisions) });
      })
      .catch(() => {
        if (active) setOutcome({ key: requestKey, attempt, gate: null });
      });
    return () => {
      active = false;
    };
  }, [api, requestKey, attempt, orgId, userId, rolesKey, actionKey]);

  // Deny-by-omission until THIS request's outcome lands (never a stale one).
  const fresh =
    outcome && outcome.key === requestKey && outcome.attempt === attempt ? outcome : undefined;
  const status: GateStatus = !requestKey
    ? "error"
    : !fresh
      ? "pending"
      : fresh.gate
        ? "ready"
        : "error";
  const gate = fresh?.gate ?? DENY_ALL;

  return (
    <PolicyGateContext.Provider value={gate}>
      {status === "error" ? (
        <div role="alert" className="policy-gate-error">
          <span>{strings.error}</span>
          <button
            type="button"
            aria-label={strings.retryAria}
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            {strings.retry}
          </button>
        </div>
      ) : null}
      {children}
    </PolicyGateContext.Provider>
  );
}

/**
 * Deny-by-omission render gate for console affordances. Unauthorized controls are
 * absent, not disabled or explained.
 */
export function PolicyGated({
  action,
  resource,
  children,
  fallback = null,
}: {
  action: string;
  resource?: PolicyResource;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const gate = usePolicyGate();
  return <>{gate.can(action, resource) ? children : fallback}</>;
}
