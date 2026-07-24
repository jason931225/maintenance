import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  createObjectType,
  getInstance,
  getInstanceHistory,
  getObjectType,
  getObjectTypeActing,
  listInstances,
  listObjectTypes,
  stageObjectTypeRevision,
  traverseInstance,
  type ActingRuleWire,
  type InstanceStateWire,
  type ObjectTypeDetailWire,
  type TraversalGraphWire,
} from "../../../api/ontology";
import type { ConsoleApiClient } from "../../../api/client";
import {
  OBJECT_EXPLORER_ACTIONS,
  ontologyExplorerModel,
  type ObjectExplorerModel,
  type ObjectExplorerNode,
} from "../../explore";
import type { ObjectCardDescriptor } from "../../objectcard";
import {
  ONTOLOGY_MANAGER_ACTIONS,
  objectCardDescriptorFrom,
  objectTypeDefFromDetail,
  stagedRevisionDraft,
  type OntInstanceRow,
  type OntObjectTypeDef,
} from "../../ontology";
import {
  useOntologyRevisionCommitQueue,
  type OntologyRevisionPersistContext,
} from "../../ontology/useOntologyRevisionCommitQueue";

// ponytail: this is the load/shape core proven in pages/OntologyPage.tsx,
// lifted verbatim so both console screen bodies (온톨로지 매니저 · 객체 탐색)
// share one wiring. OntologyPage is the legacy AppRouter surface and stays
// untouched; when it retires this becomes the sole owner.

export type OntologyReadState = "loading" | "idle" | "error";

/** Deny-by-omission action set resolved once at mount via POST /policy/authorize/bulk. */
export const ONTOLOGY_GATE_ACTIONS: readonly string[] = [
  ...Object.values(ONTOLOGY_MANAGER_ACTIONS),
  ...Object.values(OBJECT_EXPLORER_ACTIONS),
];

/** One registry entry: the wire detail + its current-state instances + acting rules. */
interface RegistryEntry {
  detail: ObjectTypeDetailWire;
  instances: InstanceStateWire[];
  /** Automations + policies bound to the type (자동화 subtab). */
  acting: ActingRuleWire[] | undefined;
}

export interface OntologyPartialReadFailure {
  kind: "acting" | "traversal";
  /** Object-type id for acting reads; root instance id for traversal reads. */
  scopeId: string;
  /** Human-readable scope retained for a specific, non-empty failure notice. */
  scopeLabel: string;
}

type PartialRetryOutcome =
  | { outcome: "acting"; failure: OntologyPartialReadFailure; acting: ActingRuleWire[] }
  | { outcome: "traversal"; failure: OntologyPartialReadFailure; graph: TraversalGraphWire }
  | { outcome: "failed"; failure: OntologyPartialReadFailure };

interface LoadedWorkspaceState {
  authorityKey: string | undefined;
  entries: RegistryEntry[];
  graphs: TraversalGraphWire[];
  partialFailures: OntologyPartialReadFailure[];
}

interface AuthorityReadState {
  authorityKey: string | undefined;
  value: OntologyReadState;
}

export interface OntologyWorkspaceStats {
  /** Registry object-type heads. */
  types: number;
  /** Current-state instances across every loaded type. */
  instances: number;
  /** Relation edges in the loaded traversal neighbourhood. */
  links: number;
}

export interface OntologyWorkspace {
  readState: OntologyReadState;
  registry: OntObjectTypeDef[];
  explorerModel: ObjectExplorerModel;
  /** Object-type version ids whose backing_kind is projected (S23: not get/traverse-able → 조회 전용). */
  projectedTypeIds: Set<string>;
  stats: OntologyWorkspaceStats;
  /** True once a successful read returned an empty registry (honest empty, not error). */
  isEmpty: boolean;
  /** Supplementary reads that failed while the independently loaded workspace remains usable. */
  partialFailures: OntologyPartialReadFailure[];
  feedback: string | undefined;
  clearFeedback: () => void;
  reload: () => Promise<void>;
  retryPartialFailures: () => Promise<void>;
  onCreateType: (title: string) => Promise<void>;
  onCommitRevision: (staged: OntObjectTypeDef) => Promise<void>;
  onGraphFocusChange: (focusId: string) => void;
  resolveInstanceCard: (row: OntInstanceRow) => Promise<ObjectCardDescriptor | undefined>;
  resolveNodeDescriptor: (node: ObjectExplorerNode) => Promise<ObjectCardDescriptor | undefined>;
}

