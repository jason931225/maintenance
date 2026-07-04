import { useEffect, useState } from "react";

export const CONSOLE_TOAST_EVENT = "maintenance:console-toast";

export interface ConsoleToastDetail {
  message: string;
  durationMs?: number;
  onUndo?: () => void;
}

export type ConsoleToastState = ConsoleToastDetail;

function isConsoleToastDetail(value: unknown): value is ConsoleToastDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.length > 0
  );
}

export function useConsoleToast(timeoutMs = 5_200) {
  const [toast, setToast] = useState<ConsoleToastState | undefined>();

  useEffect(() => {
    function onToast(event: Event) {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isConsoleToastDetail(detail)) return;
      setToast({
        message: detail.message,
        durationMs: detail.durationMs,
        onUndo: detail.onUndo,
      });
    }

    window.addEventListener(CONSOLE_TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(CONSOLE_TOAST_EVENT, onToast);
    };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => {
      setToast(undefined);
    }, toast.durationMs ?? timeoutMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [timeoutMs, toast]);

  return {
    toast,
    closeToast: () => {
      setToast(undefined);
    },
    undoToast: () => {
      toast?.onUndo?.();
      setToast(undefined);
    },
  };
}
