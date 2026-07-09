import type { ObjectKind } from "./objectRegistry";

/**
 * Native drag-and-drop payload for console objects (UI-M2a): dragging an object
 * row/chip into a token-grammar composer inserts a resolved reference chip. A
 * private MIME type keeps this distinct from text/file drags, so a stray text
 * selection never masquerades as an object; a `text/plain` mirror is set too so
 * dropping onto a non-console target still pastes the code.
 */
export const OBJECT_DND_MIME = "application/x-oyatie-object";

export interface DraggedObject {
  kind: ObjectKind;
  /** Issued code for coded kinds (e.g. "WO-20260612-001"); the user id for `person`. */
  code: string;
  label: string;
  /** Backend row id (UUID) for coded kinds, so a dropped chip can route/pin the
   * real object. Absent for `person` (its `code` is the id). */
  id?: string;
}

export function setDraggedObject(transfer: DataTransfer, object: DraggedObject): void {
  transfer.setData(OBJECT_DND_MIME, JSON.stringify(object));
  transfer.setData("text/plain", object.code);
  transfer.effectAllowed = "copy";
}

export function readDraggedObject(transfer: DataTransfer): DraggedObject | null {
  const raw = transfer.getData(OBJECT_DND_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DraggedObject>;
    if (
      typeof parsed.code === "string" &&
      parsed.code.length > 0 &&
      typeof parsed.kind === "string" &&
      typeof parsed.label === "string"
    ) {
      return {
        kind: parsed.kind,
        code: parsed.code,
        label: parsed.label,
        id: typeof parsed.id === "string" ? parsed.id : undefined,
      };
    }
  } catch {
    // Malformed payload — treat as "no object dragged", never throw into a drop handler.
  }
  return null;
}

/**
 * The token a dropped object inserts (DESIGN §4.7-7): a person becomes an
 * `@`-mention, any coded object becomes a `!CODE` code-link (an explicit
 * reference to an issued code — no notification, unlike `@`).
 */
export function tokenForDraggedObject(object: DraggedObject): string {
  return object.kind === "person" ? `@${object.code}` : `!${object.code}`;
}
