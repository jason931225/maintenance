import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { zoneFromPoint, zoneToArea } from "../../../features/workspace/layout";
import { FLOAT_GRID_PX } from "../../../features/workspace/reducer";
import { useWorkspaceStore } from "../../../features/workspace/store";
import { DEFAULT_FLOAT_RECT, type FloatRect, type Panel, type PanelArea } from "../../../features/workspace/types";
import { PinPanel } from "./PinPanel";

// Bottom band (px) that counts as "over the tray" — dropping a float here
// minimizes it instead of repositioning / snapping.
export const TRAY_DROP_BAND_PX = 72;

function snap(value: number): number {
  return Math.round(value / FLOAT_GRID_PX) * FLOAT_GRID_PX;
}

export function FloatWindow({
  panel,
  workspaceRef,
  onSnap,
  onMove,
  onMinimize,
  onClose,
}: {
  panel: Panel;
  workspaceRef: RefObject<HTMLElement | null>;
  onSnap: (area: PanelArea) => void;
  onMove: (rect: FloatRect) => void;
  onMinimize: () => void;
  onClose: () => void;
}) {
  const rect = panel.float ?? DEFAULT_FLOAT_RECT;
  const [live, setLive] = useState<FloatRect | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  // Active drag's listener teardown, so an unmount mid-drag (e.g. the panel is
  // closed from elsewhere) removes the window listeners — otherwise a late
  // pointerup would fire onSnap and RESURRECT the closed panel.
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  const setSnapPreview = useWorkspaceStore((s) => s.setSnapPreview);
  const setDragging = useWorkspaceStore((s) => s.setDragging);

  const current = live ?? rect;

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origX: current.x,
      origY: current.y,
    };
    setLive(current);
    setDragging(panel.id);

    const previewZone = (clientX: number, clientY: number) => {
      const bounds = workspaceRef.current?.getBoundingClientRect();
      if (!bounds || clientY >= window.innerHeight - TRAY_DROP_BAND_PX) {
        setSnapPreview(null);
        return;
      }
      setSnapPreview(zoneFromPoint(clientX, clientY, bounds));
    };

    const handleMove = (moveEvent: PointerEvent) => {
      if (!dragRef.current) return;
      const { startX, startY, origX, origY } = dragRef.current;
      setLive({
        x: Math.max(0, snap(origX + moveEvent.clientX - startX)),
        y: Math.max(0, snap(origY + moveEvent.clientY - startY)),
        w: current.w,
        h: current.h,
      });
      previewZone(moveEvent.clientX, moveEvent.clientY);
    };

    const handleUp = (upEvent: PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      cleanup();
      setLive(null);
      setSnapPreview(null);
      setDragging(null);
      if (!drag) return;

      if (upEvent.clientY >= window.innerHeight - TRAY_DROP_BAND_PX) {
        onMinimize();
        return;
      }
      const bounds = workspaceRef.current?.getBoundingClientRect();
      const zone = bounds ? zoneFromPoint(upEvent.clientX, upEvent.clientY, bounds) : "center";
      const area = zoneToArea(zone);
      if (area) {
        onSnap(area);
        return;
      }
      onMove({
        x: Math.max(0, snap(drag.origX + upEvent.clientX - drag.startX)),
        y: Math.max(0, snap(drag.origY + upEvent.clientY - drag.startY)),
        w: current.w,
        h: current.h,
      });
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
      cleanupRef.current = null;
    };

    const handleCancel = () => {
      dragRef.current = null;
      setLive(null);
      setSnapPreview(null);
      setDragging(null);
      cleanup();
    };

    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
  };

  return (
    <div
      className="console-motion-pop fixed z-40"
      style={{ left: current.x, top: current.y, width: current.w, height: current.h }}
    >
      <PinPanel
        object={panel.object}
        floating
        onMinimize={onMinimize}
        onClose={onClose}
        onHeaderPointerDown={onHeaderPointerDown}
      />
    </div>
  );
}
