/* eslint-disable react-refresh/only-export-components */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { objectCardWindowEntry, type ObjectCardDescriptor } from "../objectcard";
import type { ObjectLifecycleState as CardLifecycleState } from "../objectcard";
import { PolicyGated } from "../policy";
import { objDrag, useOptionalWindowManager } from "../window";
import "../tokens.css";
import {
  OBJECT_EXPLORER_ACTIONS,
  buildObjectExplorerView,
  createDraftObjectNode,
  layoutObjectExplorerNodes,
  lifecycleTone,
  type ObjectExplorerModel,
  type ObjectExplorerNode,
  type ObjectExplorerNodeLayout,
  type ObjectExplorerTypeCard,
  type ObjectLifecycleState,
  type StatusTone,
} from "./ObjectExplorerModel";

export {
  OBJECT_EXPLORER_ACTIONS,
  buildObjectExplorerView,
  layoutObjectExplorerNodes,
  type ObjectExplorerModel,
  type ObjectExplorerNode,
  type ObjectExplorerNodeLayout,
} from "./ObjectExplorerModel";

const T = ko.console.explore;
const DEFAULT_SEARCH_ENDPOINT = "/api/v1/search";
const DEFAULT_SEARCH_LIMIT = 10;

type RegistryKind = "ontology_type" | "series";
type SearchState = "idle" | "loading" | "ready" | "error";
type SubmitEventLike = { preventDefault: () => void };

interface RegistryCardView {
  id: string;
  code: string;
  label: string;
  kind: RegistryKind;
  ariaLabel: string;
  lifecycle: ObjectLifecycleState;
  countChip: string;
  triggerBindings: string[];
  detailChips: string[];
}

interface RegistrySectionView {
  key: string;
  title: string;
  cards: RegistryCardView[];
}

export interface ObjectExplorerScreenProps {
  model?: ObjectExplorerModel;
  initialFocusId?: string;
  bearerToken?: string;
  searchEndpoint?: string;
  searchLimit?: number;
  onFocusChange?: (id: string) => void;
  onNodeCreate?: (node: ObjectExplorerNode) => void;
  /**
   * GET /ontology/instances/{id} (+history/traverse) → the pinned card payload.
   * Absent (or failing), the card degrades to the node's own graph fields.
   */
  resolveNodeDescriptor?: (node: ObjectExplorerNode) => Promise<ObjectCardDescriptor>;
}

interface ObjectSearchResult {
  kind: string;
  id: string;
  code?: string;
  title?: string;
  label?: string;
  status?: string;
}

const rootStyle: CSSProperties = {
  minHeight: "100%",
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-6)",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
};

const headerTitleGroupStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-h1)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const bodyGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(240px, 320px)",
  gap: "var(--sp-5)",
  alignItems: "start",
};

const leftColumnStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
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

const graphStyle: CSSProperties = {
  position: "relative",
  minHeight: 420,
  overflow: "hidden",
  border: "1px solid var(--canvas-grid-bd)",
  borderRadius: "var(--radius-card)",
  background: "var(--canvas-grid-bg)",
};

const edgeLayerStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

const buttonStyle: CSSProperties = {
  minHeight: 34,
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

const inputStyle: CSSProperties = {
  minHeight: 34,
  minWidth: 0,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
};

const createFormStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(120px, 180px) minmax(140px, 1fr) auto",
  gap: "var(--sp-2)",
};

const searchFormStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(180px, 1fr) auto",
  gap: "var(--sp-2)",
  alignItems: "end",
};

const fieldLabelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const relationListStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const nodePillStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  minWidth: 132,
  padding: "var(--sp-3)",
  borderRadius: "var(--radius-card)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  boxShadow: "var(--canvas-block-shadow)",
  color: "var(--ink)",
  textAlign: "left",
};

const focusNodeStyle: CSSProperties = {
  ...nodePillStyle,
  borderColor: "var(--signal)",
  background: "var(--accent-bg)",
};

const graphButtonStyle: CSSProperties = {
  border: 0,
  padding: 0,
  background: "transparent",
  cursor: "pointer",
};

const monoStyle: CSSProperties = {
  color: "var(--faint)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const objectLabelStyle: CSSProperties = {
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
};

const registryRailStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
};

const EMPTY_MODEL: ObjectExplorerModel = { nodes: [], object_links: [] };

