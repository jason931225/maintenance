import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";

export const CONSOLE_LIST_BODY_CLASS =
  "relative overflow-auto overscroll-contain after:pointer-events-none after:sticky after:bottom-0 after:block after:h-6 after:bg-linear-to-t after:from-console-surface after:to-transparent";

export const CONSOLE_LIST_ROW_CLASS =
  "grid grid-cols-[minmax(7rem,1.2fr)_minmax(0,2fr)_auto] items-center gap-2";

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

  const finish = useCallback(
    (event: PointerEvent) => {
    if (!dragRef.current) return;
      const delta = event.clientX - dragRef.current.startX;
      const nextWidth = clamp(dragRef.current.startWidth + delta, minWidth, maxWidth);
    dragRef.current = null;
      setWidth(nextWidth);
      onCommit?.(nextWidth);
    },
    [maxWidth, minWidth, onCommit],
  );

  const move = useCallback(
    (event: PointerEvent) => {
      if (!dragRef.current) return;
      const delta = event.clientX - dragRef.current.startX;
      setWidth(clamp(dragRef.current.startWidth + delta, minWidth, maxWidth));
    },
    [maxWidth, minWidth],
  );

  useEffect(() => {
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
  }, [finish, move]);

  return {
    width,
    getHandleProps: () => ({
      "aria-orientation": "horizontal" as const,
      className:
        "h-6 w-2 cursor-col-resize rounded bg-console-border hover:bg-console-steel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal",
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        dragRef.current = { startX: event.clientX, startWidth: width };
        if (typeof event.currentTarget.setPointerCapture === "function") {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      },
    }),
  };
}