const EMPTY_MODEL: ObjectExplorerModel = { nodes: [], object_links: [] };
const EMPTY_ENTRIES: RegistryEntry[] = [];
const EMPTY_GRAPHS: TraversalGraphWire[] = [];
const EMPTY_PARTIAL_FAILURES: OntologyPartialReadFailure[] = [];
const MISSING_WRITE_AUTHORITY = new Error(
  "Ontology write requires explicit provider/session authority",
);

/**
 * Ontology workspace wiring for the carbon-copy console. Reads the tenant
 * registry (GET /ontology/object-types + per-type detail/instances), seeds the
 * graph from a first-instance traversal, and exposes the create/stage mutators
 * plus the instance-card resolver used by both the manager and the explorer.
 *
 * `saveFailedMessage` / `loadFailed` are passed in so the hook stays free of a
 * ko import (the caller owns copy).
 */
export function useOntologyWorkspace(
  api: ConsoleApiClient,
  copy: { saveFailed: string },
  authorityKey: string | undefined,
): OntologyWorkspace {
  const [readState, setReadState] = useState<AuthorityReadState>({
    authorityKey: undefined,
    value: "loading",
  });
  const [loadedState, setLoadedState] = useState<LoadedWorkspaceState>({
    authorityKey: undefined,
    entries: EMPTY_ENTRIES,
    graphs: EMPTY_GRAPHS,
    partialFailures: EMPTY_PARTIAL_FAILURES,
  });
  const [feedback, setFeedback] = useState<string>();
  const authorityScope = useMemo(
    () => ({ key: authorityKey }),
    [authorityKey],
  );
  // Retain only the committed authority scope. A monotonic epoch invalidates
  // retained callbacks without strongly retaining every retired tenant scope.
  const currentAuthorityScopeRef = useRef<object | null>(null);
  const lifetimeEpochRef = useRef(0);
  const readRequestRef = useRef(0);
  const loadedAuthorityIsCurrent = loadedState.authorityKey === authorityKey;
  const entries = loadedAuthorityIsCurrent ? loadedState.entries : EMPTY_ENTRIES;
  const graphs = loadedAuthorityIsCurrent ? loadedState.graphs : EMPTY_GRAPHS;
  const partialFailures = loadedAuthorityIsCurrent
    ? loadedState.partialFailures
    : EMPTY_PARTIAL_FAILURES;
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
  }, [api, authorityScope]);

  const isAuthorityCurrent = useCallback(
    (scope: object, epoch: number) =>
      currentAuthorityScopeRef.current === scope &&
      lifetimeEpochRef.current === epoch,
    [],
  );

  const reload = useCallback(async (coordinatorGuard: () => boolean = () => true) => {
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
        summaries.map(async (summary): Promise<{
          entry: RegistryEntry;
          failure: OntologyPartialReadFailure | undefined;
        }> => {
          const [detail, instances] = await Promise.all([
            getObjectType(api, summary.stable_key),
            listInstances(api, summary.id),
          ]);
          try {
            const acting = await getObjectTypeActing(api, summary.stable_key);
            return {
              entry: { detail, instances, acting } satisfies RegistryEntry,
              failure: undefined,
            };
          } catch {
            return {
              entry: { detail, instances, acting: undefined } satisfies RegistryEntry,
              failure: {
                kind: "acting",
                scopeId: summary.id,
                scopeLabel: summary.title,
              },
            };
          }
        }),
      );
      if (!isCurrent()) return;

      const entries = loaded.map(({ entry }) => entry);
      const nextPartialFailures = loaded.flatMap(({ failure }) =>
        failure ? [failure] : [],
      );

      // A failed governed traversal is explicitly degraded, never represented
      // as an authoritative successful empty graph.
      const root = entries.flatMap((entry) => entry.instances).at(0);
      let nextGraphs: TraversalGraphWire[] = [];
      if (root) {
        try {
          nextGraphs = [await traverseInstance(api, root.instance.id)];
        } catch {
          nextPartialFailures.push({
            kind: "traversal",
            scopeId: root.instance.id,
            scopeLabel: root.instance.title,
          });
        }
      }
      if (!isCurrent()) return;
      setLoadedState({
        authorityKey,
        entries,
        graphs: nextGraphs,
        partialFailures: nextPartialFailures,
      });
      setReadState({ authorityKey, value: "idle" });
    } catch {
      if (!isCurrent()) return;
      setReadState({ authorityKey, value: "error" });
    }
  }, [api, authorityKey, authorityScope, isAuthorityCurrent]);

  const retryPartialFailures = useCallback(async () => {
    const lifetimeEpoch = lifetimeEpochRef.current;
    if (
      !isAuthorityCurrent(authorityScope, lifetimeEpoch) ||
      loadedState.authorityKey !== authorityKey ||
      loadedState.partialFailures.length === 0
    ) return;

    const requestEpoch = readRequestRef.current + 1;
    readRequestRef.current = requestEpoch;
    const isCurrent = () =>
      isAuthorityCurrent(authorityScope, lifetimeEpoch) &&
      readRequestRef.current === requestEpoch;
    const snapshot = loadedState;
    const retriedFailureKeys = new Set(
      snapshot.partialFailures.map((failure) => `${failure.kind}:${failure.scopeId}`),
    );
    const outcomes = await Promise.all(
      snapshot.partialFailures.map(async (failure): Promise<PartialRetryOutcome> => {
        try {
          if (failure.kind === "acting") {
            const entry = snapshot.entries.find(
              (candidate) => candidate.detail.object_type.id === failure.scopeId,
            );
            if (!entry) return { outcome: "failed", failure };
            return {
              outcome: "acting",
              failure,
              acting: await getObjectTypeActing(
                api,
                entry.detail.object_type.stable_key,
              ),
            };
          }
          return {
            outcome: "traversal",
            failure,
            graph: await traverseInstance(api, failure.scopeId),
          };
        } catch {
          return { outcome: "failed", failure };
        }
      }),
    );
    if (!isCurrent()) return;

    const resolvedActing = new Map<string, ActingRuleWire[]>();
    const resolvedGraphs: TraversalGraphWire[] = [];
    const remainingFailures: OntologyPartialReadFailure[] = [];
    outcomes.forEach((outcome) => {
      if (outcome.outcome === "acting") {
        resolvedActing.set(outcome.failure.scopeId, outcome.acting);
      } else if (outcome.outcome === "traversal") {
        resolvedGraphs.push(outcome.graph);
      } else {
        remainingFailures.push(outcome.failure);
      }
    });
    setLoadedState((current) => {
      if (current.authorityKey !== authorityKey || !isCurrent()) return current;
      const resolvedRoots = new Set(resolvedGraphs.map((graph) => graph.root));
      return {
        ...current,
        entries: current.entries.map((entry) => {
          const acting = resolvedActing.get(entry.detail.object_type.id);
          return acting === undefined ? entry : { ...entry, acting };
        }),
        graphs: [
          ...current.graphs.filter((graph) => !resolvedRoots.has(graph.root)),
          ...resolvedGraphs,
        ],
        partialFailures: [
          ...current.partialFailures.filter(
            (failure) =>
              !retriedFailureKeys.has(`${failure.kind}:${failure.scopeId}`),
          ),
          ...remainingFailures,
        ],
      };
    });
  }, [api, authorityKey, authorityScope, isAuthorityCurrent, loadedState]);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => {
      window.clearTimeout(task);
    };
  }, [reload]);

  const typeKeyById = useMemo(
    () =>
      new Map(
        entries.map((entry) => [entry.detail.object_type.id, entry.detail.object_type.stable_key]),
      ),
    [entries],
  );
  const typeIdByKey = useMemo(
    () =>
      new Map(
        entries.map((entry) => [entry.detail.object_type.stable_key, entry.detail.object_type.id]),
      ),
    [entries],
  );
  const typeTitleById = useMemo(
    () =>
      new Map(
        entries.map((entry) => [entry.detail.object_type.id, entry.detail.object_type.title]),
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
        objectTypeDefFromDetail(
          entry.detail,
          entry.instances,
          typeKeyById,
          entry.acting ?? [],
        ),
      ),
    [entries, typeKeyById],
  );

  const explorerModel = useMemo(
    () =>
      entries.length === 0
        ? EMPTY_MODEL
        : ontologyExplorerModel({
            graphs,
            types: entries.map((entry) => entry.detail.object_type),
            linkTitleById,
            typeTitleById,
            instanceCountByTypeId: new Map(
              entries.map((entry) => [entry.detail.object_type.id, entry.instances.length]),
            ),
          }),
    [entries, graphs, linkTitleById, typeTitleById],
  );

  const projectedTypeIds = useMemo(
    () =>
      new Set(
        entries
          .filter((entry) => entry.detail.object_type.backing_kind === "projected")
          .map((entry) => entry.detail.object_type.id),
      ),
    [entries],
  );

  const stats = useMemo<OntologyWorkspaceStats>(
    () => ({
      types: entries.length,
      instances: entries.reduce((sum, entry) => sum + entry.instances.length, 0),
      links: explorerModel.object_links.length,
    }),
    [entries, explorerModel],
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
          (candidate) => candidate.detail.object_type.id === state.instance.object_type_id,
        );
        return objectCardDescriptorFrom({
          state,
          history,
          neighbors,
          detail: entry?.detail,
          linkTitleById,
        });
      } catch (error) {
        // Retirement is cancellation, not read failure: consumers must not run
        // an A-derived degraded fallback after B is current.
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

  const onCreateType = useCallback(
    async (title: string) => {
      const lifetimeEpoch = lifetimeEpochRef.current;
      if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
      if (!authorityKey) {
        setFeedback(copy.saveFailed);
        throw MISSING_WRITE_AUTHORITY;
      }
      try {
        await createObjectType(api, {
          // ponytail: time-based stable key — a stable-key input lands with the
          // full schema-authoring pass; the title is the human identity.
          stable_key: `ot_${Date.now().toString(36)}`,
          title: title.trim(),
          backing_kind: "instance",
        });
        if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
        await reload();
      } catch {
        if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
        setFeedback(copy.saveFailed);
      }
    },
    [api, authorityKey, authorityScope, isAuthorityCurrent, reload, copy.saveFailed],
  );

  const persistRevision = useCallback(
    async (
      staged: OntObjectTypeDef,
      { expected, signal }: OntologyRevisionPersistContext,
    ) => {
      const lifetimeEpoch = lifetimeEpochRef.current;
      if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
      if (!authorityKey) throw MISSING_WRITE_AUTHORITY;
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
        setFeedback(copy.saveFailed);
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
      copy.saveFailed,
    ],
  );

  const enqueueRevision = useOntologyRevisionCommitQueue({
    authorityKey,
    persist: persistRevision,
    reload,
  });
  const onCommitRevision = useCallback(
    (staged: OntObjectTypeDef): Promise<void> => {
      const lifetimeEpoch = lifetimeEpochRef.current;
      if (!authorityKey) return Promise.reject(MISSING_WRITE_AUTHORITY);
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

  const onGraphFocusChange = useCallback(
    (focusId: string) => {
      const lifetimeEpoch = lifetimeEpochRef.current;
      if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
      const focusLabel = entries
        .flatMap((entry) => entry.instances)
        .find((state) => state.instance.id === focusId)?.instance.title ?? focusId;
      void traverseInstance(api, focusId)
        .then((graph) => {
          if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
          setLoadedState((current) =>
            current.authorityKey === authorityKey
              ? {
                  ...current,
                  graphs: [
                    ...current.graphs.filter((candidate) => candidate.root !== graph.root),
                    graph,
                  ],
                  partialFailures: current.partialFailures.filter(
                    (failure) =>
                      failure.kind !== "traversal" || failure.scopeId !== focusId,
                  ),
                }
              : current,
          );
        })
        .catch(() => {
          if (!isAuthorityCurrent(authorityScope, lifetimeEpoch)) return;
          setLoadedState((current) => {
            if (current.authorityKey !== authorityKey) return current;
            if (current.partialFailures.some(
              (failure) =>
                failure.kind === "traversal" && failure.scopeId === focusId,
            )) return current;
            return {
              ...current,
              partialFailures: [
                ...current.partialFailures,
                { kind: "traversal", scopeId: focusId, scopeLabel: focusLabel },
              ],
            };
          });
        }); // keep the already-loaded neighbourhood, but report degradation
    },
    [api, authorityKey, authorityScope, entries, isAuthorityCurrent],
  );

  const clearFeedback = useCallback(() => {
    setFeedback(undefined);
  }, []);

  return {
    readState: visibleReadState,
    registry,
    explorerModel,
    projectedTypeIds,
    stats,
    isEmpty: visibleReadState === "idle" && entries.length === 0,
    partialFailures,
    feedback: loadedAuthorityIsCurrent ? feedback : undefined,
    clearFeedback,
    reload,
    retryPartialFailures,
    onCreateType,
    onCommitRevision,
    onGraphFocusChange,
    resolveInstanceCard,
    resolveNodeDescriptor,
  };
}
