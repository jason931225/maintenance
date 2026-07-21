// Test-support fixtures for the ontology workspace bodies. Minimal but
// schema-valid wire payloads (one type with a property/link/action/analytic,
// one instance, a 2-node traversal) so the manager panels and the graph both
// have something real to render.
import type {
  InstanceStateWire,
  ObjectTypeDetailWire,
  ObjectTypeSummaryWire,
  TraversalGraphWire,
} from "../api/ontology";

const TYPE_ID = "11111111-1111-1111-1111-111111111111";
const LINK_TARGET_ID = "22222222-2222-2222-2222-222222222222";
const INSTANCE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NEIGHBOUR_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const LINK_TYPE_ID = "33333333-3333-3333-3333-333333333333";

export const summaryFixture: ObjectTypeSummaryWire = {
  id: TYPE_ID,
  stable_key: "contract",
  title: "계약",
  backing_kind: "instance",
  schema_version: 1,
  lifecycle_state: "published",
  key_write_revision: 1,
  key_write_etag: '"ont-object-type-key:11111111111111111111111111111111:r1"',
};

export const detailFixture: ObjectTypeDetailWire = {
  object_type: summaryFixture,
  title_property_key: "title",
  backing_table: null,
  primary_key_property: null,
  properties: [
    {
      id: "p1",
      key: "amount",
      title: "월 계약금",
      field_type: "money",
      config: null,
      backing_column: null,
      required: true,
      in_property_policy: false,
    },
  ],
  links: [
    {
      id: LINK_TYPE_ID,
      stable_key: "supplies",
      title: "공급",
      reverse_title: null,
      to_object_type_id: LINK_TARGET_ID,
      cardinality: "one_many",
      traversable: true,
    },
  ],
  actions: [
    {
      id: "a1",
      stable_key: "revise",
      title: "갱신 검토 기안",
      params_schema: null,
      edits: null,
      submission_criteria: null,
      side_effects: null,
      dispatch: "instance_revision",
      dispatch_target: null,
      control_points: null,
    },
  ],
  analytics: [
    {
      id: "an1",
      key: "margin",
      title: "마진",
      formula: "1 - 인건비율 - 간접비",
      result_type: null,
    },
  ],
};

export const instanceFixture: InstanceStateWire = {
  instance: {
    id: INSTANCE_ID,
    object_type_id: TYPE_ID,
    title: "NK보안 경비용역",
    current_revision_id: null,
    lifecycle_state: "active",
  },
  revision: {
    id: "r1",
    instance_id: INSTANCE_ID,
    version: 1,
    attributes: {},
    valid_from: "2025-07-01T00:00:00Z",
    valid_to: null,
    action_type_id: null,
    actor: null,
    reason: null,
    prev_hash: "0".repeat(64),
    row_hash: "1".repeat(64),
  },
};

export const graphFixture: TraversalGraphWire = {
  root: INSTANCE_ID,
  nodes: [
    {
      instance_id: INSTANCE_ID,
      object_type_id: TYPE_ID,
      title: "NK보안 경비용역",
      lifecycle_state: "active",
      depth: 0,
    },
    {
      instance_id: NEIGHBOUR_ID,
      object_type_id: TYPE_ID,
      title: "경비 근무 장구 44세트",
      lifecycle_state: "active",
      depth: 1,
    },
  ],
  edges: [
    {
      id: "e1",
      link_type_id: LINK_TYPE_ID,
      from_instance_id: INSTANCE_ID,
      to_instance_id: NEIGHBOUR_ID,
    },
  ],
};
