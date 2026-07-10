import { describe, expect, it } from "vitest";

import {
  buildApprComposerCandidates,
  buildObjectLinkRequests,
  buildStartWorkflowRunRequest,
  deriveArchiveVisibility,
  deriveCompletionResult,
  mapSubmittableDefinition,
  validateComposeDraft,
  type ApprComposeDraft,
  type ApprSubmittableDefinition,
} from "./composeModel";

const baseDefinition: ApprSubmittableDefinition = {
  id: "11111111-1111-4111-8111-111111111111",
  display_name: "휴가 기안",
  workflow_key: "leave.adjustment",
  object_type: "approval_run",
  active_version: 7,
  definition: {
    reason_options: ["연차", "출장"],
    required_target_kinds: ["work_order"],
    optional_target_kinds: ["equipment"],
    attachment_policy: "evidence_required",
  },
  approval_line: [
    { node_id: "author", label: "기안", actor_id: "author-1", actor_label: "김기안", state: "approved" },
    { node_id: "lead", label: "팀장", actor_id: "approver-1", actor_label: "박승인", state: "current" },
  ],
};

function draft(overrides: Partial<ApprComposeDraft> = {}): ApprComposeDraft {
  const template = mapSubmittableDefinition(baseDefinition);
  return {
    definitionId: template.definitionId,
    definitionVersion: template.definitionVersion,
    title: "휴가 조정 요청",
    reason: "연차",
    body: "WO-2643 대상 휴가 조정",
    targets: [
      {
        kind: "work_order",
        id: "22222222-2222-4222-8222-222222222222",
        code: "WO-2643",
        label: "WO-2643 유압 호스",
        policyAction: "object_link_read",
      },
    ],
    evidence: [{ id: "ev-1", label: "연차 증빙" }],
    previewLine: template.previewLine,
    validation: {},
    ...overrides,
  };
}

describe("appr compose model", () => {
  it("maps the submittable-definitions catalog without inventing local gallery data", () => {
    const template = mapSubmittableDefinition(baseDefinition);

    expect(template.definitionId).toBe(baseDefinition.id);
    expect(template.definitionVersion).toBe(7);
    expect(template.label).toBe("휴가 기안");
    expect(template.reasonOptions).toEqual(["연차", "출장"]);
    expect(template.requiredTargetKinds).toEqual(["work_order"]);
    expect(template.optionalTargetKinds).toEqual(["equipment"]);
    expect(template.attachmentPolicy).toBe("evidence_required");
    expect(template.previewLine.map((node) => node.actorLabel)).toEqual(["김기안", "박승인"]);
  });

  it("blocks submit on missing required fields and self-approval preview before any API call", () => {
    const template = mapSubmittableDefinition({
      ...baseDefinition,
      approval_line: [
        { node_id: "self", label: "본인", actor_id: "author-1", actor_label: "김기안", state: "current" },
      ],
    });
    const result = validateComposeDraft(
      draft({ title: "", reason: null, targets: [], evidence: [], previewLine: template.previewLine }),
      template,
      { currentUserId: "author-1" },
    );

    expect(result.valid).toBe(false);
    expect(result.validation).toMatchObject({
      title: "required",
      reason: "required",
      targets: "required",
      evidence: "required",
      sod: "self_approval",
    });
  });

  it("builds a workflow-run request with no client-generated AP code", () => {
    const request = buildStartWorkflowRunRequest(draft(), {
      idempotencyKey: "idem-123",
      correlationId: "corr-123",
    });

    expect(request).toMatchObject({
      definition_id: baseDefinition.id,
      definition_version: 7,
      trigger_type: "MANUAL",
      idempotency_key: "idem-123",
      correlation_id: "corr-123",
      object_type: "work_order",
      object_id: "22222222-2222-4222-8222-222222222222",
    });
    expect(request.input_payload).toMatchObject({
      title: "휴가 조정 요청",
      reason: "연차",
      body: "WO-2643 대상 휴가 조정",
      target_codes: ["WO-2643"],
    });
    expect(JSON.stringify(request)).not.toContain("AP-");
  });

  it("persists object links only after the backend returns an approval run id", () => {
    const links = buildObjectLinkRequests(
      { runId: "33333333-3333-4333-8333-333333333333" },
      draft().targets,
    );

    expect(links).toEqual([
      {
        src_kind: "approval_run",
        src_id: "33333333-3333-4333-8333-333333333333",
        dst_kind: "work_order",
        dst_id: "22222222-2222-4222-8222-222222222222",
        link_type: "approval_target",
      },
    ]);
  });

  it("keeps the token composer on mention/channel/bare-code grammar and drops the old bang object trigger", () => {
    const sources = {
      members: [{ id: "u1", label: "김성호" }],
      channels: [{ id: "c1", label: "운영" }],
      objectCodes: ["AP-3122", "WO-2643"],
    };

    expect(buildApprComposerCandidates("@김", 2, sources)).toEqual([
      { kind: "mention", id: "u1", label: "김성호", insertText: "@김성호" },
    ]);
    expect(buildApprComposerCandidates("#운", 2, sources)).toEqual([
      { kind: "channel", id: "c1", label: "운영", insertText: "#운영" },
    ]);
    expect(buildApprComposerCandidates("AP-3", 4, sources)).toEqual([
      { kind: "object", label: "AP-3122", insertText: "AP-3122" },
    ]);
    expect(buildApprComposerCandidates("!AP-3", 5, sources)).toEqual([]);
  });

  it("derives finalization, archive, and compensating post-rejection state from backend responses", () => {
    expect(
      deriveCompletionResult({
        task: { id: "task-1", run_id: "run-1", status: "COMPLETED", decision_payload: { mode: "author" } },
        run: { id: "run-1", status: "SUCCEEDED" },
        archive_ref: { code: "AP-3122", id: "rec-1" },
      }),
    ).toEqual({ mode: "author", runId: "run-1", status: "SUCCEEDED", archive: "visible", archiveCode: "AP-3122" });

    expect(deriveArchiveVisibility({ run: { id: "run-1", status: "SUCCEEDED" } })).toBe("blocked_records_archive");

    expect(
      deriveCompletionResult({
        compensation: {
          id: "44444444-4444-4444-8444-444444444444",
          original_run_id: "run-1",
          reason: "법정 사유",
          created_by: "auditor-1",
        },
        notifications: [
          { id: "notif-1", channel: "badge", recipient_id: "approver-1", status: "queued" },
          { id: "notif-2", channel: "push", recipient_id: "author-1", status: "queued" },
        ],
        run: { id: "run-1", status: "SUCCEEDED" },
      }),
    ).toEqual({
      mode: "post_rejection",
      runId: "run-1",
      status: "SUCCEEDED",
      compensationId: "44444444-4444-4444-8444-444444444444",
      notificationCount: 2,
    });
  });
});
