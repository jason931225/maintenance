import { useCallback, useEffect, useMemo, useState } from "react";

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

/** One registry entry: the wire detail + its current-state instances. */
interface RegistryEntry {
  detail: ObjectTypeDetailWire;
  instances: InstanceStateWire[];
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
  stats: OntologyWorkspaceStats;
  /** True once a successful read returned an empty registry (honest empty, not error). */
  isEmpty: boolean;
  feedback: string | undefined;
  clearFeedback: () => void;
  reload: () => Promise<void>;
  onCreateType: (title: string) => Promise<void>;
  onCommitRevision: (staged: OntObjectTypeDef) => Promise<void>;
  onGraphFocusChange: (focusId: string) => void;
  resolveInstanceCard: (row: OntInstanceRow) => Promise<ObjectCardDescriptor>;
  resolveNodeDescriptor: (node: ObjectExplorerNode) => Promise<ObjectCardDescriptor>;
}

const EMPTY_MODEL: ObjectExplorerModel = { nodes: [], object_links: [] };

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
): OntologyWorkspace {
  const [readState, setReadState] = useState<OntologyReadState>("loading");
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [graphs, setGraphs] = useState<TraversalGraphWire[]>([]);
  const [feedback, setFeedback] = useState<string>();

  const reload = useCallback(async () => {
    setReadState("loading");
    setFeedback(undefined);
    try {
      const summaries = await listObjectTypes(api);
      const loaded = await Promise.all(
        summaries.map(async (summary) => {
          const [detail, instances] = await Promise.all([
            getObjectType(api, summary.stable_key),
            listInstances(api, summary.id),
          ]);
          return { detail, instances } satisfies RegistryEntry;
        }),
      );
      setEntries(loaded);
      setReadState("idle");

      // Seed the graph with a search-around from the first instance; a
      // traversal failure degrades to the empty graph, not a page error.
      const root = loaded.flatMap((entry) => entry.instances).at(0);
      if (root) {
        try {
          setGraphs([await traverseInstance(api, root.instance.id)]);
        } catch {
          setGraphs([]);
        }
      } else {
        setGraphs([]);
      }
    } catch {
      setReadState("error");
    }
  }, [api]);

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
        objectTypeDefFromDetail(entry.detail, entry.instances, typeKeyById),
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

  const stats = useMemo<OntologyWorkspaceStats>(
    () => ({
      types: entries.length,
      instances: entries.reduce((sum, entry) => sum + entry.instances.length, 0),
      links: explorerModel.object_links.length,
    }),
    [entries, explorerModel],
  );

  const resolveInstanceDescriptor = useCallback(
    async (instanceId: string): Promise<ObjectCardDescriptor> => {
      const [state, history, neighbors] = await Promise.all([
        getInstance(api, instanceId),
        getInstanceHistory(api, instanceId),
        traverseInstance(api, instanceId, { depth: 1 }),
      ]);
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
    },
    [api, entries, linkTitleById],
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
      try {
        await createObjectType(api, {
          // ponytail: time-based stable key — a stable-key input lands with the
          // full schema-authoring pass; the title is the human identity.
          stable_key: `ot_${Date.now().toString(36)}`,
          title: title.trim(),
          backing_kind: "instance",
        });
        await reload();
      } catch {
        setFeedback(copy.saveFailed);
      }
    },
    [api, reload, copy.saveFailed],
  );

  const onCommitRevision = useCallback(
    async (staged: OntObjectTypeDef) => {
      const entry = entries.find(
        (candidate) => candidate.detail.object_type.id === staged.id,
      );
      if (!entry) return;
      try {
        await stageObjectTypeRevision(
          api,
          entry.detail.object_type.stable_key,
          stagedRevisionDraft(entry.detail, staged, typeIdByKey),
        );
      } catch (error) {
        setFeedback(copy.saveFailed);
        throw error; // keeps the 개정 대기 banner up for retry/철회
      }
      await reload();
    },
    [api, entries, reload, typeIdByKey, copy.saveFailed],
  );

  const onGraphFocusChange = useCallback(
    (focusId: string) => {
      void traverseInstance(api, focusId)
        .then((graph) => {
          setGraphs((current) => [...current, graph]);
        })
        .catch(() => undefined); // keep the already-loaded neighbourhood
    },
    [api],
  );

  const clearFeedback = useCallback(() => {
    setFeedback(undefined);
  }, []);

  return {
    readState,
    registry,
    explorerModel,
    stats,
    isEmpty: readState === "idle" && entries.length === 0,
    feedback,
    clearFeedback,
    reload,
    onCreateType,
    onCommitRevision,
    onGraphFocusChange,
    resolveInstanceCard,
    resolveNodeDescriptor,
  };
}
