import { ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  FindingStatus,
  GovernanceFinding,
  UserSummary,
} from "../api/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Dialog } from "../components/ui/dialog";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { FeedbackBanner } from "../components/states/FeedbackBanner";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import {
  EVIDENCE_ACTIONS,
  EvidenceRecords,
  type VerifyEvidence,
} from "../console/evidence";
import { PolicyGateProvider, type PolicyGate } from "../console/policy";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { formatKoreanDateTime } from "../lib/datetime";
import { SUCCESS_DISMISS_MS, useAutoDismiss } from "../lib/useAutoDismiss";
import { safeLabel } from "../lib/utils";

type ReadState = "idle" | "loading" | "error";

/** Status filter options, including "all" (no status param). */
type StatusFilter = "ALL" | FindingStatus;

/** A 409 conflict from triage (the finding is no longer OPEN). */
class TriageConflictError extends Error {}

/** Resolve a detector_id to its human label; unknown ids fall back to the id. */
function detectorLabel(detectorId: string): string {
  switch (detectorId) {
    case "anomaly.self_approval":
      return ko.integrity.detector.selfApproval;
    case "anomaly.price_outlier":
      return ko.integrity.detector.priceOutlier;
    default:
      return detectorId;
  }
}

/** Resolve an entity_type to its human label; unknown types fall back as-is. */
function entityTypeLabel(entityType: string): string {
  switch (entityType) {
    case "financial_purchase_request":
      return ko.integrity.entityType.purchaseRequest;
    default:
      return entityType;
  }
}

/** Tailwind tone for a severity badge — neutral cool→warm, never alarmist red. */
function severityClass(severity: GovernanceFinding["severity"]): string {
  switch (severity) {
    case "CRITICAL":
    case "HIGH":
      return "border-amber-300 bg-amber-50 text-amber-900";
    case "MEDIUM":
      return "border-sky-300 bg-sky-50 text-sky-800";
    case "LOW":
    case "INFO":
      return "border-line bg-muted-panel text-steel";
  }
}

/** Surface tabs: 이상 징후 (findings, default) / 증거 (EV- records). */
type IntegrityTab = "findings" | "evidence";