// Map the explorer's lifecycle phase onto the ObjectCard instance FSM. The
// explorer's "review"/undefined collapse to active; "revision" ⇒ locked.
function cardLifecycleState(node: ObjectExplorerNode): CardLifecycleState {
  switch (node.lifecycle?.phase) {
    case "draft":
      return "draft";
    case "revision":
      return "locked";
    case "archived":
      return "archived";
    case "disposed":
      return "disposed";
    default:
      return "active";
  }
}

// Degraded card payload from the node's own graph fields alone — used when no
// resolver is supplied (bare renders) or the instance read fails. No sample
// data: properties/relations/history stay empty until the API supplies them.
function nodeDescriptor(node: ObjectExplorerNode): ObjectCardDescriptor {
  const lifecycleState = cardLifecycleState(node);
  const order: CardLifecycleState[] =
    lifecycleState === "locked"
      ? ["draft", "active", "locked", "archived", "disposed"]
      : ["draft", "active", "archived", "disposed"];
  const currentIndex = order.indexOf(lifecycleState);
  return {
    id: node.id,
    code: node.code,
    title: node.label,
    objectType: { key: node.type_id ?? node.type, title: node.type },
    lifecycleState,
    properties: [],
    relations: [],
    lifecycle: order.map((state, index) => ({
      state,
      reached: index <= currentIndex,
      current: index === currentIndex,
    })),
    history: [],
    actions: [],
  };
}

function lifecycleLabel(lifecycle: ObjectLifecycleState): string {
  return T.lifecycle[lifecycle.phase];
}

function lifecycleChips(lifecycle: ObjectLifecycleState): ReactNode {
  return (
    <>
      <StatusChip tone={lifecycleTone(lifecycle.phase)}>{lifecycleLabel(lifecycle)}</StatusChip>
      {lifecycle.version ? <StatusChip tone="info">{T.labels.version(lifecycle.version)}</StatusChip> : null}
    </>
  );
}

function TriggerBindingChips({ bindings }: { bindings: string[] }) {
  if (bindings.length === 0) return null;
  return (
    <span style={chipRowStyle}>
      {bindings.map((binding) => (
        <StatusChip key={binding} tone="accent">
          {binding}
        </StatusChip>
      ))}
    </span>
  );
}

function NodePill({ node, focus = false }: { node: ObjectExplorerNode; focus?: boolean }) {
  // §4-20/§4-23: every object marker is a drag source — the pill carries its
  // [code label] reference token so it can be dropped into a compose input.
  return (
    <span {...objDrag(node.code, node.label)} title={ko.console.window.dragRefOf(node.label)} style={focus ? focusNodeStyle : nodePillStyle}>
      <span style={monoStyle}>{node.code}</span>
      <span style={objectLabelStyle}>{node.label}</span>
      <span style={chipRowStyle}>
        {node.lifecycle ? lifecycleChips(node.lifecycle) : null}
        {node.automation_chips?.map((chip) => (
          <StatusChip key={chip} tone="neutral">
            {chip}
          </StatusChip>
        ))}
      </span>
      <TriggerBindingChips bindings={node.trigger_bindings ?? []} />
    </span>
  );
}

function GraphEdges({ layout }: { layout: ObjectExplorerNodeLayout[] }) {
  const focusNode = layout.find((node) => node.role === "focus");
  if (!focusNode) return null;
  return (
    <svg aria-hidden="true" focusable="false" style={edgeLayerStyle} viewBox="0 0 100 100" preserveAspectRatio="none">
      {layout
        .filter((node) => node.id !== focusNode.id)
        .map((node) => (
          <line
            key={`${focusNode.id}-${node.id}`}
            x1={focusNode.x}
            y1={focusNode.y}
            x2={node.x}
            y2={node.y}
            stroke="var(--canvas-link)"
            strokeWidth="0.55"
            strokeLinecap="round"
            strokeDasharray={node.role === "related" ? "2 2" : undefined}
          />
        ))}
    </svg>
  );
}

