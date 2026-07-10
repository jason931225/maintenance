/* eslint-disable react-refresh/only-export-components -- evidenceWindowEntry is the §4.7-3 open-gesture factory, same pattern as objectCardWindowEntry */
// EvidenceCard — the EV- object detail (design (34) / EV-101~103): SHA-256
// fixity + TSA chips, WORM 원본/파생본 split, chain-of-custody timeline in the
// audit-stream shape, admissibility chip, and the legal-hold disposal gate.
// Opens as the right pin (§4.7-3) via evidenceWindowEntry; composes ObjectCard
// as the single object-detail substrate (§4-14).
//
// Real: hold apply / hold release (four-eyes via governance approvals-create +
// decide, fail-closed pending state) and fixity verify (per-copy verdict
// chips). Custody/holds render straight from `detail` — the caller (see
// EvidenceRecords) refetches the full object after every mutation, so the
// timeline is never client-synthesized (§4-25-⑥ — fabrication is a caught
// defect class here).
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
  copyVerdictLabel,
  copyVerdictTone,
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
  type CopyFixityStatus,
  type CopyVerdictMap,
  type EvidenceCopy,
  type EvidenceObjectDetail,
  type ReleaseFlowState,
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

const stackedFormStyle: CSSProperties = { display: "grid", gap: "var(--sp-2)" };

const sealedPaneStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  border: "1px dashed var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--muted)",
};

const entryTreeStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  margin: 0,
  padding: 0,
  listStyle: "none",
  fontSize: "var(--text-xs)",
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Local staged custody event in the audit-stream shape — only used for the
 * still-unwired transfer/dispose affordances (no REST endpoint exists yet). */
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

function isZip(copy: EvidenceCopy): boolean {
  return copy.contentType === "application/zip" || copy.contentType === "application/x-zip-compressed";
}

function timestampLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : TA.datetime(date);
}

/**
 * §4.7-3/§4-18 single action point for opening any evidence copy view. The
 * original is WORM-sealed and never streamed — this call always denies it and
 * surfaces the fail-closed access-denied state (no derived-preview/entry-index
 * REST exists yet, so a derivative/zip-entry open is a wire-pending stub, not
 * fabricated content).
 */
type PreviewRequest =
  | { kind: "original" }
  | { kind: "derivative"; copyId: string }
  | { kind: "zip-entry"; copyId: string; entryPath: string };

function evPreview(request: PreviewRequest): { denied: boolean; message: string } {
  if (request.kind === "original") {
    // wire-pending: Phase C → an audited forbid REST call belongs here once the
    // original-copy stream endpoint exists; until then there is no network
    // surface to deny, so the UI itself is the fail-closed boundary.
    return { denied: true, message: T.worm.accessDenied };
  }
  // wire-pending: Phase C → GET .../copies/{id}/derived-preview and the ZIP
  // entry-index endpoint (t_15b1a1ec follow-up). No real preview to render yet.
  return { denied: false, message: T.worm.previewPending };
}

export interface HoldApplyBody {
  caseRef: string;
  basis: string;
  reason: string;
}

export interface HoldReleaseBody {
  holdId: string;
  reason: string;
  fourEyesRequestRef: string;
}

export interface EvidenceCardProps {
  detail: EvidenceObjectDetail;
  /** Real fixity poll (POST /api/v1/evidence/objects/{id}/verify) when wired. */
  verify?: VerifyEvidence;
  /** The signed-in user — blocks a self-decide in the UI (server also enforces it). */
  currentUserId?: string;
  /** POST /api/v1/evidence/objects/{id}/hold {op:"apply"}. */
  applyHold: (body: HoldApplyBody) => Promise<void>;
  /** POST /api/v1/governance/approvals — opens the release's four-eyes request. */
  requestHoldRelease: (holdId: string) => Promise<{ requestRef: string; requestedBy: string }>;
  /** POST /api/v1/governance/approvals/decide — a distinct approver decides it. */
  decideHoldRelease: (
    requestRef: string,
    requestedBy: string,
    decision: "approved" | "rejected",
  ) => Promise<void>;
  /** POST /api/v1/evidence/objects/{id}/hold {op:"release"}. */
  releaseHold: (body: HoldReleaseBody) => Promise<void>;
}

