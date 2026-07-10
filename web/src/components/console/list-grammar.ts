import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";

export const CONSOLE_LIST_BODY_CLASS =
  "relative overflow-auto overscroll-contain after:pointer-events-none after:sticky after:bottom-0 after:block after:h-6 after:bg-linear-to-t after:from-console-surface after:to-transparent";

export const CONSOLE_LIST_ROW_CLASS =
  "grid grid-cols-[minmax(7rem,1.2fr)_minmax(0,2fr)_auto] items-center gap-2";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
  );
}

export function useListNav({
  count,
  onOpen,
}: {
  count: number;
  onOpen?: (index: number) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);

  const move = useCallback(
    (delta: number) => {
      if (count <= 0) return;
      setSelectedIndex((current) => {
        const base = current ?? (delta > 0 ? -1 : 0);
        return (base + delta + count) % count;
      });
    },
    [count],
  );

  useEffect(() => {
    if (selectedIndex === null) return;
    itemRefs.current[selectedIndex]?.focus();
  }, [selectedIndex]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      if (event.key === "j" || event.key === "J" || event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
        return;
      }
      if (event.key === "k" || event.key === "K" || event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
        return;
      }
      if (event.key === "Enter" && selectedIndex !== null) {
        event.preventDefault();
        onOpen?.(selectedIndex);
        return;
      }
      if (event.key === "Escape") {
        setSelectedIndex(null);
      }
    },
    [move, onOpen, selectedIndex],
  );

  return {
    selectedIndex,
    onKeyDown,
    getItemRef:
      (index: number) =>
      (node: HTMLElement | null): void => {
        itemRefs.current[index] = node;
      },
    getItemClassName: (index: number) =>
      cn(
        CONSOLE_LIST_ROW_CLASS,
        "rounded-[7px] px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-console-signal",
        selectedIndex === index && "ring-2 ring-inset ring-console-signal",
      ),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const RESIZE_TICK_PX = 8;

function quantizeToTick(value: number, tick: number, min: number, max: number) {
  return clamp(Math.round(value / tick) * tick, min, max);
}

export function useColumnResize({
  initialWidth,
  minWidth = 112,
  maxWidth = 480,
  onCommit,
}: {
  initialWidth: number;
  minWidth?: number;
  maxWidth?: number;
  onCommit?: (width: number) => void;
}) {
  const [width, setWidth] = useState(initialWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  return {
    width,
    getHandleProps: () => ({
      role: "separator" as const,
      "aria-orientation": "horizontal" as const,
      "aria-valuenow": width,
      "aria-valuemin": minWidth,
      "aria-valuemax": maxWidth,
      tabIndex: 0,
      className:
        "h-6 w-2 cursor-col-resize rounded bg-console-border hover:bg-console-steel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal",
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          const next = quantizeToTick(width + RESIZE_TICK_PX, RESIZE_TICK_PX, minWidth, maxWidth);
          setWidth(next);
          onCommit?.(next);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          const next = quantizeToTick(width - RESIZE_TICK_PX, RESIZE_TICK_PX, minWidth, maxWidth);
          setWidth(next);
          onCommit?.(next);
        }
      },
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        const startX = event.clientX;
        const startWidth = width;
        dragRef.current = { startX, startWidth };
        if (typeof event.currentTarget.setPointerCapture === "function") {
          event.currentTarget.setPointerCapture(event.pointerId);
        }

        const cleanup = () => {
          window.removeEventListener("pointermove", handleMove);
          window.removeEventListener("pointerup", handleUp);
          window.removeEventListener("pointercancel", handleCancel);
        };

        const handleMove = (moveEvent: PointerEvent) => {
          if (!dragRef.current) return;
          const delta = moveEvent.clientX - dragRef.current.startX;
          setWidth(
            quantizeToTick(dragRef.current.startWidth + delta, RESIZE_TICK_PX, minWidth, maxWidth),
          );
        };

        const handleUp = (upEvent: PointerEvent) => {
          if (!dragRef.current) return;
          const delta = upEvent.clientX - dragRef.current.startX;
          const next = quantizeToTick(
            dragRef.current.startWidth + delta,
            RESIZE_TICK_PX,
            minWidth,
            maxWidth,
          );
          dragRef.current = null;
          setWidth(next);
          onCommit?.(next);
          cleanup();
        };

        // ponytail: pointercancel reverts to the pre-drag width rather than
        // committing whatever the last live delta was; upgrade to a
        // resumable-drag model if a real cancel-mid-resize UX need shows up.
        const handleCancel = () => {
          if (!dragRef.current) return;
          setWidth(dragRef.current.startWidth);
          dragRef.current = null;
          cleanup();
        };

        window.addEventListener("pointermove", handleMove);
        window.addEventListener("pointerup", handleUp);
        window.addEventListener("pointercancel", handleCancel);
      },
    }),
  };
}