function GraphNode({
  node,
  focus,
  x,
  y,
  onFocus,
  onOpen,
}: {
  node: ObjectExplorerNode;
  focus: boolean;
  x: number;
  y: number;
  onFocus: (id: string) => void;
  onOpen: (node: ObjectExplorerNode) => void;
}) {
  const pill = <NodePill node={node} focus={focus} />;
  const style: CSSProperties = {
    position: "absolute",
    left: `${String(x)}%`,
    top: `${String(y)}%`,
    transform: "translate(-50%, -50%)",
  };

  if (focus) {
    return (
      <div aria-current="true" style={style}>
        {pill}
      </div>
    );
  }

  return (
    <div style={style}>
      <PolicyGated action={OBJECT_EXPLORER_ACTIONS.recenter} resource={{ kind: "object", id: node.id }} fallback={pill}>
        <button
          type="button"
          aria-label={T.actions.recenter(node.label)}
          onClick={() => {
            // §4.7-3: clicking an object recenters the graph AND opens its
            // detail as the right pin panel (the default open gesture — no
            // separate pin button). openObjectDetail no-ops without a window
            // manager (unit tests render this screen bare).
            onFocus(node.id);
            onOpen(node);
          }}
          style={graphButtonStyle}
        >
          {pill}
        </button>
      </PolicyGated>
    </div>
  );
}

function RelationList({ title, relations }: { title: string; relations: { link: { id: string; relation: string }; node: ObjectExplorerNode }[] }) {
  return (
    <section aria-labelledby={`object-explorer-${title}`} style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <h2 id={`object-explorer-${title}`} style={sectionTitleStyle}>
          {title}
        </h2>
        <StatusChip tone="neutral">{T.labels.objectCount(relations.length)}</StatusChip>
      </div>
      {relations.length > 0 ? (
        <ol style={relationListStyle}>
          {relations.map(({ link, node }) => (
            <li key={link.id} {...objDrag(node.code, node.label)} title={ko.console.window.dragRefOf(node.label)}>
              <span style={chipRowStyle}>
                <StatusChip tone="neutral">{link.relation}</StatusChip>
                <StatusChip tone="info">{node.code}</StatusChip>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <StatusChip tone="neutral">{T.labels.empty}</StatusChip>
      )}
    </section>
  );
}

function toObjectTypeRegistryCard(item: ObjectExplorerTypeCard): RegistryCardView {
  return {
    id: item.id,
    code: item.code,
    label: item.label,
    kind: "ontology_type",
    ariaLabel: T.labels.typeCardAria(item.code),
    lifecycle: item.lifecycle,
    countChip: T.labels.objectCount(item.active_object_count),
    triggerBindings: item.trigger_bindings ?? [],
    detailChips: [item.owner, ...(item.governance_chips ?? [])].filter((chip): chip is string => chip !== undefined),
  };
}

function toSeriesRegistryCard(item: NonNullable<ObjectExplorerModel["series_cards"]>[number]): RegistryCardView {
  return {
    id: item.id,
    code: item.code,
    label: item.label,
    kind: "series",
    ariaLabel: T.labels.seriesCardAria(item.code),
    lifecycle: item.lifecycle,
    countChip: T.labels.memberCount(item.member_codes.length),
    triggerBindings: item.trigger_bindings ?? [],
    detailChips: [...item.member_codes, ...(item.governance_chips ?? [])],
  };
}

function buildRegistrySections(model: ObjectExplorerModel): RegistrySectionView[] {
  const sections = [
    {
      key: "types",
      title: T.sections.typeCards,
      cards: (model.object_types ?? []).map(toObjectTypeRegistryCard),
    },
    {
      key: "series",
      title: T.sections.seriesCards,
      cards: (model.series_cards ?? []).map(toSeriesRegistryCard),
    },
  ];
  return sections.filter((section) => section.cards.length > 0);
}

function RegistryCard({ card }: { card: RegistryCardView }) {
  const tone: StatusTone = card.kind === "series" ? "info" : "neutral";
  return (
    <article {...objDrag(card.code, card.label)} title={ko.console.window.dragRefOf(card.label)} aria-label={card.ariaLabel} style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <span style={monoStyle}>{card.code}</span>
        <span style={chipRowStyle}>{lifecycleChips(card.lifecycle)}</span>
      </div>
      <h3 style={sectionTitleStyle}>{card.label}</h3>
      <span style={chipRowStyle}>
        <StatusChip tone={tone}>{card.countChip}</StatusChip>
        {card.detailChips.map((chip) => (
          <StatusChip key={chip} tone="neutral">
            {chip}
          </StatusChip>
        ))}
      </span>
      <TriggerBindingChips bindings={card.triggerBindings} />
    </article>
  );
}

function RegistryRail({ sections }: { sections: RegistrySectionView[] }) {
  if (sections.length === 0) return null;
  return (
    <aside style={registryRailStyle}>
      {sections.map((section) => (
        <section key={section.key} aria-labelledby={`object-explorer-${section.key}`} style={registryRailStyle}>
          <div style={sectionHeaderStyle}>
            <h2 id={`object-explorer-${section.key}`} style={sectionTitleStyle}>
              {section.title}
            </h2>
            <StatusChip tone="neutral">{T.labels.objectCount(section.cards.length)}</StatusChip>
          </div>
          {section.cards.map((card) => (
            <RegistryCard key={card.id} card={card} />
          ))}
        </section>
      ))}
    </aside>
  );
}

function NodeCreatePanel({
  objectTypes,
  graphModel,
  onCreate,
}: {
  objectTypes: ObjectExplorerTypeCard[];
  graphModel: ObjectExplorerModel;
  onCreate: (node: ObjectExplorerNode) => void;
}) {
  const createTypes = objectTypes.filter((type) => type.lifecycle.phase === "active");
  const [selectedTypeId, setSelectedTypeId] = useState(createTypes[0]?.id ?? "");
  const [draftName, setDraftName] = useState("");

  if (createTypes.length === 0) return null;

  const selectedType = createTypes.find((type) => type.id === selectedTypeId) ?? createTypes[0];

  function handleSubmit(event: SubmitEventLike): void {
    event.preventDefault();
    const node = createDraftObjectNode({ label: draftName, type: selectedType, existingNodes: graphModel.nodes });
    if (!node) return;
    onCreate(node);
    setDraftName("");
  }

  return (
    <PolicyGated action={OBJECT_EXPLORER_ACTIONS.createNode} resource={{ kind: "object_graph", id: "draft" }}>
      <section aria-labelledby="object-explorer-create-title" style={cardStyle}>
        <div style={sectionHeaderStyle}>
          <h2 id="object-explorer-create-title" style={sectionTitleStyle}>
            {T.sections.create}
          </h2>
          <StatusChip tone="info">{selectedType.code}</StatusChip>
        </div>
        <form onSubmit={handleSubmit} style={createFormStyle}>
          <select
            aria-label={T.labels.createType}
            value={selectedType.id}
            onChange={(event) => {
              setSelectedTypeId(event.target.value);
            }}
            style={inputStyle}
          >
            {createTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.code} · {type.label}
              </option>
            ))}
          </select>
          <input
            aria-label={T.labels.createName}
            value={draftName}
            placeholder={T.labels.createNamePlaceholder}
            onChange={(event) => {
              setDraftName(event.target.value);
            }}
            style={inputStyle}
          />
          <button type="submit" style={buttonStyle}>
            {T.actions.createNode}
          </button>
        </form>
      </section>
    </PolicyGated>
  );
}

