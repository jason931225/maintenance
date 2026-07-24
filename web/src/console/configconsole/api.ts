// Phase-C ontology reads for the config console (and the Automate builder's
// field/action registries): thin view-model mappers over the shared typed
// ontology REST layer (src/api/ontology.ts — GET /api/v1/ontology/object-types*
// and GET /api/v1/ontology/instances?type=). Widgets aggregate client-side over
// the returned rows; nothing here fabricates display data (§4-25-⑥).
import type { ConsoleApiClient } from "../../api/client";
import { createGovernanceApproval } from "../../api/governance";
import {
  getInstanceHistory,
  getObjectType,
  listInstances,
  listObjectTypes,
  type InstanceStateWire,
  type ObjectTypeDetailWire,
  type RevisionWire,
} from "../../api/ontology";
import { ApiCallError, executeOntologyAction } from "../../api/ontologyActions";
import { parseDashboardDoc } from "./doc";
import type {
  ConsoleViewRecord,
  ConsoleViewScope,
  DashboardDoc,
  DeployApprovalPending,
  OntChoice,
  OntInstanceRow,
  OntObjectTypeDef,
  OntPropertyDef,
} from "./types";

export const CONSOLE_VIEW_KEY = "console_view";

// Kept only until the server confirms a receipt. A failed transport attempt can
// call saveConsoleView again with the same loaded draft and therefore replay the
// same command rather than append a second revision.
const pendingSaveCommands = new Map<string, string>();

function commandIdFor(key: string): string {
  const prior = pendingSaveCommands.get(key);
  if (prior) return prior;
  const id = globalThis.crypto.randomUUID();
  pendingSaveCommands.set(key, id);
  return id;
}

/** PropertyDefWire.config is schemaless JSON — pull `{choices:[{id,name,color?}]}` defensively. */
function choicesOf(config: unknown): OntChoice[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const raw = (config as { choices?: unknown }).choices;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, name, color } = entry as { id?: unknown; name?: unknown; color?: unknown };
    if (typeof id !== "string" || typeof name !== "string") return [];
    return [{ id, name, ...(typeof color === "string" ? { color } : {}) }];
  });
}

function objectTypeDefOf(detail: ObjectTypeDetailWire): OntObjectTypeDef {
  return {
    id: detail.object_type.id,
    key: detail.object_type.stable_key,
    title: detail.object_type.title,
    properties: detail.properties.map((prop): OntPropertyDef => {
      const choices = choicesOf(prop.config);
      return {
        id: prop.id,
        key: prop.key,
        title: prop.title,
        type: prop.field_type,
        ...(choices.length > 0 ? { config: { choices } } : {}),
      };
    }),
    actions: detail.actions.map((action) => ({
      id: action.id,
      key: action.stable_key,
      title: action.title,
      dispatch: action.dispatch,
    })),
  };
}

/** One instance row for the widget aggregation (choice values stay ids; labels via registry). */
export function instanceRowOf(state: InstanceStateWire, objectType: string): OntInstanceRow {
  const attributes: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(state.revision.attributes)) {
    if (typeof value === "string" || typeof value === "number" || value === null) {
      attributes[key] = value;
    }
  }
  return {
    id: state.instance.id,
    code: state.instance.title,
    objectType,
    lifecycleState: state.instance.lifecycle_state,
    attributes,
  };
}

/** Registry load: list heads, then each type's property/action children. */
export async function fetchOntObjectTypes(
  api: ConsoleApiClient,
): Promise<OntObjectTypeDef[]> {
  const summaries = await listObjectTypes(api);
  const details = await Promise.all(
    summaries.map((summary) => getObjectType(api, summary.stable_key)),
  );
  return details.map(objectTypeDefOf);
}

/** Current-state instances across every registry type (RLS ∧ Cedar server-side). */
export async function fetchOntInstances(
  api: ConsoleApiClient,
  types: readonly OntObjectTypeDef[],
): Promise<OntInstanceRow[]> {
  const pages = await Promise.all(
    types.map(async (type) =>
      (await listInstances(api, type.id)).map((row) => instanceRowOf(row, type.key)),
    ),
  );
  return pages.flat();
}

