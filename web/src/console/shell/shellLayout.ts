/**
 * The console chrome has four responsive contracts. Keep the widths here so
 * the rendered shell and geometry/browser tests cannot silently diverge.
 */
export interface ShellLayout {
  sidebar: number;
  rail: number | "min(320px, 86vw)";
  compact: boolean;
  mobile: boolean;
}

export function resolveShellLayout(viewportWidth: number): ShellLayout {
  if (viewportWidth < 768) {
    return { sidebar: 244, rail: "min(320px, 86vw)", compact: true, mobile: true };
  }
  if (viewportWidth < 1280) {
    return { sidebar: 62, rail: 54, compact: true, mobile: false };
  }
  return {
    sidebar: 236,
    rail: viewportWidth < 1560 ? 300 : 336,
    compact: false,
    mobile: false,
  };
}

/** Full-view communication routes replace the compact rail without resetting it. */
export function isCommunicationScreen(screen: string): boolean {
  return ["messenger", "mail", "notif", "board", "directory"].includes(screen);
}
