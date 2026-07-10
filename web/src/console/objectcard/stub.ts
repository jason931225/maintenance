// wire-pending: Phase C — this stub stands in for GET /ontology/instances/{id}
// (arch §2). Its shape is the real payload shape, so wiring = replacing this
// factory with the fetch, not rewriting the card.
import { ko } from "../../i18n/ko";
import type { ObjectCardDescriptor } from "./types";

const S = ko.console.objectcard.samples;

export function createObjectCardStub(
  overrides: Partial<ObjectCardDescriptor> = {},
): ObjectCardDescriptor {
  return {
    id: "wo-2643",
    code: "WO-2643",
    title: S.title,
    objectType: {
      key: "work_order",
      title: S.typeTitle,
      id: "00000000-0000-4000-8000-00000000ce0c",
    },
    lifecycleState: "active",
    schemaVersion: 2,
    properties: [
      { key: "priority", title: S.props.priority, type: "choice", value: S.values.priority },
      { key: "assignee", title: S.props.assignee, type: "user", value: S.values.assignee },
      { key: "due", title: S.props.due, type: "date", value: "2026-07-12" },
      // property-policy field: hidden unless the subject may read it (deny-by-omission).
      { key: "cost", title: S.props.cost, type: "currency", value: S.values.cost, inPropertyPolicy: true },
    ],
    relations: [
      {
        linkId: "lnk-1",
        linkType: S.links.equipment,
        direction: "to",
        cardinality: "many_many",
        code: "EQ-118",
        title: S.linkTargets.equipment,
      },
      {
        linkId: "lnk-2",
        linkType: S.links.approval,
        direction: "from",
        cardinality: "one_one",
        code: "AP-3121",
        title: S.linkTargets.approval,
      },
    ],
    lifecycle: [
      { state: "draft", reached: true, current: false },
      { state: "active", reached: true, current: true },
      { state: "archived", reached: false, current: false },
      { state: "disposed", reached: false, current: false },
    ],
    history: [
      { version: 2, at: "2026-07-08 14:20", actor: S.actors.requester, hashVerified: true, action: "reassign" },
      { version: 1, at: "2026-07-07 09:03", actor: S.actors.requester, hashVerified: true, action: "create" },
    ],
    approvals: [
      { id: "apr-1", kind: S.approvalKind, requestedBy: S.actors.requester, approver: S.actors.approver, decision: "approved", at: "2026-07-08" },
    ],
    acting: [
      { id: "wf-1", label: "wf-wo-review", kind: "automation" },
      { id: "pol-1", label: "pbac-wo-edit", kind: "policy" },
    ],
    actions: [
      { key: "reassign", title: S.actions.reassign },
      { key: "close", title: S.actions.close, requiresReason: true },
      { key: "dispose", title: S.actions.dispose, tone: "danger", requiresReason: true },
    ],
    ...overrides,
  };
}