/** trend widget: one instance's `field` value across its real revision history. */
export async function fetchTrendSeries(
  api: ConsoleApiClient,
  instanceId: string,
  field: string,
): Promise<{ validFrom: string; value: number }[]> {
  const history: RevisionWire[] = await getInstanceHistory(api, instanceId);
  return history
    .slice()
    .sort((a, b) => a.version - b.version)
    .flatMap((revision) => {
      const raw = revision.attributes[field];
      return typeof raw === "number" ? [{ validFrom: revision.valid_from, value: raw }] : [];
    });
}

function consoleViewOf(state: InstanceStateWire): ConsoleViewRecord | null {
  const a = state.revision.attributes;
  const screenKey = typeof a.screen_key === "string" ? a.screen_key : "";
  const scope = a.scope === "team" ? "team" : a.scope === "personal" ? "personal" : null;
  const config = typeof a.config === "string" ? parseDashboardDoc(a.config) : null;
  if (screenKey === "" || scope === null || config === null) return null;
  return { instanceId: state.instance.id, screenKey, config, scope, version: state.revision.version };
}

/** console_view reads for one screen — GET /ontology/instances?type=console_view, RLS-scoped. */
export async function fetchConsoleViews(
  api: ConsoleApiClient,
  screenKey: string,
): Promise<{ objectTypeId: string; personal: ConsoleViewRecord | null; team: ConsoleViewRecord | null }> {
  const detail = await getObjectType(api, CONSOLE_VIEW_KEY);
  const states = await listInstances(api, detail.object_type.id);
  const records = states
    .map(consoleViewOf)
    .filter((row): row is ConsoleViewRecord => row !== null && row.screenKey === screenKey);
  return {
    objectTypeId: detail.object_type.id,
    personal: records.find((row) => row.scope === "personal") ?? null,
    team: records.find((row) => row.scope === "team") ?? null,
  };
}

/**
 * Save a screen layout as a governed console_view instance through the single
 * audited action path. Personal (§3.9.0-①) saves direct; a team save is the
 * caller's concern to route through 팀 배포 (POST /governance/approvals).
 */
export async function saveConsoleView(
  api: ConsoleApiClient,
  objectTypeId: string,
  existing: ConsoleViewRecord | null,
  screenKey: string,
  doc: DashboardDoc,
  scope: ConsoleViewScope,
): Promise<ConsoleViewRecord> {
  const serialized = JSON.stringify(doc);
  const attemptKey = `${existing?.instanceId ?? "new"}:${scope}:${screenKey}:${serialized}`;
  const commandId = commandIdFor(attemptKey);
  try {
    const result = await executeOntologyAction(api, "create", {
      object_type_id: objectTypeId,
      ...(existing ? { instance_id: existing.instanceId } : {}),
      params: { screen_key: screenKey, config: serialized, scope },
      command_id: commandId,
      ...(existing ? { expected_revision: existing.version } : {}),
    });
    pendingSaveCommands.delete(attemptKey);
    return { instanceId: result.instance.instanceId, screenKey, config: doc, scope, version: result.instance.version };
  } catch (error) {
    // A received HTTP response (including CAS 412 / digest 409) is terminal for
    // this attempt. Only an unknown transport failure retains the id for retry.
    if (error instanceof ApiCallError) pendingSaveCommands.delete(attemptKey);
    throw error;
  }
}

/** 팀 배포 — 결재: opens a pending four-eyes approval for the team console_view. */
export async function deployConsoleView(
  api: ConsoleApiClient,
  view: ConsoleViewRecord,
): Promise<DeployApprovalPending> {
  const approval = await createGovernanceApproval(api, {
    request_ref: view.instanceId,
    kind: "console_view.deploy",
    // Binds the deploy approval to this console_view instance.
    target_ref: view.instanceId,
    payload_summary: { screen_key: view.screenKey, version: view.version },
  });
  return { approvalId: approval.id, requestRef: approval.requestRef, createdAt: approval.createdAt };
}
