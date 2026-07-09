// Row -> PinnedObject adapters (UI-M1b).
//
// The migrated screens keep their existing row/card rendering; these small
// mappers turn a real row (overview inbox item, attendance record) into the
// generic pin payload so it can be pinned into a detail panel. Object-specific
// panel renderers arrive in UI-M2a; until then the panel shows this field grid.

import type { ObjectCandidate } from "../../lib/objectCandidates";
import { objectRegistry } from "../../lib/objectRegistry";
import { ko } from "../../i18n/ko";
import { PIN_KINDS, type PinField, type PinKind, type PinnedObject } from "./types";

export interface HubRow {
  code: string;
  kind: PinKind;
  title: string;
  eyebrow: string;
  detail: string;
  dueLabel?: string;
  badge?: string;
  href: string;
  /** Backend id for the live-detail fetch (work order / support ticket) — the
   * snapshot below is the instant skeleton the fetch then enriches. */
  refId?: string;
}

export function hubRowToPin(row: HubRow): PinnedObject {
  const fields: PinField[] = [
    { label: ko.console.workspace.field.kind, value: row.eyebrow },
    { label: ko.console.workspace.field.detail, value: row.detail },
  ];
  if (row.dueLabel) fields.push({ label: ko.console.workspace.field.due, value: row.dueLabel });
  if (row.badge) fields.push({ label: ko.console.workspace.field.status, value: row.badge });
  return { kind: row.kind, code: row.code, title: row.title, fields, href: row.href, refId: row.refId };
}

/**
 * ⌘K palette / chip result -> pinnable object (UI-M2a): pinning it into a
 * ConsoleShell screen mounts a PinPanel that fetches the live detail — for a
 * person that fetch is what records the view-audit. Returns `null` for a kind
 * that isn't pinnable. `refId` carries the backend id so the detail fetch runs.
 */
export function candidateToPin(candidate: ObjectCandidate): PinnedObject | null {
  const { kind } = candidate;
  if (!(PIN_KINDS as readonly string[]).includes(kind)) return null;
  const id = candidate.id ?? candidate.code;
  return {
    kind: kind as PinKind,
    code: candidate.code,
    title: candidate.label,
    fields: [],
    refId: id,
    href: objectRegistry[kind].route({ id, code: candidate.code }),
  };
}

export interface AttendanceRow {
  code: string;
  kindLabel: string;
  occurredLabel: string;
  stateLabel: string;
  note: string;
}

export function attendanceRecordToPin(row: AttendanceRow): PinnedObject {
  return {
    kind: "attendance",
    code: row.code,
    title: row.kindLabel,
    fields: [
      { label: ko.console.workspace.field.occurredAt, value: row.occurredLabel },
      { label: ko.console.workspace.field.stateAfter, value: row.stateLabel },
      { label: ko.console.workspace.field.note, value: row.note },
    ],
  };
}
