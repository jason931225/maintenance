import { useMemo, useRef, useState, type CSSProperties } from "react";

import { ko } from "../../../i18n/ko";
import type { ConsoleApiClient } from "../../../api/client";
import { OntologyManagerScreen } from "../../ontology";
import {
  OntologyAnalyticsWorkbench,
  type OntologyAnalyticsDrill,
} from "../../ontology/analytics";
import { GraphExplorer } from "./GraphExplorer";
import { BulkPolicyGateProvider } from "../../policy";
import { WindowManagerProvider } from "../../window";
import "../../tokens.css";
import {
  FeedbackBanner,
  StatStrip,
  WorkspaceEmpty,
  WorkspaceError,
  WorkspaceLoading,
  WorkspacePartialFailure,
  type WorkspaceStat,
} from "./WorkspaceChrome";
import {
  ONTOLOGY_GATE_ACTIONS,
  useOntologyWorkspace,
} from "./useOntologyWorkspace";
import { screenHeaderStyle, screenTitleStyle } from "../screenHeader";

const ON = ko.console.ontology;
const TABS = ko.ontology.tabs;

export type WorkspaceTab = "manager" | "graph";

// Evidence/support header grammar (§ rhythm): the shell owns the outer padding
// via the .console class, so the body is just a gap-4 grid — no double padding,
// no minHeight/background repaint, one title header (the graph pane no longer
// ships its own), which fixes R3's floating-title + whitespace-gap defects.
const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const headerStyle = screenHeaderStyle;
const titleStyle = screenTitleStyle;

const tabBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  borderBottom: "1px solid var(--border)",
};