export function IntegrityPage() {
  const { api, session } = useAuth();

  const [tab, setTab] = useState<IntegrityTab>("findings");
  const [findings, setFindings] = useState<GovernanceFinding[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [listState, setListState] = useState<ReadState>("loading");
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [triageTarget, setTriageTarget] = useState<
    GovernanceFinding | undefined
  >(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const clearFeedback = useCallback(() => {
    setFeedback(undefined);
  }, []);
  useAutoDismiss(feedback, clearFeedback, SUCCESS_DISMISS_MS);

  const loadFindings = useCallback(async () => {
    setListState("loading");
    const res = await api
      .GET("/api/v1/integrity/findings", {
        params: {
          query: filter === "ALL" ? {} : { status: filter },
        },
      })
      .catch(() => undefined);
    if (!res?.data) {
      setListState("error");
      return;
    }
    setFindings(res.data);
    setListState("idle");
  }, [api, filter]);

  // Resolve subject_user_id → display name so the table never shows a raw UUID.
  // The users list is loaded once (best-effort); a missing row falls back to the
  // shared unknown-label fallback via safeLabel rather than leaking the id.
  const loadUsers = useCallback(async () => {
    const res = await api.GET("/api/v1/users").catch(() => undefined);
    if (res?.data) setUsers(res.data.items);
  }, [api]);

  // Defer the first state write out of the synchronous effect pass (mirrors
  // OrgPage) so a fetch kickoff never triggers a cascading-render lint error.
  useEffect(() => {
    void Promise.resolve().then(loadFindings);
  }, [loadFindings]);

  useEffect(() => {
    void Promise.resolve().then(loadUsers);
  }, [loadUsers]);

  const userName = useCallback(
    (id: string | null | undefined): string =>
      safeLabel(users.find((u) => u.id === id)?.display_name),
    [users],
  );

  // Evidence PBAC gate (deny-by-omission). Role-derived stand-in: SUPER_ADMIN
  // acts as the 컴플라이언스 전담 persona (custody/hold/disposal controls);
  // EXECUTIVE is read-only — controls are absent, not disabled.
  // wire-pending: Phase C → Cedar decision feed per
  // .omc/research/be-ontology-engine-arch.md §5 (render=policy).
  const evidenceGate = useMemo<PolicyGate>(() => {
    const compliance = session?.roles?.includes("SUPER_ADMIN") ?? false;
    return {
      can: (action) =>
        action === EVIDENCE_ACTIONS.read ||
        (compliance &&
          (action === EVIDENCE_ACTIONS.custodyManage ||
            action === EVIDENCE_ACTIONS.holdManage ||
            action === EVIDENCE_ACTIONS.dispose)),
    };
  }, [session]);

  // 무결성 검증 — REAL wiring: the original copy that wraps a work-order
  // evidence_media row polls GET /api/v1/evidence/{evidenceId}/status. EV
  // objects without such a copy report "unavailable" until the EV attestation
  // REST lands (wire-pending: Phase C → POST
  // /api/v1/evidence-objects/{id}/admissibility/recompute, t_15b1a1ec §7.8).
  const verifyEvidence = useCallback<VerifyEvidence>(
    async (detail) => {
      const mediaId = detail.copies.find(
        (copy) => copy.kind === "ORIGINAL",
      )?.sourceEvidenceMediaId;
      if (!mediaId) return { state: "unavailable" };
      const res = await api
        .GET("/api/v1/evidence/{evidenceId}/status", {
          params: { path: { evidenceId: mediaId } },
        })
        .catch(() => undefined);
      if (!res?.data) return { state: "failed", reason: null };
      if (res.data.processing_status === "READY") {
        return { state: "verified", processedAt: res.data.processed_at ?? null };
      }
      if (res.data.processing_status === "PROCESSING") {
        return { state: "processing" };
      }
      return { state: "failed", reason: res.data.processing_error ?? null };
    },
    [api],
  );

  async function submitTriage(
    finding: GovernanceFinding,
    status: "REVIEWED" | "DISMISSED" | "ESCALATED",
    memo: string | undefined,
  ): Promise<void> {
    const response = await api.POST("/api/v1/integrity/findings/{id}/triage", {
      params: { path: { id: finding.id } },
      body: { status, memo: memo ?? null },
    });
    if (response.response.status === 409) {
      throw new TriageConflictError(ko.integrity.triage.conflict);
    }
    if (!response.data) {
      throw new Error("triage failed");
    }
    setFeedback(ko.integrity.triage.saved);
    setTriageTarget(undefined);
    await loadFindings();
  }

  return (
    <>
      <PageHeader
        title={ko.integrity.title}
        description={ko.integrity.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadFindings();
            }}
            isLoading={listState === "loading"}
          />
        }
      />

      <FeedbackBanner
        kind="success"
        message={feedback}
        onDismiss={clearFeedback}
        className="mb-4"
      />

      <div
        role="group"
        aria-label={ko.console.evidence.tabs.label}
        className="mb-4 flex flex-wrap items-center gap-2"
      >
        <Button
          type="button"
          variant={tab === "findings" ? undefined : "secondary"}
          aria-pressed={tab === "findings"}
          onClick={() => {
            setTab("findings");
          }}
        >
          {ko.console.evidence.tabs.findings}
        </Button>
        <Button
          type="button"
          variant={tab === "evidence" ? undefined : "secondary"}
          aria-pressed={tab === "evidence"}
          onClick={() => {
            setTab("evidence");
          }}
        >
          {ko.console.evidence.tabs.records}
        </Button>
      </div>

      {tab === "evidence" ? (
        <Card className="grid gap-4">
          <PolicyGateProvider gate={evidenceGate}>
            <EvidenceRecords verify={verifyEvidence} />
          </PolicyGateProvider>
        </Card>
      ) : (
      <Card className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <label
            className="text-sm font-medium text-steel"
            htmlFor="integrity-filter"
          >
            {ko.integrity.filter.label}
          </label>
          <Select
            id="integrity-filter"
            value={filter}
            className="max-w-44"
            onChange={(event) => {
              setFilter(event.currentTarget.value as StatusFilter);
            }}
          >
            <option value="ALL">{ko.integrity.filter.all}</option>
            <option value="OPEN">{ko.integrity.filter.open}</option>
            <option value="REVIEWED">{ko.integrity.filter.reviewed}</option>
            <option value="DISMISSED">{ko.integrity.filter.dismissed}</option>
            <option value="ESCALATED">{ko.integrity.filter.escalated}</option>
          </Select>
        </div>

        {listState === "loading" && findings.length === 0 ? (
          <SkeletonTable rows={5} cols={5} />
        ) : listState === "error" ? (
          <PageError
            message={ko.integrity.loadFailed}
            onRetry={() => {
              void loadFindings();
            }}
          />
        ) : findings.length === 0 ? (
          <PageEmpty message={ko.integrity.empty} />
        ) : (
          <ul className="grid gap-3">
            {findings.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                userName={userName}
                onTriage={() => {
                  setFeedback(undefined);
                  setTriageTarget(finding);
                }}
              />
            ))}
          </ul>
        )}
      </Card>
      )}

      {triageTarget ? (
        <TriageDialog
          finding={triageTarget}
          onCancel={() => {
            setTriageTarget(undefined);
          }}
          onSubmit={submitTriage}
        />
      ) : null}
    </>
  );
}

