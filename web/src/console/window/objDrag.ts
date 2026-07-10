import type { DragEvent } from "react";

import { objectCodeRegex, objectRefTokenRegex } from "../ontology/codeGrammar";

// §4-20/§4-23 objDrag: makes any object chip/row/code label a drag source, and
// any input/task/relation zone a drop target, exchanging a single reference
// token. The token shape is the compose grammar's object token (bare CODE-NNN)
// wrapped in "[CODE title]" so a drop into a plain text input round-trips
// through the existing parser (renderMessageParts still extracts the bare code
// via \b). The code grammar is ONE shared dynamic source (console/ontology/
// codeGrammar.ts) driven by the object-type registry — messengerModel and
// composeModel consume the same source, so a new type's prefix works here too
// with no code edit.

/** Typed mime carrying the structured {code,title} payload. */
export const OBJ_REF_MIME = "application/x-mnt-objref";

export interface ObjectRef {
  code: string;
  title: string;
}

/** The text/plain reference token, e.g. `[WO-2643 4호기 유압 점검]`. */
export function objectRefToken(code: string, title: string): string {
  return `[${code} ${title}]`;
}

/** Write both payloads (typed mime + text/plain token) onto a dataTransfer. */
export function writeObjectRef(dataTransfer: DataTransfer, ref: ObjectRef): void {
  dataTransfer.setData(OBJ_REF_MIME, JSON.stringify(ref));
  dataTransfer.setData("text/plain", objectRefToken(ref.code, ref.title));
}

/**
 * Drag-source props to spread onto any object chip/row/code label. `code` is
 * exposed as `data-obj-code` so a PBAC gate can read it off the DOM if needed;
 * callers already hold the code and should only render this on objects the user
 * may reference.
 */
export function objDrag(code: string, title: string) {
  return {
    draggable: true as const,
    "data-obj-code": code,
    onDragStart: (event: DragEvent) => {
      writeObjectRef(event.dataTransfer, { code, title });
      event.dataTransfer.effectAllowed = "copyLink";
    },
  };
}

/** Parse a token out of raw text — bracketed `[CODE title]` first, else a bare code. */
export function parseObjectRefText(text: string): ObjectRef | null {
  if (!text) return null;
  const bracket = objectRefTokenRegex().exec(text);
  if (bracket) return { code: bracket[1], title: bracket[2].trim() };
  const bare = objectCodeRegex().exec(text);
  if (bare) return { code: bare[0], title: bare[0] };
  return null;
}

/** Read a reference: typed mime first, then the text/plain token fallback. */
export function parseObjectRef(dataTransfer: Pick<DataTransfer, "getData">): ObjectRef | null {
  const typed = dataTransfer.getData(OBJ_REF_MIME);
  if (typed) {
    try {
      const parsed = JSON.parse(typed) as Partial<ObjectRef>;
      if (typeof parsed.code === "string" && objectCodeRegex().test(parsed.code)) {
        return {
          code: parsed.code,
          title: typeof parsed.title === "string" ? parsed.title : parsed.code,
        };
      }
    } catch {
      // malformed payload — fall through to the text/plain token
    }
  }
  return parseObjectRefText(dataTransfer.getData("text/plain"));
}

/**
 * Drop-target props for compose inputs, task rows, and relation drop zones.
 * `onRef` receives the parsed reference (its `.code` is what a caller feeds to
 * `hasPolicy` before acting); `canAccept` optionally gates the drop by code so
 * a PBAC-denied object is a no-op.
 */
export function useObjectDrop(options: {
  onRef: (ref: ObjectRef) => void;
  canAccept?: (code: string) => boolean;
}) {
  const { onRef, canAccept } = options;
  return {
    onDragOver: (event: DragEvent) => {
      const { types } = event.dataTransfer;
      if (types.includes(OBJ_REF_MIME) || types.includes("text/plain")) {
        event.preventDefault();
        // dropEffect only accepts a single effect ("copy"/"link"/…); "copyLink"
        // is an effectAllowed value. The source sets effectAllowed=copyLink.
        event.dataTransfer.dropEffect = "copy";
      }
    },
    onDrop: (event: DragEvent) => {
      const ref = parseObjectRef(event.dataTransfer);
      if (!ref) return;
      if (canAccept && !canAccept(ref.code)) return;
      event.preventDefault();
      onRef(ref);
    },
  };
}
