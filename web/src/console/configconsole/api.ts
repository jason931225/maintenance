// Phase-C ontology reads for the config console (and the Automate builder's
// field/action registries): thin view-model mappers over the shared typed
// ontology REST layer (src/api/ontology.ts — GET /api/v1/ontology/object-types*
// and GET /api/v1/ontology/instances?type=). Widgets aggregate client-side over
// the returned rows; nothing here fabricates display data (§4-25-⑥).
import type { ConsoleApiClient } from "../../api/client";
import {
  getObjectType,
  listInstances,
  listObjectTypes,
  type InstanceStateWire,
  type ObjectTypeDetailWire,
} from "../../api/ontology";
import type { OntChoice, OntInstanceRow, OntObjectTypeDef, OntPropertyDef } from "./types";

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
      (await listInstances(api, type.id)).map((state) => instanceRowOf(state, type.key)),
    ),
  );
  return pages.flat();
}