function FindingRow({
  finding,
  userName,
  onTriage,
}: {
  finding: GovernanceFinding;
  userName: (id: string | null | undefined) => string;
  onTriage: () => void;
}) {
  const isOpen = finding.status === "OPEN";
  return (
    <li className="grid gap-3 rounded-md border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">
              {detectorLabel(finding.detector_id)}
            </span>
            <Badge className={severityClass(finding.severity)}>
              {ko.integrity.severity[finding.severity]}
            </Badge>
            <Badge>{ko.integrity.status[finding.status]}</Badge>
          </div>
          <p className="mt-1 text-sm text-steel">
            {ko.integrity.table.subject}: {userName(finding.subject_user_id)}
            {" · "}
            {entityTypeLabel(finding.entity_type)}
          </p>
          <p className="text-sm text-steel">
            {ko.integrity.table.occurredAt}:{" "}
            {formatKoreanDateTime(finding.detected_at)}
          </p>
        </div>
        {isOpen ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onTriage}
          >
            {ko.integrity.triage.open}
          </Button>
        ) : null}
      </div>

      <FindingDetail finding={finding} userName={userName} />

      {finding.status !== "OPEN" ? (
        <ReviewSummary finding={finding} userName={userName} />
      ) : null}
    </li>
  );
}

/** Detector-specific, neutral detail. Falls back to the raw evidence bag. */
function FindingDetail({
  finding,
  userName,
}: {
  finding: GovernanceFinding;
  userName: (id: string | null | undefined) => string;
}) {
  const evidence = finding.evidence as Record<string, unknown>;

  if (finding.detector_id === "anomaly.self_approval") {
    const requestedBy = asString(evidence.requested_by);
    const submittedBy = asString(evidence.submitted_by);
    const approver = asString(evidence.approver);
    const exemption = asString(evidence.exemption_reason);
    return (
      <div className="grid gap-1 rounded-md bg-muted-panel p-3 text-sm">
        <p className="text-ink">{ko.integrity.selfApproval.summary}</p>
        <DetailLine
          label={ko.integrity.selfApproval.approver}
          value={userName(approver)}
        />
        <DetailLine
          label={ko.integrity.selfApproval.requestedBy}
          value={userName(requestedBy)}
        />
        {submittedBy ? (
          <DetailLine
            label={ko.integrity.selfApproval.submittedBy}
            value={userName(submittedBy)}
          />
        ) : null}
        <DetailLine
          label={ko.integrity.selfApproval.exemption}
          value={
            exemption === "super_admin_exempt"
              ? ko.integrity.selfApproval.exemptionSuperAdmin
              : exemption === "org_lead_exempt"
                ? ko.integrity.selfApproval.exemptionOrgLead
                : safeLabel(exemption)
          }
        />
        <p className="mt-1 text-steel">{ko.integrity.selfApproval.note}</p>
      </div>
    );
  }

  if (finding.detector_id === "anomaly.price_outlier") {
    return (
      <div className="grid gap-1 rounded-md bg-muted-panel p-3 text-sm">
        <p className="text-ink">{ko.integrity.priceOutlier.summary}</p>
        <DetailLine
          label={ko.integrity.priceOutlier.score}
          value={finding.score.toFixed(2)}
        />
      </div>
    );
  }

  // Unknown detector: show the raw evidence bag read-only rather than guessing.
  return (
    <details className="rounded-md bg-muted-panel p-3 text-sm">
      <summary className="cursor-pointer font-medium text-steel">
        {ko.integrity.evidence.label}
      </summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-steel">
        {JSON.stringify(finding.evidence, null, 2)}
      </pre>
    </details>
  );
}