function searchResultLabel(result: ObjectSearchResult): string {
  return result.title ?? result.label ?? result.code ?? result.id;
}

function searchResultToNode(result: ObjectSearchResult): ObjectExplorerNode {
  return {
    id: result.id,
    type: result.kind,
    code: result.code ?? result.id,
    label: searchResultLabel(result),
    automation_chips: result.status ? [result.status] : undefined,
  };
}

function mergeNodesById(nodes: ObjectExplorerNode[]): ObjectExplorerNode[] {
  return Array.from(new Map(nodes.map((node) => [node.id, node])).values());
}

function isObjectSearchResult(value: unknown): value is ObjectSearchResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.kind === "string";
}

function searchRequestHeaders(bearerToken: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Auth-Transport": "cookie",
  };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  return headers;
}

async function fetchObjectSearch({
  bearerToken,
  endpoint,
  limit,
  query,
}: {
  bearerToken?: string;
  endpoint: string;
  limit: number;
  query: string;
}): Promise<ObjectSearchResult[]> {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(endpoint, origin);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: searchRequestHeaders(bearerToken),
  });
  if (!response.ok) throw new Error(`object search failed: ${String(response.status)}`);
  const payload = (await response.json()) as { results?: unknown[] };
  return Array.isArray(payload.results) ? payload.results.filter(isObjectSearchResult) : [];
}

