import type { CSSProperties } from "react";

export const rootStyle: CSSProperties = {
  minHeight: "100%",
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-6)",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

export const headerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
};

export const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-h1)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

export const surfaceStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(200px, 260px) minmax(300px, 380px) minmax(520px, 1fr)",
  minHeight: 620,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
  overflow: "hidden",
};

export const paneStyle: CSSProperties = {
  minWidth: 0,
  display: "grid",
  alignContent: "start",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
};

export const separatorPaneStyle: CSSProperties = {
  ...paneStyle,
  borderRight: "1px solid var(--border-soft)",
};

export const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
};

export const mutedTextStyle: CSSProperties = {
  margin: 0,
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
  lineHeight: "var(--lh-base)",
};

export const faintTextStyle: CSSProperties = {
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-body)",
};

export const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

export const stackStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
};

export const tightStackStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
};

export const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
};

export const buttonBaseStyle: CSSProperties = {
  minHeight: "calc(var(--sp-6) * 2)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

export const primaryButtonStyle: CSSProperties = {
  ...buttonBaseStyle,
  border: "1px solid var(--signal)",
  background: "var(--signal)",
};

export const ghostButtonStyle: CSSProperties = {
  ...buttonBaseStyle,
  minHeight: "calc(var(--sp-5) * 2)",
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-xs)",
};

export const dangerButtonStyle: CSSProperties = {
  ...buttonBaseStyle,
  border: "1px solid var(--danger-bd)",
  background: "var(--danger-bg)",
  color: "var(--danger-tx)",
};

export const inputStyle: CSSProperties = {
  minHeight: "calc(var(--sp-6) * 2)",
  width: "100%",
  minWidth: 0,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
};

export const textAreaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 120,
  padding: "var(--sp-3)",
  resize: "vertical",
  lineHeight: "var(--lh-base)",
};

export const labelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

export const statusRowStyle: CSSProperties = {
  border: "1px dashed var(--border)",
  borderRadius: "var(--radius)",
  padding: "var(--sp-5)",
  color: "var(--steel)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
  textAlign: "center",
};

export const alertStyle: CSSProperties = {
  border: "1px solid var(--danger-bd)",
  borderRadius: "var(--radius)",
  background: "var(--danger-bg)",
  color: "var(--danger-tx)",
  padding: "var(--sp-3)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
};

export const successStyle: CSSProperties = {
  border: "1px solid var(--ok-bd)",
  borderRadius: "var(--radius)",
  background: "var(--ok-bg)",
  color: "var(--ok-tx)",
  padding: "var(--sp-3)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
};

export const hiddenFileInputStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
