/* eslint-disable react-refresh/only-export-components -- evidenceWindowEntry is the §4.7-3 open-gesture factory, same pattern as objectCardWindowEntry */
// EvidenceCard — the EV- object detail (design (34) / EV-101~103): SHA-256
// fixity + TSA chips, WORM 원본/파생본 split, chain-of-custody timeline in the
// audit-stream shape, admissibility chip, and the legal-hold disposal gate.
// Opens as the right pin (§4.7-3) via evidenceWindowEntry; composes ObjectCard
// as the single object-detail substrate (§4-14).
import { useState, type CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import type { AuditRecord } from "../audit";
import { StatusChip } from "../components";
import { ObjectCard } from "../objectcard";
import { PolicyGated } from "../policy";
import { type WindowEntry } from "../window";
import {
  admissibilityLabel,
  admissibilityTone,
  custodyStageLabel,
  custodyStageOfAudit,
  derivativesOf,
  fixityTone,
  formatSize,
  holdActive,
  originalOf,
  shortDigest,
  toObjectCardDescriptor,
  tsaTone,
  wormTone,
} from "./evidenceModel";
import {
  EVIDENCE_ACTIONS,
  type EvidenceLegalHold,
  type EvidenceObjectDetail,
  type VerifyEvidence,
  type VerifyOutcome,
} from "./types";
import "../tokens.css";

const T = ko.console.evidence;
const TA = ko.console.audit;

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-5)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const headerStyle: CSSProperties = { display: "grid", gap: "var(--sp-2)" };

const titleRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--steel)",
  overflowWrap: "anywhere",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const sectionStyle: CSSProperties = { display: "grid", gap: "var(--sp-2)" };

const sectionHeadingStyle: CSSProperties = {
  margin: 0,
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-label)",
};

const copyRowStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  padding: "var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-md)",
  background: "var(--muted)",
};

const copyMetaStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
  fontSize: "var(--text-sm)",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const custodyRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
  minHeight: 32,
  fontSize: "var(--text-sm)",
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

const inputStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 0,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

const inlineFormStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(140px, 1fr) auto",
  gap: "var(--sp-2)",
  alignItems: "center",
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Local staged custody event in the audit-stream shape. */
function stagedCustodyEvent(action: string, targetId: string): AuditRecord {
  const at = nowIso();
  return {
    id: `staged-${action}-${at}`,
    actor: null,
    action,
    target_type: "evidence_object",
    target_id: targetId,
    branch_id: null,
    before_snap: null,
    after_snap: null,
    trace_id: "staged",
    span_id: "staged",
    occurred_at: at,
  };
}

function verifyChip(outcome: VerifyOutcome | "running" | null) {
  if (outcome === null) return null;
  if (outcome === "running") return <StatusChip role="status" tone="info">{T.actions.verifying}</StatusChip>;
  switch (outcome.state) {
    case "verified":
      return <StatusChip role="status" tone="ok">{T.actions.verifyOk}</StatusChip>;
    case "processing":
      return <StatusChip role="status" tone="info">{T.actions.verifying}</StatusChip>;
    case "failed":
      return <StatusChip role="alert" tone="danger">{T.actions.verifyFail}</StatusChip>;
    case "unavailable":
      return <StatusChip role="status" tone="neutral">{T.actions.verifyPending}</StatusChip>;
  }
}

function timestampLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : TA.datetime(date);
}

export interface EvidenceCardProps {
  detail: EvidenceObjectDetail;
  /** Real fixity poll (GET /api/v1/evidence/{evidenceId}/status) when wired. */
  verify?: VerifyEvidence;
}

