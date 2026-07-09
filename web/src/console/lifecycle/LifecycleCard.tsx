// Carbon-copy lifecycle card — live container (charter §3 P0.5).
//
// Binds LifecycleCardView to the REAL BE-LC REST surface (useLifecycle) and
// wraps it in the console policy gate. Transitions and holds are org-wide
// LifecycleManage authority server-side; the local gate mirrors that from the
// JWT role hint until the shared /me/authz gate (cc-policy lane) lands.

import { useMemo, useRef, useState } from "react";

import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { chainFor } from "./chain";
import { LifecycleCardView } from "./LifecycleCardView";
import { PolicyProvider, type PolicyQueryDecider } from "../policy";
import { useLifecycle } from "./useLifecycle";

const t = ko.console.lifecycle;

// Roles that hold org-wide LifecycleManage (per the openapi authz description).
const LIFECYCLE_ROLES = new Set(["ADMIN", "EXECUTIVE", "SUPER_ADMIN"]);

export interface LifecycleCardProps {
  objectType: string;
  objectId: string;
  title?: string;
  mode?: "live" | "asOf";
  asOfDate?: string;
}

export function LifecycleCard({ objectType, objectId, title, mode = "live", asOfDate }: LifecycleCardProps) {
  const { session } = useAuth();
  const { record, status, transition, setHold } = useLifecycle(objectType, objectId);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // ponytail: coarse JWT-hint gate. Real authority is org-wide LifecycleManage
  // resolved by the shared /me/authz gate the sibling cc-policy lane builds;
  // converge onto it (this whole decider drops out) when that merges.
  const decide = useMemo<PolicyQueryDecider>(() => {
    const manages = (session?.roles ?? []).some((r) => LIFECYCLE_ROLES.has(r));
    return ({ action }) => (action.startsWith("lifecycle.") ? manages : true);
  }, [session]);

  const chain = chainFor(objectType);

  async function guardedTransition(toState: string, reason: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await transition(toState, reason);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function guardedSetHold(legalHold: boolean, retentionUntil?: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await setHold(legalHold, retentionUntil);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (!chain) return <Notice text={t.absent} />;
  if (status === "loading") return <Notice text={t.loading} />;
  if (status === "absent") return <Notice text={t.absent} />;
  if (status === "error" || !record) return <Notice text={t.error} />;

  return (
    <PolicyProvider decide={decide}>
      <LifecycleCardView
        chain={chain}
        record={record}
        title={title}
        mode={mode}
        asOfDate={asOfDate}
        busy={busy}
        onTransition={mode === "asOf" ? undefined : (to, reason) => void guardedTransition(to, reason)}
        onSetHold={mode === "asOf" ? undefined : (hold, until) => void guardedSetHold(hold, until)}
      />
    </PolicyProvider>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <p
      className="console"
      data-lifecycle-notice
      style={{
        margin: 0,
        padding: "var(--sp-5)",
        color: "var(--steel)",
        fontSize: "var(--text-sm)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {text}
    </p>
  );
}