const tabStyle: CSSProperties = {
  minHeight: 44,
  padding: "0 var(--sp-4)",
  border: 0,
  borderBottom: "2px solid transparent",
  background: "transparent",
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const tabActiveStyle: CSSProperties = {
  ...tabStyle,
  borderBottomColor: "var(--signal-deep)",
  color: "var(--ink)",
};

const headerActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const actionButtonStyle: CSSProperties = {
  minHeight: 44,
  padding: "0 var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const drillResultStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  padding: "var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const drillResultHeaderStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "start",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
};

const drillResultListStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

interface AuthorityAnalyticsDrill {
  authorityKey: string | undefined;
  value: OntologyAnalyticsDrill;
}

interface AuthorityFocusRequest {
  authorityKey: string | undefined;
  instanceId: string;
}

interface OntologyWorkspaceBodyBaseProps {
  api: ConsoleApiClient;
  /** Screen title (온톨로지 for the manager, 객체 탐색 for the explorer). */
  title: string;
  /** Tab focused first; the explorer defaults to the graph. */
  defaultTab: WorkspaceTab;
}

export type OntologyWorkspaceBodyProps = OntologyWorkspaceBodyBaseProps &
  (
    | {
        /** The authoring host must provide explicit authority independent of its token. */
        allowManager: true;
        authorityKey: string;
      }
    | {
        allowManager: false;
        authorityKey?: string;
      }
  );

/**
 * Shared ontology workspace — the graph explorer + object inspector both
 * ontology screens center on (§4-18 reuse: one implementation, two mounts).
 * `allowManager` adds the 타입·매니저 authoring tab (draft/publish); the
 * explorer omits it and shows the graph alone.
 *
 * The inspector is the pinned ObjectCard: clicking a graph node opens it as the
 * docked right panel via WindowManagerProvider. Projected instances that can't
 * be resolved (S23) degrade to their graph fields inside the card — no
 * fabricated properties.
 */
export function OntologyWorkspaceBody({
  api,
  authorityKey,
  title,
  defaultTab,
  allowManager,
}: OntologyWorkspaceBodyProps) {
  const authorityPartition = authorityKey?.trim() || undefined;
  const ws = useOntologyWorkspace(
    api,
    { saveFailed: ko.users.form.saveFailed },
    authorityPartition,
  );
  const [tab, setTab] = useState<WorkspaceTab>(allowManager ? defaultTab : "graph");
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analyticsDrill, setAnalyticsDrill] =
    useState<AuthorityAnalyticsDrill>();
  const [focusRequest, setFocusRequest] = useState<AuthorityFocusRequest>();
  const graphRef = useRef<HTMLDivElement>(null);

  const visibleAnalyticsDrill =
    analyticsDrill && analyticsDrill.authorityKey === authorityPartition
      ? analyticsDrill.value
      : undefined;
  const visibleFocusRequest =
    focusRequest && focusRequest.authorityKey === authorityPartition
      ? focusRequest
      : undefined;
  const instanceById = useMemo(
    () =>
      new Map(
        ws.registry.flatMap((objectType) =>
          objectType.instances.map((instance) => [
            instance.id,
            { instance, objectType },
          ] as const),
        ),
      ),
    [ws.registry],
  );

  const stats = useMemo<WorkspaceStat[]>(
    () => [
      { key: "types", label: ON.typeList.title, value: ws.stats.types, drillAria: `${ON.typeList.title} ${ON.count(ws.stats.types)}` },
      { key: "instances", label: ON.subtabs.instances, value: ws.stats.instances, drillAria: `${ON.subtabs.instances} ${ON.count(ws.stats.instances)}` },
      { key: "links", label: ON.subtabs.links, value: ws.stats.links, drillAria: `${ON.subtabs.links} ${ON.count(ws.stats.links)}` },
    ],
    [ws.stats],
  );

  function scrollGraphIntoView(): void {
    // The lib type marks scrollIntoView as always-present, but jsdom (tests) and
    // very old engines omit it — cast so the runtime guard is honest.
    (graphRef.current as { scrollIntoView?: (opts: ScrollIntoViewOptions) => void } | null)
      ?.scrollIntoView?.({ block: "nearest" });
  }

  function handleDrill(key: string): void {
    // §4-11: every stat is a jump. In the manager the 타입 stat lands on the
    // authoring tab; instances/relations land on the graph. The explorer has no
    // tabs, so a stat scrolls the graph into view.
    if (allowManager) {
      setTab(key === "types" ? "manager" : "graph");
      if (key !== "types") scrollGraphIntoView();
    } else {
      scrollGraphIntoView();
    }
  }

  const showManagerTab = allowManager && tab === "manager";
  const partialFailureMessage = ws.partialFailures.length > 0
    ? `${ko.page.loadFailed} (${ws.partialFailures
        .map((failure) =>
          failure.kind === "acting"
            ? `${failure.scopeLabel} · ${ON.subtabs.automations}`
            : `${failure.scopeLabel} · ${TABS.graph}`,
        )
        .join(", ")})`
    : undefined;

  return (
    <section className="console" aria-label={title} style={rootStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>{title}</h1>
        <div style={headerActionsStyle}>
          <button
            type="button"
            onClick={() => {
              setAnalyticsOpen(true);
            }}
            style={actionButtonStyle}
          >
            {ON.analysis.open}
          </button>
        </div>
      </header>
      <StatStrip stats={stats} onDrill={handleDrill} ariaLabel={title} />
      {allowManager ? (
        <div role="tablist" aria-label={title} style={tabBarStyle}>
          {(["manager", "graph"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => {
                setTab(key);
              }}
              style={tab === key ? tabActiveStyle : tabStyle}
            >
              {key === "manager" ? TABS.manager : TABS.graph}
            </button>
          ))}
        </div>
      ) : null}

      {ws.feedback ? (
        <FeedbackBanner message={ws.feedback} onDismiss={ws.clearFeedback} />
      ) : null}
      {partialFailureMessage ? (
        <WorkspacePartialFailure
          message={partialFailureMessage}
          onRetry={() => {
            void ws.retryPartialFailures();
          }}
        />
      ) : null}

      {ws.readState === "loading" ? (
        <WorkspaceLoading />
      ) : ws.readState === "error" ? (
        <WorkspaceError
          onRetry={() => {
            void ws.reload();
          }}
        />
      ) : ws.isEmpty ? (
        <WorkspaceEmpty />
      ) : (
        <BulkPolicyGateProvider actions={ONTOLOGY_GATE_ACTIONS}>
          <WindowManagerProvider
            key={authorityPartition}
            authorityPartition={authorityPartition}
            retentionEnabled={authorityPartition !== undefined}
          >
            {showManagerTab ? (
              <OntologyManagerScreen
                registry={ws.registry}
                onCreateType={ws.onCreateType}
                onCommitRevision={ws.onCommitRevision}
                resolveInstanceCard={ws.resolveInstanceCard}
              />
            ) : (
              <div ref={graphRef}>
                {visibleAnalyticsDrill ? (
                  <section
                    aria-labelledby="ontology-analytics-result-title"
                    style={drillResultStyle}
                  >
                    <div style={drillResultHeaderStyle}>
                      <div>
                        <h2
                          id="ontology-analytics-result-title"
                          style={{ margin: 0, fontSize: "var(--text-md)" }}
                        >
                          {ON.analysis.result.title}
                        </h2>
                        <p
                          style={{
                            margin: "var(--sp-1) 0 0",
                            color: "var(--steel)",
                          }}
                        >
                          {ON.analysis.result.summary(
                            visibleAnalyticsDrill.objectType.title,
                            visibleAnalyticsDrill.dimensionLabel,
                            visibleAnalyticsDrill.value,
                            visibleAnalyticsDrill.instanceIds.length,
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setAnalyticsDrill(undefined);
                          setFocusRequest(undefined);
                        }}
                        style={actionButtonStyle}
                      >
                        {ON.analysis.result.clear}
                      </button>
                    </div>
                    <ul style={drillResultListStyle}>
                      {visibleAnalyticsDrill.instanceIds.map((instanceId) => {
                        const registered = instanceById.get(instanceId);
                        const label = registered
                          ? `${registered.instance.code} · ${registered.instance.title}`
                          : instanceId;
                        return (
                          <li key={instanceId}>
                            <button
                              type="button"
                              onClick={() => {
                                setFocusRequest({
                                  authorityKey: authorityPartition,
                                  instanceId,
                                });
                                ws.onGraphFocusChange(instanceId);
                              }}
                              style={{ ...actionButtonStyle, width: "100%" }}
                            >
                              {ON.analysis.result.openInstance(label)}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}
                <GraphExplorer
                  api={api}
                  model={ws.explorerModel}
                  onFocusChange={(instanceId) => {
                    setFocusRequest(undefined);
                    ws.onGraphFocusChange(instanceId);
                  }}
                  resolveNodeDescriptor={ws.resolveNodeDescriptor}
                  projectedTypeIds={ws.projectedTypeIds}
                  requestedFocusId={visibleFocusRequest?.instanceId}
                />
              </div>
            )}
          </WindowManagerProvider>
        </BulkPolicyGateProvider>
      )}
      <OntologyAnalyticsWorkbench
        key={authorityPartition ?? "authority-unavailable"}
        api={api}
        authorityKey={authorityPartition}
        open={analyticsOpen}
        onClose={() => {
          setAnalyticsOpen(false);
        }}
        onDrill={(drill) => {
          setAnalyticsOpen(false);
          setAnalyticsDrill({
            authorityKey: authorityPartition,
            value: drill,
          });
          setFocusRequest(undefined);
          if (allowManager) setTab("graph");
          scrollGraphIntoView();
        }}
      />
    </section>
  );
}