function ReviewSummary({
  finding,
  userName,
}: {
  finding: GovernanceFinding;
  userName: (id: string | null | undefined) => string;
}) {
  return (
    <div className="grid gap-1 border-t border-line pt-2 text-sm text-steel">
      <DetailLine
        label={ko.integrity.reviewed.by}
        value={userName(finding.reviewed_by)}
      />
      {finding.reviewed_at ? (
        <DetailLine
          label={ko.integrity.reviewed.at}
          value={formatKoreanDateTime(finding.reviewed_at)}
        />
      ) : null}
      {finding.review_memo ? (
        <DetailLine
          label={ko.integrity.reviewed.memo}
          value={finding.review_memo}
        />
      ) : null}
    </div>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="text-steel">{label}:</span>{" "}
      <span className="text-ink">{value}</span>
    </p>
  );
}

function TriageDialog({
  finding,
  onCancel,
  onSubmit,
}: {
  finding: GovernanceFinding;
  onCancel: () => void;
  onSubmit: (
    finding: GovernanceFinding,
    status: "REVIEWED" | "DISMISSED" | "ESCALATED",
    memo: string | undefined,
  ) => Promise<void>;
}) {
  const [status, setStatus] = useState<
    "REVIEWED" | "DISMISSED" | "ESCALATED"
  >("REVIEWED");
  const [memo, setMemo] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const memoRequired = status === "DISMISSED" || status === "ESCALATED";

  async function handleSubmit() {
    setError(undefined);
    const trimmed = memo.trim();
    if (memoRequired && !trimmed) {
      setError(ko.integrity.triage.memoRequired);
      return;
    }
    setPending(true);
    try {
      await onSubmit(finding, status, trimmed || undefined);
    } catch (cause) {
      setError(
        cause instanceof TriageConflictError
          ? cause.message
          : ko.integrity.triage.submitFailed,
      );
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!pending) onCancel();
      }}
      label={ko.integrity.triage.title}
      closeOnScrimClick={!pending}
    >
      <div className="grid gap-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
          <ShieldAlert aria-hidden="true" size={18} />
          {ko.integrity.triage.title}
        </h2>
        <p className="text-sm text-steel">{ko.integrity.triage.description}</p>
      </div>

      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor="triage-status"
        >
          {ko.integrity.triage.statusLabel}
        </label>
        <Select
          id="triage-status"
          value={status}
          onChange={(event) => {
            setStatus(
              event.currentTarget.value as
                | "REVIEWED"
                | "DISMISSED"
                | "ESCALATED",
            );
          }}
        >
          <option value="REVIEWED">{ko.integrity.triage.reviewed}</option>
          <option value="DISMISSED">{ko.integrity.triage.dismissed}</option>
          <option value="ESCALATED">{ko.integrity.triage.escalated}</option>
        </Select>
      </div>

      <div className="grid gap-2">
        <label className="text-sm font-medium text-steel" htmlFor="triage-memo">
          {ko.integrity.triage.memoLabel}
        </label>
        <Textarea
          id="triage-memo"
          rows={3}
          value={memo}
          placeholder={ko.integrity.triage.memoPlaceholder}
          onChange={(event) => {
            setMemo(event.currentTarget.value);
          }}
        />
        <p className="text-xs text-steel">
          {memoRequired
            ? ko.integrity.triage.memoHintRequired
            : ko.integrity.triage.memoHintOptional}
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={onCancel}
        >
          {ko.integrity.triage.cancel}
        </Button>
        <Button
          type="button"
          disabled={pending}
          onClick={() => {
            void handleSubmit();
          }}
        >
          {pending
            ? ko.integrity.triage.submitting
            : ko.integrity.triage.submit}
        </Button>
      </div>
    </Dialog>
  );
}

/** Narrow an unknown evidence value to a string, or undefined when absent. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
