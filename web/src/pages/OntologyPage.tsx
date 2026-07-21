import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  createObjectType,
  getInstance,
  getInstanceHistory,
  getObjectType,
  listInstances,
  listObjectTypes,
  stageObjectTypeRevision,
  traverseInstance,
  type InstanceStateWire,
  type ObjectTypeDetailWire,
  type TraversalGraphWire,
} from "../api/ontology";
import { PageHeader } from "../components/shell/PageHeader";
import { FeedbackBanner } from "../components/states/FeedbackBanner";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import {
  OBJECT_EXPLORER_ACTIONS,
  ObjectExplorerScreen,
  ontologyExplorerModel,
  type ObjectExplorerNode,
} from "../console/explore";
import type { ObjectCardDescriptor } from "../console/objectcard";
import {
  ONTOLOGY_MANAGER_ACTIONS,
  OntologyManagerScreen,
  objectCardDescriptorFrom,
  objectTypeDefFromDetail,
  stagedRevisionDraft,
  type OntInstanceRow,
  type OntObjectTypeDef,
} from "../console/ontology";
import {
  ontologyRevisionAuthorityKey,
  useOntologyRevisionCommitQueue,
  type OntologyRevisionPersistContext,
} from "../console/ontology/useOntologyRevisionCommitQueue";
import { BulkPolicyGateProvider } from "../console/policy";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { cn } from "../lib/utils";

type OntologyTab = "manager" | "graph";
type ReadState = "loading" | "idle" | "error";

/** One registry entry: the wire detail + its current-state instances. */
interface RegistryEntry {
  detail: ObjectTypeDetailWire;
  instances: InstanceStateWire[];
}

interface LoadedOntologyState {
  authorityKey: string | undefined;
  entries: RegistryEntry[];
  graphs: TraversalGraphWire[];
}

interface AuthorityReadState {
  authorityKey: string | undefined;
  value: ReadState;
}

const EMPTY_ENTRIES: RegistryEntry[] = [];
const EMPTY_GRAPHS: TraversalGraphWire[] = [];

// Deny-by-omission action set for the ontology workspace, resolved at mount via
// POST /api/v1/policy/authorize/bulk (arch §5c) — see BulkPolicyGateProvider.
const ONTOLOGY_GATE_ACTIONS: readonly string[] = [
  ...Object.values(ONTOLOGY_MANAGER_ACTIONS),
  ...Object.values(OBJECT_EXPLORER_ACTIONS),
];

/**
 * Ontology workspace (파운드리 › 온톨로지), wired to the ontology REST:
 *  - 타입·매니저: GET/POST /api/v1/ontology/object-types (+{key} detail),
 *    GET /instances?type=, PUT /object-types/{key} staging (§3.9.0).
 *  - 그래프·탐색: GET /instances/{id}/traverse search-around + the registry rail.
 * Instance clicks resolve GET /instances/{id} (+/history, depth-1 traverse)
 * into the ObjectCard payload — hash verification comes from the fixity chain
 * in the history payload.
 */