export function EvidenceCard({
  detail,
  verify,
  currentUserId,
  applyHold,
  requestHoldRelease,
  decideHoldRelease,
  releaseHold,
}: EvidenceCardProps) {
  const [custodian, setCustodian] = useState(detail.custodian);
  const [disposed, setDisposed] = useState(detail.disposed);
  const [stagedCustody, setStagedCustody] = useState<AuditRecord[]>([]);
  const [outcome, setOutcome] = useState<VerifyOutcome | "running" | null>(null);
  const [copyVerdicts, setCopyVerdicts] = useState<CopyVerdictMap>(new Map());
  const [transferTo, setTransferTo] = useState("");
  const [caseRef, setCaseRef] = useState("");
  const [basis, setBasis] = useState("");
  const [applyReason, setApplyReason] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [releaseFlow, setReleaseFlow] = useState<ReleaseFlowState>({ stage: "idle" });
  const [releaseReason, setReleaseReason] = useState("");
  const [preview, setPreview] = useState<{ denied: boolean; message: string } | null>(null);

  const original = originalOf(detail.copies);
  const derivatives = derivativesOf(detail.copies);
  const locked = holdActive(detail.holds);
  const custody = [...stagedCustody, ...detail.custody];

  async function runVerify(): Promise<void> {
    if (!verify) {
      setOutcome({ state: "unavailable" });
      return;
    }
    setOutcome("running");
    try {
      const result = await verify(detail);
      setOutcome(result);
      if (result.state === "verified" || result.state === "failed") {
        setCopyVerdicts(result.copyVerdicts);
      }
    } catch {
      setOutcome({ state: "failed", reason: null, copyVerdicts: new Map() });
    }
  }

  function submitTransfer(): void {
    const next = transferTo.trim();
    if (!next) return;
    // wire-pending: Phase C → POST /api/v1/evidence-objects/{id}/custody-events
    // (no custody-transfer REST exists yet).
    setStagedCustody((current) => [stagedCustodyEvent("evidence_custody.transition", detail.code), ...current]);
    setCustodian(next);
    setTransferTo("");
  }

  async function submitApplyHold(): Promise<void> {
    const ref = caseRef.trim();
    const basisTrimmed = basis.trim();
    const reasonTrimmed = applyReason.trim();
    if (!ref || !basisTrimmed || !reasonTrimmed) {
      setApplyError(T.hold.requiredFields);
      return;
    }
    setApplyError(null);
    setApplying(true);
    try {
      await applyHold({ caseRef: ref, basis: basisTrimmed, reason: reasonTrimmed });
      setCaseRef("");
      setBasis("");
      setApplyReason("");
    } catch {
      setApplyError(T.hold.applyFailed);
    } finally {
      setApplying(false);
    }
  }

  async function startReleaseRequest(holdId: string): Promise<void> {
    setReleaseFlow({ stage: "requesting" });
    try {
      const { requestRef, requestedBy } = await requestHoldRelease(holdId);
      setReleaseFlow({ stage: "pending", holdId, requestRef, requestedBy });
    } catch {
      setReleaseFlow({ stage: "error", message: T.hold.releaseFailed });
    }
  }

  async function decideRelease(decision: "approved" | "rejected"): Promise<void> {
    if (releaseFlow.stage !== "pending") return;
    const { holdId, requestRef, requestedBy } = releaseFlow;
    setReleaseFlow({ stage: "deciding", holdId, requestRef, requestedBy });
    try {
      await decideHoldRelease(requestRef, requestedBy, decision);
      if (decision === "rejected") {
        setReleaseFlow({ stage: "idle" });
        return;
      }
      setReleaseFlow({ stage: "releasing", holdId, requestRef });
    } catch {
      setReleaseFlow({ stage: "error", message: T.hold.releaseFailed });
    }
  }

  async function finalizeRelease(): Promise<void> {
    if (releaseFlow.stage !== "releasing") return;
    const { holdId, requestRef } = releaseFlow;
    const reason = releaseReason.trim() || T.hold.defaultReleaseReason;
    try {
      await releaseHold({ holdId, reason, fourEyesRequestRef: requestRef });
      setReleaseFlow({ stage: "idle" });
      setReleaseReason("");
    } catch {
      setReleaseFlow({ stage: "error", message: T.hold.releaseFailed });
    }
  }

  function requestDisposal(): void {
    if (locked || disposed) return;
    // wire-pending: Phase C → evidence_disposal.request via lifecycle route
    // (no disposal REST exists yet).
    setDisposed(true);
    setStagedCustody((current) => [stagedCustodyEvent("evidence_disposal.request", detail.code), ...current]);
  }

  const activeHold = detail.holds.find((hold) => hold.status === "ACTIVE");
  const selfDecide = releaseFlow.stage === "pending" && currentUserId != null && releaseFlow.requestedBy === currentUserId;

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

      {/* WORM split — the original is immutable and WORM-sealed; it is never
          streamed. Derivatives + a ZIP entry tree open through the single
          evPreview() action point (§4-18). */}
      <section aria-label={T.worm.originalSection} style={sectionStyle}>
        <h3 style={sectionHeadingStyle}>{T.worm.original}</h3>
        {original ? (
          <div style={copyRowStyle}>
            <div style={chipRowStyle}>
              <StatusChip tone="accent" ariaLabel={T.worm.sealedAria}>
                {T.worm.sealed}
              </StatusChip>
              <StatusChip tone={wormTone(original.wormStatus)}>
                {T.worm.status[original.wormStatus]}
              </StatusChip>
              <CopyVerdictChip status={copyVerdicts.get(original.id)} />
            </div>
            <span style={monoStyle}>{original.digestSha256}</span>
            <span style={copyMetaStyle}>
              <span>{original.contentType}</span>
              <span>{formatSize(original.sizeBytes)}</span>
            </span>
            <div style={chipRowStyle}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  setPreview(evPreview({ kind: "original" }));
                }}
              >
                {T.worm.viewOriginal}
              </button>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  setPreview(evPreview({ kind: "derivative", copyId: original.id }));
                }}
              >
                {T.worm.viewDerived}
              </button>
            </div>
            {preview ? (
              <div role={preview.denied ? "alert" : "status"} style={sealedPaneStyle}>
                {preview.message}
              </div>
            ) : null}
            {isZip(original) ? <ZipEntryTree copy={original} /> : null}
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
                  <CopyVerdictChip status={copyVerdicts.get(copy.id)} />
                </div>
                <span style={monoStyle}>{shortDigest(copy.digestSha256)}</span>
                <span style={copyMetaStyle}>
                  <span>{copy.contentType}</span>
                  <span>{formatSize(copy.sizeBytes)}</span>
                </span>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() => {
                    setPreview(evPreview({ kind: "derivative", copyId: copy.id }));
                  }}
                >
                  {T.worm.viewDerived}
                </button>
                {isZip(copy) ? <ZipEntryTree copy={copy} /> : null}
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
            <div style={stackedFormStyle}>
              <div style={chipRowStyle}>
                <span style={monoStyle}>{activeHold.caseRef}</span>
              </div>
              {releaseFlow.stage === "idle" || releaseFlow.stage === "requesting" ? (
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={releaseFlow.stage === "requesting"}
                  onClick={() => {
                    void startReleaseRequest(activeHold.id);
                  }}
                >
                  {T.hold.requestRelease}
                </button>
              ) : null}
              {releaseFlow.stage === "pending" || releaseFlow.stage === "deciding" ? (
                <div style={stackedFormStyle}>
                  <StatusChip tone="warn" role="status">{T.hold.releasePending}</StatusChip>
                  {selfDecide ? (
                    <StatusChip tone="danger">{T.hold.selfDecideBlocked}</StatusChip>
                  ) : (
                    <div style={chipRowStyle}>
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={releaseFlow.stage === "deciding"}
                        onClick={() => {
                          void decideRelease("approved");
                        }}
                      >
                        {T.hold.decideApprove}
                      </button>
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={releaseFlow.stage === "deciding"}
                        onClick={() => {
                          void decideRelease("rejected");
                        }}
                      >
                        {T.hold.decideReject}
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
              {releaseFlow.stage === "releasing" ? (
                <div style={inlineFormStyle}>
                  <input
                    aria-label={T.hold.reasonLabel}
                    placeholder={T.hold.reasonLabel}
                    style={inputStyle}
                    value={releaseReason}
                    onChange={(event) => {
                      setReleaseReason(event.target.value);
                    }}
                  />
                  <button
                    type="button"
                    style={buttonStyle}
                    onClick={() => {
                      void finalizeRelease();
                    }}
                  >
                    {T.hold.release}
                  </button>
                </div>
              ) : null}
              {releaseFlow.stage === "error" ? (
                <StatusChip tone="danger" role="alert">{releaseFlow.message}</StatusChip>
              ) : null}
            </div>
          ) : (
            <div style={stackedFormStyle}>
              <input
                aria-label={T.hold.caseRef}
                placeholder={T.hold.caseRef}
                style={inputStyle}
                value={caseRef}
                onChange={(event) => {
                  setCaseRef(event.target.value);
                }}
              />
              <input
                aria-label={T.hold.basisLabel}
                placeholder={T.hold.basisLabel}
                style={inputStyle}
                value={basis}
                onChange={(event) => {
                  setBasis(event.target.value);
                }}
              />
              <input
                aria-label={T.hold.reasonLabel}
                placeholder={T.hold.reasonLabel}
                style={inputStyle}
                value={applyReason}
                onChange={(event) => {
                  setApplyReason(event.target.value);
                }}
              />
              <button
                type="button"
                style={buttonStyle}
                disabled={applying}
                onClick={() => {
                  void submitApplyHold();
                }}
              >
                {T.hold.apply}
              </button>
              {applyError ? (
                <StatusChip tone="danger" role="alert">{applyError}</StatusChip>
              ) : null}
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
          detail.holds,
          custody,
        )}
      />
    </article>
  );
}

