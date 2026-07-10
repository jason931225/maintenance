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
import { PolicyGateProvider, type PolicyGate } from "../console/policy";
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

// wire-pending: Phase C — decisions come from /policy/authorize (arch §5c);
// until then the workspace is gated by this local allow-list (deny-by-omission
// for every action not named here).
const ONTOLOGY_GATE_ACTIONS: ReadonlySet<string> = new Set([
  ...Object.values(ONTOLOGY_MANAGER_ACTIONS),
  ...Object.values(OBJECT_EXPLORER_ACTIONS),
]);
const ONTOLOGY_GATE: PolicyGate = {
  can: (action) => ONTOLOGY_GATE_ACTIONS.has(action),
};

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
  const { api } = useAuth();
  const [tab, setTab] = useState<OntologyTab>("manager");
  const [readState, setReadState] = useState<ReadState>("loading");
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [graphs, setGraphs] = useState<TraversalGraphWire[]>([]);
  const [feedback, setFeedback] = useState<string>();

  const load = useCallback(async () => {
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

      // Seed the graph tab with a search-around from the first instance; a
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
    async (instanceId: string): Promise<ObjectCardDescriptor> => {
      const [state, history, neighbors] = await Promise.all([
        getInstance(api, instanceId),
        getInstanceHistory(api, instanceId),
        traverseInstance(api, instanceId, { depth: 1 }),
      ]);
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

  const handleCreateType = useCallback(
    async (title: string) => {
      try {
        await createObjectType(api, {
          // ponytail: time-based stable key — a stable-key input lands with the
          // full schema-authoring pass; the title is the human identity.
          stable_key: `ot_${Date.now().toString(36)}`,
          title: title.trim(),
          backing_kind: "instance",
        });
        await load();
      } catch {
        setFeedback(ko.users.form.saveFailed);
      }
    },
    [api, load],
  );

  const handleCommitRevision = useCallback(
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
        setFeedback(ko.users.form.saveFailed);
        throw error; // keeps the 개정 대기 banner up for retry/철회
      }
      await load();
    },
    [api, entries, load, typeIdByKey],
  );

  const handleGraphFocusChange = useCallback(
    (focusId: string) => {
      void traverseInstance(api, focusId)
        .then((graph) => {
          setGraphs((current) => [...current, graph]);
        })
        .catch(() => undefined); // keep the already-loaded neighborhood
    },
    [api],
  );

  return (
    <>
      <PageHeader title={ko.nav.ontology} />
      {feedback ? (
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

      {readState === "loading" ? (
        <SkeletonTable />
      ) : readState === "error" ? (
        <PageError
          message={ko.page.loadFailed}
          onRetry={() => {
            void load();
          }}
        />
      ) : tab === "graph" ? (
        <PolicyGateProvider gate={ONTOLOGY_GATE}>
          <ObjectExplorerScreen
            model={explorerModel}
            onFocusChange={handleGraphFocusChange}
            resolveNodeDescriptor={resolveNodeDescriptor}
          />
        </PolicyGateProvider>
      ) : (
        <PolicyGateProvider gate={ONTOLOGY_GATE}>
          <OntologyManagerScreen
            registry={registry}
            onCreateType={handleCreateType}
            onCommitRevision={handleCommitRevision}
            resolveInstanceCard={resolveInstanceCard}
          />
        </PolicyGateProvider>
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
