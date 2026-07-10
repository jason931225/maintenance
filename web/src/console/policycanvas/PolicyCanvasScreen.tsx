// No-code Cedar authoring canvas, wired to the real REST surface (§5a drafts +
// catalog, §5c simulate — api/policyCedar.ts). One P→R→A→E block sequence per
// policy on the shared BlockCanvas, a typed config strip, the generated NL rule
// line, and a POST /policy/simulate decision panel (deny-by-omission is the
// server's default; no local evaluator). pendingRev staging (§3.9.0) is
// sourced from the API: a draft keyed to a catalog entry's stable_key is that
// policy's staged revision, and review_pending (four-eyes) freezes it.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type { ConsoleApiClient } from "../../api/client";
import {
  createPolicyDraft,
  listPolicyCatalog,
  listPolicyDrafts,
  reviewPolicyDraft,
  simulatePolicy,
  submitPolicyDraft,
  updatePolicyDraft,
  validatePolicyDraft,
  type PolicyCatalogEntry,
  type PolicyDraft,
  type PolicySimulationOutcome,
} from "../../api/policyCedar";
import {
  BlockCanvas,
  DEFAULT_CANVAS_STRINGS,
  PredicateEditor,
  type CanvasStrings,
  type PredicateGroup,
} from "../canvas";
import { StatusChip } from "../components";
import { PolicyGated } from "../policy";
import "../tokens.css";
import {
  actionLabel,
  blocksToCanvasDoc,
  conditionFieldRegistry,
  conditionsToGroup,
  decisionReason,
  groupToConditions,
  ruleLine,
} from "./model";
import {
  DEFAULT_POLICYCANVAS_STRINGS,
  DEFAULT_POLICYCANVAS_WIRE_STRINGS,
  type PolicyCanvasStrings,
  type PolicyCanvasWireStrings,
} from "./strings";
import {
  POLICY_ACTIONS,
  POLICY_BLOCK_IDS,
  POLICY_CANVAS_ACTIONS,
  type PolicyAction,
  type PolicyWorkingDoc,
} from "./types";

export interface PolicyCanvasScreenProps {
  api: ConsoleApiClient;
  /** Tenant org id for simulate subject/resource scoping (JWT `org` claim). */
  orgId: string;
  strings?: PolicyCanvasStrings;
  canvasStrings?: CanvasStrings;
}

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-5)",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  borderRadius: "var(--radius-card)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-h1)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const bodyGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 280px) minmax(0, 1fr) minmax(280px, 340px)",
  gap: "var(--sp-5)",
  alignItems: "start",
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
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
  background: "var(--ink)",
  borderColor: "var(--ink)",
  color: "var(--surface)",
};

const listButtonStyle: CSSProperties = {
  ...buttonStyle,
  width: "100%",
  display: "grid",
  gap: "var(--sp-2)",
  justifyItems: "start",
  padding: "var(--sp-3)",
  textAlign: "left",
};

const selectedListButtonStyle: CSSProperties = {
  ...listButtonStyle,
  borderColor: "var(--ink)",
  boxShadow: "var(--shadow)",
};

const fieldsetStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  margin: 0,
  padding: "var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface)",
};

const focusedFieldsetStyle: CSSProperties = {
  ...fieldsetStyle,
  borderColor: "var(--ink)",
};

const legendStyle: CSSProperties = {
  padding: "0 var(--sp-1)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  color: "var(--steel)",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  color: "var(--steel)",
};

const selectStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-sm)",
};

const toggleRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

const ruleLineStyle: CSSProperties = {
  margin: 0,
  padding: "var(--sp-3) var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--muted)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  color: "var(--ink)",
};

const bannerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-3)",
  padding: "var(--sp-3) var(--sp-4)",
  border: "1px solid var(--warn-bd)",
  borderRadius: "var(--radius-md)",
  background: "var(--warn-bg)",
  color: "var(--warn-tx)",
};

const auditListStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  margin: 0,
  padding: "var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-md)",
  background: "var(--muted)",
  fontSize: "var(--text-xs)",
  color: "var(--steel)",
};

const auditRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
};

const auditValueStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontWeight: "var(--fw-strong)",
  textAlign: "right",
};

const errorListStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  margin: 0,
  padding: "var(--sp-3)",
  border: "1px solid var(--danger-bd, var(--border))",
  borderRadius: "var(--radius-md)",
  background: "var(--muted)",
  fontSize: "var(--text-xs)",
  color: "var(--ink)",
  listStyle: "none",
};

function toggleChipStyle(active: boolean): CSSProperties {
  return {
    ...buttonStyle,
    background: active ? "var(--ink)" : "var(--surface)",
    borderColor: active ? "var(--ink)" : "var(--border)",
    color: active ? "var(--surface)" : "var(--ink)",
  };
}

const NEW_POLICY_ID = "policy-new";

function newDraftKey(): string {
  // cedar_policy_drafts.draft_key CHECK: dotted lowercase [a-z0-9_] segments.
  return `draft.${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function newWorkingDoc(s: PolicyCanvasStrings): PolicyWorkingDoc {
  return {
    draftId: null,
    catalogId: null,
    draftKey: newDraftKey(),
    title: s.newPolicyName,
    blocks: { effect: "permit", action: "view", resource_type: "", conditions: [] },
  };
}

function workingFromDraft(
  draft: PolicyDraft,
  catalogId: string | null,
): PolicyWorkingDoc {
  return {
    draftId: draft.id,
    catalogId,
    draftKey: draft.draft_key,
    title: draft.title,
    blocks: draft.blocks,
  };
}

export function PolicyCanvasScreen({
  api,
  orgId,
  strings = DEFAULT_POLICYCANVAS_STRINGS,
  canvasStrings = DEFAULT_CANVAS_STRINGS,
}: PolicyCanvasScreenProps) {
  const s = strings;
  const w: PolicyCanvasWireStrings = useMemo(
    () => ({
      ...DEFAULT_POLICYCANVAS_WIRE_STRINGS,
      ...(s.wire ?? {}),
      reviewStatus: {
        ...DEFAULT_POLICYCANVAS_WIRE_STRINGS.reviewStatus,
        ...(s.wire?.reviewStatus ?? {}),
      },
      catalogStatus: {
        ...DEFAULT_POLICYCANVAS_WIRE_STRINGS.catalogStatus,
        ...(s.wire?.catalogStatus ?? {}),
      },
    }),
    [s],
  );
  const registry = useMemo(() => conditionFieldRegistry(s), [s]);

  const [loadState, setLoadState] = useState<"loading" | "idle" | "error">(
    "loading",
  );
  const [catalog, setCatalog] = useState<PolicyCatalogEntry[]>([]);
  const [drafts, setDrafts] = useState<PolicyDraft[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [working, setWorking] = useState<PolicyWorkingDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [focusedBlock, setFocusedBlock] = useState<string>(
    POLICY_BLOCK_IDS.principal,
  );

  const draftsByKey = useMemo(
    () => new Map(drafts.map((draft) => [draft.draft_key, draft])),
    [drafts],
  );
  const catalogKeys = useMemo(
    () => new Set(catalog.map((entry) => entry.stable_key)),
    [catalog],
  );
  const standaloneDrafts = useMemo(
    () => drafts.filter((draft) => !catalogKeys.has(draft.draft_key)),
    [drafts, catalogKeys],
  );

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const [catalogEntries, draftRecords] = await Promise.all([
        listPolicyCatalog(api),
        listPolicyDrafts(api),
      ]);
      setCatalog(catalogEntries);
      setDrafts(draftRecords);
      setLoadState("idle");
      setSelectedId((current) => {
        if (
          current &&
          (catalogEntries.some((entry) => entry.id === current) ||
            draftRecords.some((draft) => draft.id === current))
        ) {
          return current;
        }
        const draft = draftRecords.length > 0 ? draftRecords[0] : undefined;
        const first =
          draft?.id ??
          (catalogEntries.length > 0 ? catalogEntries[0].id : "");
        if (draft) {
          const linked = catalogEntries.find(
            (entry) => entry.stable_key === draft.draft_key,
          );
          setWorking(workingFromDraft(draft, linked?.id ?? null));
        } else {
          setWorking(null);
        }
        setDirty(false);
        return first;
      });
    } catch {
      setLoadState("error");
    }
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const workingDraft = working?.draftId
    ? (drafts.find((draft) => draft.id === working.draftId) ?? null)
    : null;
  const workingCatalog = working?.catalogId
    ? (catalog.find((entry) => entry.id === working.catalogId) ?? null)
    : null;
  const frozen =
    workingDraft?.review_status === "review_pending" ||
    workingDraft?.review_status === "approved_for_promotion";
  const selectedCatalogEntry = catalog.find((entry) => entry.id === selectedId);
  // A catalog policy without a staged revision draft is read-only (its blocks
  // are not exposed by the API); the canvas edits drafts only.
  const readOnlyCatalogView =
    selectedCatalogEntry && working?.catalogId !== selectedCatalogEntry.id
      ? selectedCatalogEntry
      : null;

  const canvasDoc = useMemo(
    () =>
      working && !readOnlyCatalogView
        ? blocksToCanvasDoc(working.blocks, s)
        : null,
    [working, readOnlyCatalogView, s],
  );

  function upsertDraft(next: PolicyDraft) {
    setDrafts((current) => {
      const exists = current.some((draft) => draft.id === next.id);
      return exists
        ? current.map((draft) => (draft.id === next.id ? next : draft))
        : [...current, next];
    });
  }

  function selectEntry(id: string) {
    setSelectedId(id);
    setDirty(false);
    setSavedFlash(false);
    setActionError(null);
    const draft = drafts.find((candidate) => candidate.id === id);
    if (draft) {
      const linked = catalog.find(
        (entry) => entry.stable_key === draft.draft_key,
      );
      setWorking(workingFromDraft(draft, linked?.id ?? null));
      return;
    }
    const entry = catalog.find((candidate) => candidate.id === id);
    if (!entry) return;
    const staged = draftsByKey.get(entry.stable_key);
    setWorking(staged ? workingFromDraft(staged, entry.id) : null);
  }

  function patchWorking(patch: Partial<PolicyWorkingDoc>) {
    if (!working || frozen) return;
    setWorking({ ...working, ...patch });
    setDirty(true);
    setSavedFlash(false);
  }

  function patchBlocks(patch: Partial<PolicyWorkingDoc["blocks"]>) {
    if (!working) return;
    patchWorking({ blocks: { ...working.blocks, ...patch } });
  }

  function addPolicy() {
    const doc = newWorkingDoc(s);
    setWorking(doc);
    setSelectedId(NEW_POLICY_ID);
    setDirty(false);
    setSavedFlash(false);
    setActionError(null);
  }

  function startRevision(entry: PolicyCatalogEntry) {
    setWorking({
      draftId: null,
      catalogId: entry.id,
      draftKey: entry.stable_key,
      title: entry.title,
      blocks: { effect: entry.effect, action: "view", resource_type: "", conditions: [] },
    });
    setSelectedId(entry.id);
    setDirty(true);
    setSavedFlash(false);
  }

  function withdraw() {
    // Local discard only — the server draft (if any) stays the source of truth.
    if (workingDraft) {
      setWorking(workingFromDraft(workingDraft, working?.catalogId ?? null));
    } else if (working?.catalogId) {
      setWorking(null);
    }
    setDirty(false);
    setSavedFlash(false);
    setActionError(null);
  }

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : w.loadFailed);
    } finally {
      setBusy(false);
    }
  }

  function saveDraft() {
    if (!working) return;
    const doc = working;
    void runAction(async () => {
      const saved = doc.draftId
        ? await updatePolicyDraft(api, doc.draftId, {
            title: doc.title,
            blocks: doc.blocks,
          })
        : await createPolicyDraft(api, {
            draft_key: doc.draftKey,
            title: doc.title,
            blocks: doc.blocks,
          });
      upsertDraft(saved);
      setWorking(workingFromDraft(saved, doc.catalogId));
      if (!doc.draftId && !doc.catalogId) setSelectedId(saved.id);
      setDirty(false);
      setSavedFlash(true);
    });
  }

  function validateDraft() {
    if (!workingDraft) return;
    const id = workingDraft.id;
    void runAction(async () => {
      upsertDraft(await validatePolicyDraft(api, id));
    });
  }

  function submitDraft() {
    if (!workingDraft) return;
    const id = workingDraft.id;
    void runAction(async () => {
      upsertDraft(await submitPolicyDraft(api, id));
    });
  }

  function reviewDraft(decision: "approve" | "reject") {
    if (!workingDraft) return;
    const id = workingDraft.id;
    void runAction(async () => {
      upsertDraft(await reviewPolicyDraft(api, id, { decision }));
    });
  }

  if (loadState === "loading") {
    return (
      <section className="console" style={rootStyle} aria-label={s.title} aria-busy>
        <header style={headerStyle}>
          <h2 style={titleStyle}>{s.title}</h2>
        </header>
        <p style={ruleLineStyle}>{w.loading}</p>
      </section>
    );
  }

  if (loadState === "error") {
    return (
      <section className="console" style={rootStyle} aria-label={s.title}>
        <header style={headerStyle}>
          <h2 style={titleStyle}>{s.title}</h2>
        </header>
        <div style={bannerStyle} role="alert">
          <span>{w.loadFailed}</span>
          <button type="button" style={buttonStyle} onClick={() => void load()}>
            {w.retry}
          </button>
        </div>
      </section>
    );
  }

  const empty =
    catalog.length === 0 && drafts.length === 0 && working === null;

  return (
    <section className="console" style={rootStyle} aria-label={s.title}>
      <header style={headerStyle}>
        <h2 style={titleStyle}>{s.title}</h2>
        <div style={chipRowStyle}>
          <StatusChip tone="info">{s.denyDefaultChip}</StatusChip>
          <StatusChip tone="danger">{s.forbidWinsChip}</StatusChip>
          <PolicyGated action={POLICY_CANVAS_ACTIONS.author}>
            <button type="button" style={primaryButtonStyle} onClick={addPolicy}>
              {s.addPolicy}
            </button>
          </PolicyGated>
        </div>
      </header>

      {actionError ? (
        <div style={bannerStyle} role="alert">
          {actionError}
        </div>
      ) : null}

      {empty ? (
        <p style={ruleLineStyle}>{w.emptyCatalog}</p>
      ) : (
        <div style={bodyGridStyle}>
          <nav style={cardStyle} aria-label={s.catalogLabel}>
            <ul style={listStyle}>
              {working && !working.draftId && !working.catalogId ? (
                <li key={NEW_POLICY_ID}>
                  <button
                    type="button"
                    style={
                      selectedId === NEW_POLICY_ID
                        ? selectedListButtonStyle
                        : listButtonStyle
                    }
                    aria-pressed={selectedId === NEW_POLICY_ID}
                    aria-label={s.policyAria(working.title)}
                    onClick={() => {
                      setSelectedId(NEW_POLICY_ID);
                    }}
                  >
                    <span>{working.title}</span>
                    <StatusChip tone="neutral">{w.newPolicyHint}</StatusChip>
                  </button>
                </li>
              ) : null}
              {catalog.map((entry) => {
                const staged = draftsByKey.get(entry.stable_key);
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      style={
                        entry.id === selectedId
                          ? selectedListButtonStyle
                          : listButtonStyle
                      }
                      aria-pressed={entry.id === selectedId}
                      aria-label={s.policyAria(entry.title)}
                      onClick={() => {
                        selectEntry(entry.id);
                      }}
                    >
                      <span>{entry.title}</span>
                      <span style={chipRowStyle}>
                        <StatusChip
                          tone={entry.status === "enforced" ? "ok" : "neutral"}
                        >
                          {w.catalogStatus[entry.status] ?? entry.status}
                        </StatusChip>
                        {staged ? (
                          <StatusChip tone="warn">
                            {w.pendingRevBanner}
                          </StatusChip>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
              {standaloneDrafts.map((draft) => (
                <li key={draft.id}>
                  <button
                    type="button"
                    style={
                      draft.id === selectedId
                        ? selectedListButtonStyle
                        : listButtonStyle
                    }
                    aria-pressed={draft.id === selectedId}
                    aria-label={s.policyAria(draft.title)}
                    onClick={() => {
                      selectEntry(draft.id);
                    }}
                  >
                    <span>{draft.title}</span>
                    <StatusChip
                      tone={
                        draft.review_status === "review_pending"
                          ? "warn"
                          : draft.review_status === "rejected"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {w.reviewStatus[draft.review_status] ??
                        draft.review_status}
                    </StatusChip>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {readOnlyCatalogView ? (
            <div style={cardStyle} aria-label={s.canvasLabel}>
              <div style={chipRowStyle}>
                <StatusChip
                  tone={
                    readOnlyCatalogView.status === "enforced" ? "ok" : "neutral"
                  }
                >
                  {w.catalogStatus[readOnlyCatalogView.status] ??
                    readOnlyCatalogView.status}
                </StatusChip>
                <StatusChip
                  tone={
                    readOnlyCatalogView.effect === "forbid" ? "danger" : "info"
                  }
                >
                  {s.effectLabels[readOnlyCatalogView.effect]}
                </StatusChip>
              </div>
              <p style={ruleLineStyle}>{readOnlyCatalogView.title}</p>
              <PolicyGated action={POLICY_CANVAS_ACTIONS.author}>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  onClick={() => {
                    startRevision(readOnlyCatalogView);
                  }}
                >
                  {w.startRevision}
                </button>
              </PolicyGated>
            </div>
          ) : working && canvasDoc ? (
            <div style={{ display: "grid", gap: "var(--sp-4)", minWidth: 0 }}>
              {workingCatalog ? (
                <div style={bannerStyle} role="status">
                  <StatusChip tone="warn">{w.pendingRevBanner}</StatusChip>
                  <StatusChip tone="neutral">
                    {w.catalogStatus[workingCatalog.status] ??
                      workingCatalog.status}
                  </StatusChip>
                  {workingDraft?.review_status === "review_pending" ? (
                    <StatusChip tone="info">
                      {s.pendingRev.approveRequested}
                    </StatusChip>
                  ) : null}
                  <PolicyGated action={POLICY_CANVAS_ACTIONS.author}>
                    <button type="button" style={buttonStyle} onClick={withdraw}>
                      {s.pendingRev.withdraw}
                    </button>
                  </PolicyGated>
                </div>
              ) : null}

              <div style={cardStyle} aria-label={s.canvasLabel}>
                <BlockCanvas
                  doc={canvasDoc}
                  strings={canvasStrings}
                  selectedId={focusedBlock}
                  onSelectNode={setFocusedBlock}
                />
                <p style={ruleLineStyle} aria-label={s.ruleLineLabel}>
                  {ruleLine(working.blocks, s)}
                </p>
              </div>

              <SimulatorPanel
                api={api}
                orgId={orgId}
                s={s}
                w={w}
                working={working}
              />
            </div>
          ) : null}

          {working && !readOnlyCatalogView ? (
            <div
              style={{ display: "grid", gap: "var(--sp-4)" }}
              aria-label={s.configLabel}
            >
              <label style={labelStyle}>
                {s.nameLabel}
                <input
                  type="text"
                  style={selectStyle}
                  value={working.title}
                  disabled={frozen}
                  onChange={(event) => {
                    patchWorking({ title: event.currentTarget.value });
                  }}
                />
              </label>

              <ConfigFieldset
                legend={s.blocks.resource}
                focused={focusedBlock === POLICY_BLOCK_IDS.resource}
                disabled={frozen}
              >
                <label style={labelStyle}>
                  {s.objectTypeLabel}
                  <input
                    type="text"
                    style={selectStyle}
                    value={working.blocks.resource_type}
                    onChange={(event) => {
                      patchBlocks({ resource_type: event.currentTarget.value });
                    }}
                  />
                </label>
              </ConfigFieldset>

              <ConfigFieldset
                legend={s.blocks.action}
                focused={focusedBlock === POLICY_BLOCK_IDS.action}
                disabled={frozen}
              >
                <div
                  style={toggleRowStyle}
                  role="group"
                  aria-label={s.blocks.action}
                >
                  {POLICY_ACTIONS.map((action) => (
                    <button
                      key={action}
                      type="button"
                      style={toggleChipStyle(working.blocks.action === action)}
                      aria-pressed={working.blocks.action === action}
                      onClick={() => {
                        patchBlocks({ action });
                      }}
                    >
                      {actionLabel(s, action)}
                    </button>
                  ))}
                </div>
              </ConfigFieldset>

              <ConfigFieldset
                legend={s.blocks.effect}
                focused={focusedBlock === POLICY_BLOCK_IDS.effect}
                disabled={frozen}
              >
                <div
                  style={toggleRowStyle}
                  role="group"
                  aria-label={s.blocks.effect}
                >
                  {(["permit", "forbid"] as const).map((effect) => (
                    <button
                      key={effect}
                      type="button"
                      style={toggleChipStyle(working.blocks.effect === effect)}
                      aria-pressed={working.blocks.effect === effect}
                      onClick={() => {
                        patchBlocks({ effect });
                      }}
                    >
                      {s.effectLabels[effect]}
                    </button>
                  ))}
                </div>
              </ConfigFieldset>

              <ConfigFieldset
                legend={s.conditionLabel}
                focused={focusedBlock === POLICY_BLOCK_IDS.principal}
                disabled={frozen}
              >
                <PredicateEditor
                  group={conditionsToGroup(working.blocks.conditions ?? [])}
                  registry={registry}
                  strings={canvasStrings}
                  onChange={(group: PredicateGroup) => {
                    // backend conditions are AND-only; the join is fixed.
                    patchBlocks({ conditions: groupToConditions(group) });
                  }}
                />
              </ConfigFieldset>

              {workingDraft ? (
                <ValidationSummary draft={workingDraft} w={w} />
              ) : null}

              <div style={chipRowStyle}>
                <PolicyGated action={POLICY_CANVAS_ACTIONS.author}>
                  <button
                    type="button"
                    style={primaryButtonStyle}
                    disabled={!dirty || busy || frozen}
                    onClick={saveDraft}
                  >
                    {s.saveDraft}
                  </button>
                </PolicyGated>
                {workingDraft && !dirty && !frozen ? (
                  <PolicyGated action={POLICY_CANVAS_ACTIONS.author}>
                    <button
                      type="button"
                      style={buttonStyle}
                      disabled={busy}
                      onClick={validateDraft}
                    >
                      {w.validate}
                    </button>
                  </PolicyGated>
                ) : null}
                {workingDraft &&
                !dirty &&
                workingDraft.validation_status === "valid" &&
                (workingDraft.review_status === "draft" ||
                  workingDraft.review_status === "rejected") ? (
                  <PolicyGated action={POLICY_CANVAS_ACTIONS.author}>
                    <button
                      type="button"
                      style={primaryButtonStyle}
                      disabled={busy}
                      onClick={submitDraft}
                    >
                      {s.pendingRev.approve}
                    </button>
                  </PolicyGated>
                ) : null}
                {workingDraft?.review_status === "review_pending" ? (
                  <PolicyGated action={POLICY_CANVAS_ACTIONS.approve}>
                    <span style={chipRowStyle}>
                      <button
                        type="button"
                        style={primaryButtonStyle}
                        disabled={busy}
                        onClick={() => {
                          reviewDraft("approve");
                        }}
                      >
                        {w.reviewApprove}
                      </button>
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={busy}
                        onClick={() => {
                          reviewDraft("reject");
                        }}
                      >
                        {w.reviewReject}
                      </button>
                    </span>
                  </PolicyGated>
                ) : null}
                {dirty ? (
                  <PolicyGated action={POLICY_CANVAS_ACTIONS.author}>
                    <button type="button" style={buttonStyle} onClick={withdraw}>
                      {s.pendingRev.withdraw}
                    </button>
                  </PolicyGated>
                ) : null}
                {savedFlash ? (
                  <StatusChip tone="ok" role="status">
                    {s.draftSaved}
                  </StatusChip>
                ) : null}
                {workingDraft ? (
                  <StatusChip
                    tone={
                      workingDraft.review_status === "review_pending"
                        ? "warn"
                        : workingDraft.review_status === "rejected"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {w.reviewStatus[workingDraft.review_status] ??
                      workingDraft.review_status}
                  </StatusChip>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ValidationSummary({
  draft,
  w,
}: {
  draft: PolicyDraft;
  w: PolicyCanvasWireStrings;
}) {
  if (draft.validation_status === "valid") {
    return (
      <StatusChip tone="ok" role="status">
        {w.validationOk}
      </StatusChip>
    );
  }
  if (draft.validation_errors.length === 0) return null;
  return (
    <ul style={errorListStyle} role="alert" aria-label={w.validationErrorsLabel}>
      {draft.validation_errors.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

function SimulatorPanel({
  api,
  orgId,
  s,
  w,
  working,
}: {
  api: ConsoleApiClient;
  orgId: string;
  s: PolicyCanvasStrings;
  w: PolicyCanvasWireStrings;
  working: PolicyWorkingDoc;
}) {
  const [userId, setUserId] = useState("");
  const [roles, setRoles] = useState("");
  const [owner, setOwner] = useState("");
  const [branch, setBranch] = useState("");
  const [legalHold, setLegalHold] = useState(false);
  const [simAction, setSimAction] = useState<PolicyAction>("view");
  const [outcome, setOutcome] = useState<PolicySimulationOutcome | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setSimError(null);
    try {
      const result = await simulatePolicy(api, {
        request: {
          subject: {
            org: orgId,
            user_id: userId,
            roles: roles
              .split(",")
              .map((role) => role.trim())
              .filter(Boolean),
          },
          action: simAction,
          resource: {
            org: orgId,
            resource_type: working.blocks.resource_type,
            ...(owner ? { owner } : {}),
            ...(branch ? { branch } : {}),
            ...(legalHold ? { legal_hold: true } : {}),
          },
        },
        ...(working.draftId ? { include_draft_id: working.draftId } : {}),
      });
      setOutcome(result);
    } catch (error) {
      setOutcome(null);
      setSimError(error instanceof Error ? error.message : w.loadFailed);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section style={cardStyle} aria-label={s.simulator.label}>
      <div style={headerStyle}>
        <h3 style={{ ...titleStyle, fontSize: "var(--text-sm)" }}>
          {s.simulator.label}
        </h3>
        {outcome ? (
          <div style={chipRowStyle}>
            <StatusChip
              tone={outcome.effect === "allow" ? "ok" : "danger"}
              role="status"
            >
              {outcome.effect === "allow"
                ? s.simulator.allow
                : s.simulator.deny}
            </StatusChip>
            <StatusChip tone="neutral">
              {s.simulator.reasons[decisionReason(outcome)]}
            </StatusChip>
          </div>
        ) : null}
      </div>
      <div style={toggleRowStyle}>
        <label style={{ ...labelStyle, flex: "1 1 160px" }}>
          {w.subjectUserId}
          <input
            type="text"
            style={selectStyle}
            value={userId}
            onChange={(event) => {
              setUserId(event.currentTarget.value);
            }}
          />
        </label>
        <label style={{ ...labelStyle, flex: "1 1 160px" }}>
          {w.subjectRoles}
          <input
            type="text"
            style={selectStyle}
            value={roles}
            onChange={(event) => {
              setRoles(event.currentTarget.value);
            }}
          />
        </label>
        <label style={{ ...labelStyle, flex: "1 1 120px" }}>
          {s.simulator.actionLabel}
          <select
            style={selectStyle}
            value={simAction}
            onChange={(event) => {
              setSimAction(event.currentTarget.value as PolicyAction);
            }}
          >
            {POLICY_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {actionLabel(s, action)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={toggleRowStyle}>
        <label style={{ ...labelStyle, flex: "1 1 140px" }}>
          {w.resourceOwner}
          <input
            type="text"
            style={selectStyle}
            value={owner}
            onChange={(event) => {
              setOwner(event.currentTarget.value);
            }}
          />
        </label>
        <label style={{ ...labelStyle, flex: "1 1 140px" }}>
          {w.resourceBranch}
          <input
            type="text"
            style={selectStyle}
            value={branch}
            onChange={(event) => {
              setBranch(event.currentTarget.value);
            }}
          />
        </label>
        <label
          style={{
            ...labelStyle,
            flex: "0 1 auto",
            alignItems: "start",
            alignContent: "center",
          }}
        >
          {w.legalHold}
          <input
            type="checkbox"
            checked={legalHold}
            onChange={(event) => {
              setLegalHold(event.currentTarget.checked);
            }}
          />
        </label>
        <button
          type="button"
          style={{ ...primaryButtonStyle, alignSelf: "end" }}
          disabled={running}
          onClick={() => void run()}
        >
          {w.run}
        </button>
      </div>
      {simError ? (
        <p style={{ ...ruleLineStyle }} role="alert">
          {simError}
        </p>
      ) : null}
      {outcome ? (
        <dl style={auditListStyle} aria-label={s.simulator.auditPreviewLabel}>
          <div style={auditRowStyle}>
            <dt>{s.simulator.auditActor}</dt>
            <dd style={auditValueStyle}>{userId}</dd>
          </div>
          <div style={auditRowStyle}>
            <dt>{s.simulator.auditAction}</dt>
            <dd style={auditValueStyle}>{actionLabel(s, simAction)}</dd>
          </div>
          <div style={auditRowStyle}>
            <dt>{s.simulator.auditResource}</dt>
            <dd style={auditValueStyle}>{working.blocks.resource_type}</dd>
          </div>
          <div style={auditRowStyle}>
            <dt>{s.simulator.auditDecision}</dt>
            <dd style={auditValueStyle}>
              {outcome.effect === "allow"
                ? s.simulator.allow
                : s.simulator.deny}
            </dd>
          </div>
          <div style={auditRowStyle}>
            <dt>{s.simulator.auditPolicy}</dt>
            <dd style={auditValueStyle}>
              {outcome.determining_policies.length > 0
                ? outcome.determining_policies.join(s.listSeparator)
                : s.simulator.noMatchedPolicy}
            </dd>
          </div>
          <div style={auditRowStyle}>
            <dt>{w.simReason}</dt>
            <dd style={auditValueStyle}>{outcome.reason}</dd>
          </div>
        </dl>
      ) : null}
      {outcome && outcome.errors.length > 0 ? (
        <ul style={errorListStyle} role="alert" aria-label={w.simErrorsLabel}>
          {outcome.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ConfigFieldset({
  legend,
  focused,
  disabled = false,
  children,
}: {
  legend: string;
  focused: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    // native fieldset[disabled] freezes every control while review_pending
    <fieldset
      disabled={disabled}
      style={focused ? focusedFieldsetStyle : fieldsetStyle}
    >
      <legend style={legendStyle}>{legend}</legend>
      {children}
    </fieldset>
  );
}
