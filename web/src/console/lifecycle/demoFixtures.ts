// Deterministic lifecycle payloads for the dev harness + unit tests, shaped
// exactly like the real BE-LC `ObjectLifecycle` response. Korean transition
// reasons come from `ko` (no hardcoded UI strings), so this ships under
// console/** past the check-ui-strings gate. NOT product data.

import { ko } from "../../i18n/ko";
import type { Lifecycle } from "./types";

const d = ko.console.lifecycle.demo;
const OBJ = "00000000-0000-0000-0000-0000000cae05";

/** Mid-flow: sitting at 승인·게시, two transitions behind it. */
export const stepperFixture: Lifecycle = {
  objectType: "document",
  objectId: OBJ,
  currentState: "approved",
  legalHold: false,
  createdAt: "2026-06-01T09:00:00Z",
  updatedAt: "2026-06-03T11:00:00Z",
  transitions: [
    { fromState: "submitted", toState: "approved", reason: d.approve, actor: undefined, occurredAt: "2026-06-03T11:00:00Z" },
    { fromState: "draft", toState: "submitted", reason: d.submit, actor: undefined, occurredAt: "2026-06-02T10:00:00Z" },
  ],
};

/** Active with a fuller version history. */
export const historyFixture: Lifecycle = {
  objectType: "document",
  objectId: OBJ,
  currentState: "active",
  legalHold: false,
  createdAt: "2026-06-01T09:00:00Z",
  updatedAt: "2026-06-04T09:30:00Z",
  transitions: [
    { fromState: "approved", toState: "active", reason: d.effectuate, actor: undefined, occurredAt: "2026-06-04T09:30:00Z" },
    { fromState: "submitted", toState: "approved", reason: d.approve, actor: undefined, occurredAt: "2026-06-03T11:00:00Z" },
    { fromState: "draft", toState: "submitted", reason: d.submit, actor: undefined, occurredAt: "2026-06-02T10:00:00Z" },
  ],
};

/** Archived under legal hold — the dispose gate is blocked. */
export const disposeBlockedFixture: Lifecycle = {
  objectType: "document",
  objectId: OBJ,
  currentState: "archived",
  legalHold: true,
  retentionUntil: "2030-01-01",
  createdAt: "2026-06-01T09:00:00Z",
  updatedAt: "2026-06-05T14:00:00Z",
  transitions: [
    { fromState: "revised", toState: "archived", reason: d.archive, actor: undefined, occurredAt: "2026-06-05T14:00:00Z" },
    { fromState: "active", toState: "revised", reason: d.revise, actor: undefined, occurredAt: "2026-06-04T16:00:00Z" },
  ],
};
