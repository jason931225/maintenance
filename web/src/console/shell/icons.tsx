/**
 * Console shell icon renderer. Path data lives in `iconPaths.ts` (data-only, so
 * this component file exports only a component). The console owns its icon set —
 * the legacy AppShell's lucide-react components under `components/shell/**` are
 * banned by the purity guard — but these are the same Lucide paths the prototype
 * inlined, kept as raw `d` strings.
 */
import type { CSSProperties } from "react";

import { ICON_PATHS } from "./iconPaths";
import type { IconKey } from "./iconPaths";

export type { IconKey };

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.9,
  style,
}: {
  name: IconKey;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flex: "none", ...style }}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