export function OntologyPage() {
  const { api, session, viewAs } = useAuth();
  const authorityKey = ontologyRevisionAuthorityKey(session, viewAs);
  const [tab, setTab] = useState<OntologyTab>("manager");
  const [readState, setReadState] = useState<AuthorityReadState>({
    authorityKey: undefined,
    value: "loading",
  });
  const [loadedState, setLoadedState] = useState<LoadedOntologyState>({
    authorityKey: undefined,
    entries: EMPTY_ENTRIES,
    graphs: EMPTY_GRAPHS,
  });
  const [feedback, setFeedback] = useState<string>();
  const authorityScope = useMemo(
    () => ({ key: authorityKey }),
    [authorityKey],
  );
  // Retain only the committed authority scope. The epoch invalidates stale
  // async work without a strong collection of every retired tenant scope.
  const currentAuthorityScopeRef = useRef<object | null>(null);
  const lifetimeEpochRef = useRef(0);
  const readRequestRef = useRef(0);
  const loadedAuthorityIsCurrent = loadedState.authorityKey === authorityKey;
  const entries = loadedAuthorityIsCurrent ? loadedState.entries : EMPTY_ENTRIES;
  const graphs = loadedAuthorityIsCurrent ? loadedState.graphs : EMPTY_GRAPHS;
  const visibleReadState = readState.authorityKey === authorityKey
    ? readState.value
    : "loading";

  useLayoutEffect(() => {
    currentAuthorityScopeRef.current = authorityScope;
    return () => {
      if (currentAuthorityScopeRef.current === authorityScope) {
        currentAuthorityScopeRef.current = null;
      }
      lifetimeEpochRef.current += 1;
      readRequestRef.current += 1;
    };
  }, [authorityScope]);

  const isAuthorityCurrent = useCallback(
    (scope: object, epoch: number) =>
      currentAuthorityScopeRef.current === scope &&
      lifetimeEpochRef.current === epoch,
    [],
  );

  const load = useCallback(async (coordinatorGuard: () => boolean = () => true) => {
    const lifetimeEpoch = lifetimeEpochRef.current;
    if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
    const requestEpoch = readRequestRef.current + 1;
    readRequestRef.current = requestEpoch;
    const isCurrent = () =>
      isAuthorityCurrent(authorityScope, lifetimeEpoch) &&
      readRequestRef.current === requestEpoch &&
      coordinatorGuard();

    if (!isCurrent()) return;
    setReadState({ authorityKey, value: "loading" });
    setFeedback(undefined);
    try {
      const summaries = await listObjectTypes(api);
      if (!isCurrent()) return;
      const loaded = await Promise.all(
        summaries.map(async (summary) => {
          const [detail, instances] = await Promise.all([
            getObjectType(api, summary.stable_key),
            listInstances(api, summary.id),
          ]);
          return { detail, instances } satisfies RegistryEntry;
        }),
      );
      if (!isCurrent()) return;

      // Seed the graph tab with a search-around from the first instance; a
      // traversal failure degrades to the empty graph, not a page error.
      const root = loaded.flatMap((entry) => entry.instances).at(0);
      let nextGraphs: TraversalGraphWire[] = [];
      if (root) {
        try {
          nextGraphs = [await traverseInstance(api, root.instance.id)];
        } catch {
          nextGraphs = [];
        }
      }
      if (!isCurrent()) return;
      setLoadedState({ authorityKey, entries: loaded, graphs: nextGraphs });
      setReadState({ authorityKey, value: "idle" });
    } catch {
      if (!isCurrent()) return;
      setReadState({ authorityKey, value: "error" });
    }
  }, [api, authorityKey, authorityScope, isAuthorityCurrent]);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(task);
    };
  }, [load]);

  const typeKeyById = useMemo(
    () =>
      new Map(
        entries.map((entry) => [
          entry.detail.object_type.id,
          entry.detail.object_type.stable_key,
        ]),
      ),
    [entries],
  );
  const typeIdByKey = useMemo(
    () =>
      new Map(
        entries.map((entry) => [
          entry.detail.object_type.stable_key,
          entry.detail.object_type.id,
        ]),
      ),
    [entries],
  );
  const typeTitleById = useMemo(
    () =>
      new Map(
        entries.map((entry) => [
          entry.detail.object_type.id,
          entry.detail.object_type.title,
        ]),
      ),
    [entries],
  );
  const linkTitleById = useMemo(
    () =>
      new Map(
        entries.flatMap((entry) =>
          entry.detail.links.map((link) => [link.id, link.title] as const),
        ),
      ),
    [entries],
  );

  const registry = useMemo(
    () =>
      entries.map((entry) =>
        objectTypeDefFromDetail(entry.detail, entry.instances, typeKeyById),
      ),
    [entries, typeKeyById],
  );

  const explorerModel = useMemo(
    () =>
      ontologyExplorerModel({
        graphs,
        types: entries.map((entry) => entry.detail.object_type),
        linkTitleById,
        typeTitleById,
        instanceCountByTypeId: new Map(
          entries.map((entry) => [
            entry.detail.object_type.id,
            entry.instances.length,
          ]),
        ),
      }),
    [entries, graphs, linkTitleById, typeTitleById],
  );

  const resolveInstanceDescriptor = useCallback(
    async (instanceId: string): Promise<ObjectCardDescriptor | undefined> => {
      const lifetimeEpoch = lifetimeEpochRef.current;
      if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return undefined;
      try {
        const [state, history, neighbors] = await Promise.all([
          getInstance(api, instanceId),
          getInstanceHistory(api, instanceId),
          traverseInstance(api, instanceId, { depth: 1 }),
        ]);
        if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return undefined;
        const entry = entries.find(
          (candidate) =>
            candidate.detail.object_type.id === state.instance.object_type_id,
        );
        return objectCardDescriptorFrom({
          state,
          history,
          neighbors,
          detail: entry?.detail,
          linkTitleById,
        });
      } catch (error) {
        if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return undefined;
        throw error;
      }
    },
    [api, authorityScope, entries, isAuthorityCurrent, linkTitleById],
  );

  const resolveInstanceCard = useCallback(
    (row: OntInstanceRow) => resolveInstanceDescriptor(row.id),
    [resolveInstanceDescriptor],
  );

  const resolveNodeDescriptor = useCallback(
    (node: ObjectExplorerNode) => resolveInstanceDescriptor(node.id),
    [resolveInstanceDescriptor],
  );

  const handleCreateType = useCallback(
    async (title: string) => {
      const lifetimeEpoch = lifetimeEpochRef.current;
      if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
      try {
        await createObjectType(api, {
          // ponytail: time-based stable key — a stable-key input lands with the
          // full schema-authoring pass; the title is the human identity.
          stable_key: `ot_${Date.now().toString(36)}`,
          title: title.trim(),
          backing_kind: "instance",
        });
        if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
        await load();
      } catch {
        if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
        setFeedback(ko.users.form.saveFailed);
      }
    },
    [api, authorityScope, isAuthorityCurrent, load],
  );

  const persistRevision = useCallback(
    async (
      staged: OntObjectTypeDef,
      { expected, signal }: OntologyRevisionPersistContext,
    ) => {
      const lifetimeEpoch = lifetimeEpochRef.current;
      if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
      const capturedAuthorityKey = authorityKey;
      if (loadedState.authorityKey !== capturedAuthorityKey) return;
      const entry = loadedState.entries.find(
        (candidate) => candidate.detail.object_type.id === staged.id,
      );
      if (!entry) return;
      try {
        const receipt = await stageObjectTypeRevision(
          api,
          entry.detail.object_type.stable_key,
          stagedRevisionDraft(entry.detail, staged, typeIdByKey),
          { expected, signal },
        );
        // Transport truth must always flow back into the global token chain,
        // even if this host lost UI authority while the response was in flight.
        return receipt;
      } catch (error) {
        if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) throw error;
        setFeedback(ko.users.form.saveFailed);
        throw error; // keeps the 개정 대기 banner up for retry/철회
      }
    },
    [
      api,
      authorityKey,
      authorityScope,
      loadedState.authorityKey,
      loadedState.entries,
      isAuthorityCurrent,
      typeIdByKey,
    ],
  );

  const enqueueRevision = useOntologyRevisionCommitQueue({
    authorityKey,
    persist: persistRevision,
    reload: load,
  });
  const handleCommitRevision = useCallback(
    (staged: OntObjectTypeDef): Promise<void> => {
      const lifetimeEpoch = lifetimeEpochRef.current;
      if (
        !isAuthorityCurrent(authorityScope, lifetimeEpoch) ||
        loadedState.authorityKey !== authorityKey
      ) {
        return Promise.resolve();
      }
      return enqueueRevision(staged);
    },
    [authorityKey, authorityScope, enqueueRevision, isAuthorityCurrent, loadedState.authorityKey],
  );

  const handleGraphFocusChange = useCallback(
    (focusId: string) => {
      const lifetimeEpoch = lifetimeEpochRef.current;
      if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
      void traverseInstance(api, focusId)
        .then((graph) => {
          if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
          setLoadedState((current) =>
            current.authorityKey === authorityKey
              ? { ...current, graphs: [...current.graphs, graph] }
              : current,
          );
        })
        .catch(() => undefined); // keep the already-loaded neighborhood
    },
    [api, authorityKey, authorityScope, isAuthorityCurrent],
  );

  return (
    <>
      <PageHeader title={ko.nav.ontology} />
      {loadedAuthorityIsCurrent && feedback ? (
        <FeedbackBanner
          kind="error"
          message={feedback}
          onDismiss={() => {
            setFeedback(undefined);
          }}
        />
      ) : null}
      <div
        role="tablist"
        aria-label={ko.nav.ontology}
        className="mb-6 flex gap-1 border-b border-line"
      >
        <TabButton
          active={tab === "manager"}
          label={ko.ontology.tabs.manager}
          onClick={() => {
            setTab("manager");
          }}
        />
        <TabButton
          active={tab === "graph"}
          label={ko.ontology.tabs.graph}
          onClick={() => {
            setTab("graph");
          }}
        />
      </div>

      {visibleReadState === "loading" ? (
        <SkeletonTable />
      ) : visibleReadState === "error" ? (
        <PageError
          message={ko.page.loadFailed}
          onRetry={() => {
            void load();
          }}
        />
      ) : tab === "graph" ? (
        <BulkPolicyGateProvider actions={ONTOLOGY_GATE_ACTIONS}>
          <ObjectExplorerScreen
            model={explorerModel}
            onFocusChange={handleGraphFocusChange}
            resolveNodeDescriptor={resolveNodeDescriptor}
          />
        </BulkPolicyGateProvider>
      ) : (
        <BulkPolicyGateProvider actions={ONTOLOGY_GATE_ACTIONS}>
          <OntologyManagerScreen
            registry={registry}
            onCreateType={handleCreateType}
            onCommitRevision={handleCommitRevision}
            resolveInstanceCard={resolveInstanceCard}
          />
        </BulkPolicyGateProvider>
      )}
    </>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 px-4 py-3 text-sm font-semibold transition-colors",
        active
          ? "border-ink text-ink"
          : "border-transparent text-steel hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}
