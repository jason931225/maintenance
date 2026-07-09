// Row -> PinnedObject adapters (UI-M1b).
//
// The migrated screens keep their existing row/card rendering; these small
// mappers turn a real row (work-hub inbox item, attendance record) into the
// generic pin payload so it can be pinned into a detail panel. Object-specific
// panel renderers arrive in UI-M2a; until then the panel shows this field grid.

import { ko } from "../../i18n/ko";
import type { PinField, PinKind, PinnedObject } from "./types";

export interface HubRow {
  code: string;
  kind: PinKind;
  title: string;
  eyebrow: string;
  detail: string;
  dueLabel?: string;
  badge?: string;
  href: string;
}

export function hubRowToPin(row: HubRow): PinnedObject {
  const fields: PinField[] = [
    { label: ko.console.workspace.field.kind, value: row.eyebrow },
    { label: ko.console.workspace.field.detail, value: row.detail },
  ];
  if (row.dueLabel) fields.push({ label: ko.console.workspace.field.due, value: row.dueLabel });
  if (row.badge) fields.push({ label: ko.console.workspace.field.status, value: row.badge });
  return { kind: row.kind, code: row.code, title: row.title, fields, href: row.href };
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
