// Serial-wire input: {screenKey → component} + the ko namespace it needs
// merged. screenKey matches nav.ts's `docs` item (nav label 문서·기록물). Do
// not mount this directly in ConsoleShell.tsx from this lane — the wire step
// owns that.
import { EvidenceScreenBody } from "./EvidenceScreenBody";
import { documentsKoManifest } from "./koManifest";

export const screenKey = "docs";
export const Component = EvidenceScreenBody;
// Merge as ko.console.documents (a new namespace — console.evidence already
// exists for the narrower 증거-only surface this screen's 증거 tab reuses).
export const koManifest = documentsKoManifest;
