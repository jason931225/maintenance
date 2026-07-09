/**
 * Console theme mode. `system` follows the OS via the tokens.css
 * `@media (prefers-color-scheme: dark)` block; `light`/`dark` force it via a
 * data attribute on the `.console` root. The cycle mirrors the prototype's
 * theme button: system → light → dark → system.
 *
 * ponytail: mode is component-local, not persisted — per-user layout/theme
 * persistence is P0.2's `/api/v1/me/workspace` slice, not shell chrome.
 */
export type ThemeMode = "system" | "light" | "dark";

export function nextTheme(mode: ThemeMode): ThemeMode {
  return mode === "system" ? "light" : mode === "light" ? "dark" : "system";
}

/** Attribute value for the `.console` root (literal className stays purity-safe). */
export function themeAttribute(mode: ThemeMode): ThemeMode {
  return mode;
}