/** Per-copy fixity verdict chip, absent until a verify pass reports one. */
function CopyVerdictChip({ status }: { status: CopyFixityStatus | undefined }) {
  if (!status) return null;
  return <StatusChip tone={copyVerdictTone(status)}>{copyVerdictLabel(status)}</StatusChip>;
}

/** Read-only ZIP entry index (path/size/hash) — wire-pending until the entry-
 * index REST exists; a real index never fabricates rows. */
function ZipEntryTree({ copy }: { copy: EvidenceCopy }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={sectionStyle}>
      <button
        type="button"
        style={buttonStyle}
        aria-expanded={open}
        data-copy-id={copy.id}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {T.worm.zip.title}
      </button>
      {open ? (
        <ul style={entryTreeStyle} aria-label={T.worm.zip.title}>
          <li style={custodyRowStyle}>{T.worm.zip.pending}</li>
        </ul>
      ) : null}
    </div>
  );
}

/** §4.7-3 default open gesture — the EV detail as a right-pin window entry. */
export function evidenceWindowEntry(
  detail: EvidenceObjectDetail,
  props: Omit<EvidenceCardProps, "detail">,
): WindowEntry {
  return {
    id: detail.code,
    title: detail.title,
    code: detail.code,
    render: () => <EvidenceCard detail={detail} {...props} />,
  };
}
