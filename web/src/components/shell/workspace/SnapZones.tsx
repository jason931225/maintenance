import type { CSSProperties } from "react";

import { useWorkspaceStore } from "../../../features/workspace/store";
import type { SnapZone } from "../../../features/workspace/types";
import { ko } from "../../../i18n/ko";

// Where the dashed preview sits for each zone, as % of the workspace rect.
const ZONE_BOX: Record<SnapZone, CSSProperties> = {
  tl: { left: 0, top: 0, width: "50%", height: "50%" },
  tr: { left: "50%", top: 0, width: "50%", height: "50%" },
  bl: { left: 0, top: "50%", width: "50%", height: "50%" },
  br: { left: "50%", top: "50%", width: "50%", height: "50%" },
  left: { left: 0, top: 0, width: "50%", height: "100%" },
  right: { left: "50%", top: 0, width: "50%", height: "100%" },
  top: { left: 0, top: 0, width: "100%", height: "50%" },
  bottom: { left: 0, top: "50%", width: "100%", height: "50%" },
  center: { left: 0, top: 0, width: "100%", height: "100%" },
};

function zoneLabel(zone: SnapZone): string {
  return ko.console.workspace.zone[zone];
}

/**
 * Dashed drop-target preview shown during a float-panel header drag. Reads the
 * transient snapPreview/draggingId from the store (never persisted). Purely
 * decorative — the drop itself is handled by FloatWindow's pointer logic.
 */
export function SnapZones() {
  const draggingId = useWorkspaceStore((s) => s.draggingId);
  const snapPreview = useWorkspaceStore((s) => s.snapPreview);
  if (!draggingId || !snapPreview) return null;
  const isCenter = snapPreview === "center";
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-30">
      <div
        className={
          isCenter
            ? "absolute rounded-[9px] border-2 border-dashed border-console-faint/60"
            : "absolute rounded-[9px] border-2 border-dashed border-console-signal bg-console-signal/10"
        }
        style={ZONE_BOX[snapPreview]}
      >
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[6px] bg-console-ink px-2 py-1 text-[11px] font-extrabold text-console-surface">
          {zoneLabel(snapPreview)}
        </span>
      </div>
    </div>
  );
}