export function EvidenceCard({ detail, verify }: EvidenceCardProps) {
  const [holds, setHolds] = useState<EvidenceLegalHold[]>(detail.holds);
  const [custody, setCustody] = useState<AuditRecord[]>(detail.custody);
  const [custodian, setCustodian] = useState(detail.custodian);
  const [disposed, setDisposed] = useState(detail.disposed);
  const [outcome, setOutcome] = useState<VerifyOutcome | "running" | null>(null);
  const [transferTo, setTransferTo] = useState("");
  const [caseRef, setCaseRef] = useState("");

  const original = originalOf(detail.copies);
  const derivatives = derivativesOf(detail.copies);
  const locked = holdActive(holds);

  async function runVerify(): Promise<void> {
    if (!verify) {
      // wire-pending: Phase C → POST /api/v1/evidence-objects/{id}/admissibility/recompute
      // (t_15b1a1ec §7.8) — until then only the evidence_media status poll is real.
      setOutcome({ state: "unavailable" });
      return;
    }
    setOutcome("running");
    try {
      setOutcome(await verify({ ...detail, holds, custody, custodian, disposed }));
    } catch {
      setOutcome({ state: "failed", reason: null });
    }
  }

  function submitTransfer(): void {
    const next = transferTo.trim();
    if (!next) return;
    // wire-pending: Phase C → POST /api/v1/evidence-objects/{id}/custody-events (t_15b1a1ec §7.5)
    setCustody((current) => [stagedCustodyEvent("evidence_custody.transition", detail.code), ...current]);
    setCustodian(next);
    setTransferTo("");
  }

  function applyHold(): void {
    const ref = caseRef.trim();
    if (!ref) return;
    // wire-pending: Phase C → POST /api/v1/evidence-objects/{id}/legal-holds (t_15b1a1ec §7.6)
    setHolds((current) => [
      { id: `staged-hold-${nowIso()}`, caseRef: ref, status: "ACTIVE", appliedAt: nowIso() },
      ...current,
    ]);
    setCustody((current) => [stagedCustodyEvent("evidence_legal_hold.apply", detail.code), ...current]);
    setCaseRef("");
  }

  function releaseHold(): void {
    // wire-pending: Phase C → POST /api/v1/evidence-objects/{id}/legal-holds/{holdId}/release (t_15b1a1ec §7.7)
    setHolds((current) =>
      current.map((hold) =>
        hold.status === "ACTIVE" ? { ...hold, status: "RELEASED", releasedAt: nowIso() } : hold,
      ),
    );
    setCustody((current) => [stagedCustodyEvent("evidence_legal_hold.release", detail.code), ...current]);
  }

  function requestDisposal(): void {
    if (locked || disposed) return;
    // wire-pending: Phase C → evidence_disposal.request via lifecycle route (t_15b1a1ec §11)
    setDisposed(true);
    setCustody((current) => [stagedCustodyEvent("evidence_disposal.request", detail.code), ...current]);
  }

  const activeHold = holds.find((hold) => hold.status === "ACTIVE");

  return (
    <article className="console" aria-label={T.detailAria(detail.code)} style={rootStyle}>
      <header style={headerStyle}>
        <div style={titleRowStyle}>
          <h2 style={titleStyle}>{detail.title}</h2>
          {/* Drag-reference lives on the keyboard-accessible EV- row button in
              EvidenceRecords; a non-focusable grab affordance here fails WCAG 2.1.1. */}
          <span style={monoStyle}>{detail.code}</span>
        </div>
        <div style={chipRowStyle}>
          <StatusChip
            tone={fixityTone(detail.fixity)}
            ariaLabel={T.fixity.aria(original ? original.digestSha256 : T.fixity.missing)}
          >
            {`SHA-256 ${original ? shortDigest(original.digestSha256) : T.fixity.missing}`}
          </StatusChip>
          {/* wire-pending: Phase C → TSA proof summary per copy (t_15b1a1ec §4.4/§7.3) */}
          <StatusChip tone={tsaTone(detail.tsa)}>{T.tsa[detail.tsa]}</StatusChip>
          <StatusChip
            tone={admissibilityTone(detail.admissibility)}
            ariaLabel={T.admissibilityAria(admissibilityLabel(detail.admissibility))}
          >
            {admissibilityLabel(detail.admissibility)}
          </StatusChip>
          {activeHold ? (
            <StatusChip tone="purple" ariaLabel={T.hold.activeAria(activeHold.caseRef)}>
              {T.hold.active}
            </StatusChip>
          ) : null}
          {disposed ? <StatusChip tone="danger">{T.custody.stages.DISPOSED}</StatusChip> : null}
        </div>
      </header>

      {/* WORM split — the original is immutable; derivatives are linked copies. */}
      <section aria-label={T.worm.originalSection} style={sectionStyle}>
        <h3 style={sectionHeadingStyle}>{T.worm.original}</h3>
        {original ? (
          <div style={copyRowStyle}>
            <div style={chipRowStyle}>
              <StatusChip tone="accent">{T.worm.originalImmutable}</StatusChip>
              <StatusChip tone={wormTone(original.wormStatus)}>
                {T.worm.status[original.wormStatus]}
              </StatusChip>
            </div>
            <span style={monoStyle}>{original.digestSha256}</span>
            <span style={copyMetaStyle}>
              <span>{original.contentType}</span>
              <span>{formatSize(original.sizeBytes)}</span>
            </span>
          </div>
        ) : (
          <StatusChip tone="danger">{T.worm.originalMissing}</StatusChip>
        )}
      </section>

      {derivatives.length > 0 ? (
        <section aria-label={T.worm.derivatives} style={sectionStyle}>
          <h3 style={sectionHeadingStyle}>{`${T.worm.derivatives} ${String(derivatives.length)}`}</h3>
          <ul style={listStyle}>
            {derivatives.map((copy) => (
              <li key={copy.id} style={copyRowStyle}>
                <div style={chipRowStyle}>
                  <StatusChip tone="neutral">
                    {copy.derivativeKind ? T.derivativeKinds[copy.derivativeKind] : T.worm.derivative}
                  </StatusChip>
                  <StatusChip tone={wormTone(copy.wormStatus)}>
                    {T.worm.status[copy.wormStatus]}
                  </StatusChip>
                </div>
                <span style={monoStyle}>{shortDigest(copy.digestSha256)}</span>
                <span style={copyMetaStyle}>
                  <span>{copy.contentType}</span>
                  <span>{formatSize(copy.sizeBytes)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Chain of custody — the audit stream shape (수집→봉인→열람…). */}
      <section aria-label={T.custody.title} style={sectionStyle}>
        <h3 style={sectionHeadingStyle}>{T.custody.title}</h3>
        <ol style={listStyle}>
          {custody.map((event) => {
            const stage = custodyStageOfAudit(event.action);
            return (
              <li key={event.id} style={custodyRowStyle}>
                <StatusChip tone={stage === "WORM_REPLICATED" || stage === "TSA_VERIFIED" ? "ok" : "neutral"}>
                  {stage ? custodyStageLabel(stage) : event.action}
                </StatusChip>
                <span>{event.actor ?? TA.values.systemActor}</span>
                <span style={monoStyle}>{timestampLabel(event.occurred_at)}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {/* Actions — verify is open to viewers of this gated route; custody/hold/
          disposal are PBAC-gated (deny-by-omission). Hold ⇒ dispose disabled,
          fail-closed. */}
      <section aria-label={T.actions.section} style={sectionStyle}>
        <div style={chipRowStyle}>
          <button
            type="button"
            style={buttonStyle}
            disabled={outcome === "running"}
            onClick={() => {
              void runVerify();
            }}
          >
            {T.actions.verify}
          </button>
          {verifyChip(outcome)}
        </div>

        <PolicyGated action={EVIDENCE_ACTIONS.custodyManage} resource={{ kind: "evidence_object", id: detail.id }}>
          <div style={inlineFormStyle}>
            <input
              aria-label={T.custody.transferTo}
              placeholder={T.custody.transferTo}
              style={inputStyle}
              value={transferTo}
              onChange={(event) => {
                setTransferTo(event.target.value);
              }}
            />
            <button type="button" style={buttonStyle} onClick={submitTransfer}>
              {T.actions.transfer}
            </button>
          </div>
        </PolicyGated>

        <PolicyGated action={EVIDENCE_ACTIONS.holdManage} resource={{ kind: "evidence_object", id: detail.id }}>
          {activeHold ? (
            <div style={chipRowStyle}>
              <button type="button" style={buttonStyle} onClick={releaseHold}>
                {T.hold.release}
              </button>
              <span style={monoStyle}>{activeHold.caseRef}</span>
            </div>
          ) : (
            <div style={inlineFormStyle}>
              <input
                aria-label={T.hold.caseRef}
                placeholder={T.hold.caseRef}
                style={inputStyle}
                value={caseRef}
                onChange={(event) => {
                  setCaseRef(event.target.value);
                }}
              />
              <button type="button" style={buttonStyle} onClick={applyHold}>
                {T.hold.apply}
              </button>
            </div>
          )}
        </PolicyGated>

        <PolicyGated action={EVIDENCE_ACTIONS.dispose} resource={{ kind: "evidence_object", id: detail.id }}>
          <button
            type="button"
            style={{ ...buttonStyle, opacity: locked || disposed ? 0.5 : 1 }}
            disabled={locked || disposed}
            aria-label={locked ? T.actions.disposeBlockedAria : T.actions.dispose}
            onClick={requestDisposal}
          >
            {T.actions.dispose}
          </button>
        </PolicyGated>
      </section>

      {/* §4-14 single object-detail substrate. */}
      <ObjectCard
        descriptor={toObjectCardDescriptor(
          { ...detail, custodian, disposed },
          holds,
          custody,
        )}
      />
    </article>
  );
}

/** §4.7-3 default open gesture — the EV detail as a right-pin window entry. */
export function evidenceWindowEntry(
  detail: EvidenceObjectDetail,
  verify?: VerifyEvidence,
): WindowEntry {
  return {
    id: detail.code,
    title: detail.title,
    code: detail.code,
    render: () => <EvidenceCard detail={detail} verify={verify} />,
  };
}
