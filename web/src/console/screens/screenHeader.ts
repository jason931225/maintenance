// §4-18 shared component reuse: the module-screen header (title + trailing
// actions/status row) was independently redrawn in evidence, policy,
// overview, and the ontology workspace — same shape, drifting in small ways
// (overview even carried a stray `--text-h` token that doesn't exist in
// tokens.css). One definition here; screens compose it instead of
// re-declaring it.
import type { CSSProperties } from "react";

export const screenHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
  flexWrap: "wrap",
};

export const screenTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-h1)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};
