import type { ReactNode, RefObject } from "react";

import { computeSectionLayout, gridAreaOf } from "../../../features/workspace/layout";
import type { Panel } from "../../../features/workspace/types";
import { ko } from "../../../i18n/ko";
import { PinPanel } from "./PinPanel";
import { SnapZones } from "./SnapZones";

/**
 * 2x2 quadrant grid. The page body <section> takes the largest free rectangle;
 * pinned panels take quadrant/half areas (true split — content reflows). Float
 * and minimized panels are handled elsewhere (FloatWindow / Tray).
 */
export function QuadrantContainer({
  workspaceRef,
  panels,
  onMinimize,
  onPopout,
  onClose,
  children,
}: {
  workspaceRef: RefObject<HTMLElement | null>;
  panels: Panel[];
  onMinimize: (id: string) => void;
  onPopout: (id: string) => void;
  onClose: (id: string) => void;
  children: ReactNode;
}) {
  const pinned = panels.filter((p) => p.mode === "pinned");
  const layout = computeSectionLayout(pinned.map((p) => p.area));

  return (
    <div
      ref={workspaceRef as RefObject<HTMLDivElement>}
      tabIndex={-1}
      className="relative grid h-full min-h-0 grid-cols-2 grid-rows-2 gap-0.5 bg-console-canvas focus:outline-none"
    >
      {/* The section is always mounted (kept in the DOM even when panels fill
          the grid) so the migrated screens inside it survive — display:none
          rather than unmounting. */}
      <section
        aria-label={ko.console.workspace.bodyLabel}
        className="min-h-0 overflow-auto bg-console-canvas focus:outline-none"
        style={{
          gridArea: layout.sectionArea ?? undefined,
          display: layout.sectionArea ? undefined : "none",
        }}
      >
        {children}
      </section>

      {pinned.map((panel) => (
        <div key={panel.id} className="min-h-0" style={{ gridArea: gridAreaOf(panel.area) }}>
          <PinPanel
            object={panel.object}
            onMinimize={() => {
              onMinimize(panel.id);
            }}
            onPopout={() => {
              onPopout(panel.id);
            }}
            onClose={() => {
              onClose(panel.id);
            }}
          />
        </div>
      ))}

      {layout.placeholders.map((quad) => (
        <div
          key={quad}
          className="flex items-center justify-center rounded-[9px] border border-dashed border-console-border text-[11px] text-console-faint"
          style={{ gridArea: layout.quadGrid[quad] }}
        >
          {ko.console.workspace.placeholder}
        </div>
      ))}

      <SnapZones />
    </div>
  );
}