function ObjectSearchPanel({
  query,
  results,
  searchState,
  onQueryChange,
  onSubmit,
  onSelect,
}: {
  query: string;
  results: ObjectSearchResult[];
  searchState: SearchState;
  onQueryChange: (query: string) => void;
  onSubmit: (event: SubmitEventLike) => void;
  onSelect: (result: ObjectSearchResult) => void;
}) {
  const showResults = searchState === "ready" || searchState === "error";
  return (
    <PolicyGated action={OBJECT_EXPLORER_ACTIONS.search} resource={{ kind: "object_search", id: "global" }}>
      <section style={cardStyle}>
        <form onSubmit={onSubmit} style={searchFormStyle}>
          <label style={fieldLabelStyle}>
            {T.search.label}
            <input
              aria-label={T.search.label}
              placeholder={T.search.placeholder}
              value={query}
              onChange={(event) => {
                onQueryChange(event.target.value);
              }}
              style={inputStyle}
            />
          </label>
          <button type="submit" style={primaryButtonStyle}>
            {searchState === "loading" ? T.search.loading : T.search.submit}
          </button>
        </form>
        {showResults ? (
          <section aria-label={T.search.results} style={{ display: "grid", gap: "var(--sp-2)" }}>
            {searchState === "error" ? <StatusChip tone="danger">{T.search.failed}</StatusChip> : null}
            {searchState === "ready" && results.length === 0 ? (
              <StatusChip tone="neutral">{T.search.empty}</StatusChip>
            ) : null}
            {results.length > 0 ? (
              <ol style={relationListStyle}>
                {results.map((result) => {
                  const label = searchResultLabel(result);
                  return (
                    <li key={`${result.kind}:${result.id}`}>
                      <PolicyGated action={OBJECT_EXPLORER_ACTIONS.recenter} resource={{ kind: result.kind, id: result.id }}>
                        <button
                          type="button"
                          aria-label={T.actions.recenter(label)}
                          onClick={() => {
                            onSelect(result);
                          }}
                          style={buttonStyle}
                        >
                          <span style={chipRowStyle}>
                            <StatusChip tone="info">{result.code ?? result.id}</StatusChip>
                            <StatusChip tone="neutral">{label}</StatusChip>
                            <StatusChip tone="accent">{result.kind}</StatusChip>
                          </span>
                        </button>
                      </PolicyGated>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </section>
        ) : null}
      </section>
    </PolicyGated>
  );
}

export function ObjectExplorerScreen({
  model,
  initialFocusId,
  bearerToken,
  searchEndpoint = DEFAULT_SEARCH_ENDPOINT,
  searchLimit = DEFAULT_SEARCH_LIMIT,
  onFocusChange,
  onNodeCreate,
  resolveNodeDescriptor,
}: ObjectExplorerScreenProps) {
  const windowManager = useOptionalWindowManager();
  const baseModel = model ?? EMPTY_MODEL;
  const [createdNodes, setCreatedNodes] = useState<ObjectExplorerNode[]>([]);
  const [searchNodes, setSearchNodes] = useState<ObjectExplorerNode[]>([]);
  const [focusId, setFocusId] = useState(initialFocusId ?? baseModel.nodes[0]?.id);
  const [focusHistory, setFocusHistory] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ObjectSearchResult[]>([]);
  const [searchState, setSearchState] = useState<SearchState>("idle");

  const graphModel = useMemo<ObjectExplorerModel>(
    () => ({
      ...baseModel,
      nodes: mergeNodesById([...baseModel.nodes, ...createdNodes, ...searchNodes]),
    }),
    [baseModel, createdNodes, searchNodes],
  );
  const view = useMemo(
    () =>
      graphModel.nodes.length > 0
        ? buildObjectExplorerView(graphModel, focusId)
        : undefined,
    [focusId, graphModel],
  );
  const layout = useMemo(() => (view ? layoutObjectExplorerNodes(view) : []), [view]);
  const registrySections = useMemo(() => buildRegistrySections(graphModel), [graphModel]);
  const previousFocusId = focusHistory[focusHistory.length - 1];

  function moveFocus(nextFocusId: string): void {
    if (!view || nextFocusId === view.focus.id) return;
    setFocusHistory((current) => [...current, view.focus.id]);
    setFocusId(nextFocusId);
    onFocusChange?.(nextFocusId);
  }

  function moveBack(): void {
    if (!previousFocusId) return;
    setFocusHistory((current) => current.slice(0, -1));
    setFocusId(previousFocusId);
    onFocusChange?.(previousFocusId);
  }

  function handleNodeCreate(node: ObjectExplorerNode): void {
    setCreatedNodes((current) => mergeNodesById([...current, node]));
    moveFocus(node.id);
    onNodeCreate?.(node);
  }

  async function handleSearchSubmit(event: SubmitEventLike): Promise<void> {
    event.preventDefault();
    const query = searchQuery.trim();
    if (query.length === 0) {
      setSearchResults([]);
      setSearchState("idle");
      return;
    }
    setSearchState("loading");
    try {
      const results = await fetchObjectSearch({ bearerToken, endpoint: searchEndpoint, limit: searchLimit, query });
      setSearchResults(results);
      setSearchState("ready");
    } catch {
      setSearchResults([]);
      setSearchState("error");
    }
  }

  function handleSearchSelect(result: ObjectSearchResult): void {
    const node = searchResultToNode(result);
    setSearchNodes((current) => mergeNodesById([...current, node]));
    moveFocus(node.id);
  }

  async function openObjectDetail(node: ObjectExplorerNode): Promise<void> {
    // §4.7-3 default gesture: pin the object's full ObjectCard as the right split
    // panel (payload from GET /ontology/instances/{id} via the resolver). No-op
    // outside a WindowManager.
    if (!windowManager) return;
    let descriptor: ObjectCardDescriptor;
    try {
      descriptor = resolveNodeDescriptor
        ? await resolveNodeDescriptor(node)
        : nodeDescriptor(node);
    } catch {
      descriptor = nodeDescriptor(node);
    }
    windowManager.open(objectCardWindowEntry(descriptor));
  }

  return (
    <main className="console" style={rootStyle}>
      <header style={headerStyle}>
        <div style={headerTitleGroupStyle}>
          <h1 style={titleStyle}>{T.title}</h1>
          <span style={chipRowStyle}>
            <StatusChip tone="info">{T.nodeCount(view?.nodes.length ?? 0)}</StatusChip>
            <StatusChip tone="accent">{T.linkCount(view?.links.length ?? 0)}</StatusChip>
          </span>
        </div>
        {previousFocusId && view ? (
          <PolicyGated action={OBJECT_EXPLORER_ACTIONS.back} resource={{ kind: "object", id: view.focus.id }}>
            <button type="button" onClick={moveBack} style={buttonStyle}>
              {T.actions.back}
            </button>
          </PolicyGated>
        ) : null}
      </header>

      <div style={bodyGridStyle}>
        <div style={leftColumnStyle}>
          <ObjectSearchPanel
            query={searchQuery}
            results={searchResults}
            searchState={searchState}
            onQueryChange={setSearchQuery}
            onSubmit={(event) => {
              void handleSearchSubmit(event);
            }}
            onSelect={handleSearchSelect}
          />

          <section aria-label={T.sections.graph} style={graphStyle}>
            <GraphEdges layout={layout} />
            {layout.map((node) => (
              <GraphNode
                key={node.id}
                node={node.node}
                focus={node.role === "focus"}
                x={node.x}
                y={node.y}
                onFocus={moveFocus}
                onOpen={(target) => {
                  void openObjectDetail(target);
                }}
              />
            ))}
          </section>

          <NodeCreatePanel objectTypes={graphModel.object_types ?? []} graphModel={graphModel} onCreate={handleNodeCreate} />

          {view ? (
            <section aria-label={T.labels.currentFocus} style={cardStyle}>
              <div style={sectionHeaderStyle}>
                <h2 style={sectionTitleStyle}>{T.sections.focus}</h2>
                <StatusChip tone="info">{view.focus.code}</StatusChip>
              </div>
              <NodePill node={view.focus} focus />
            </section>
          ) : (
            <StatusChip tone="neutral">{T.labels.empty}</StatusChip>
          )}

          {view ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--sp-5)" }}>
              <RelationList title={T.sections.upstream} relations={view.upstream} />
              <RelationList title={T.sections.downstream} relations={view.downstream} />
            </div>
          ) : null}
        </div>

        <RegistryRail sections={registrySections} />
      </div>
    </main>
  );
}
