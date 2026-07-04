import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONSOLE_TOAST_EVENT, useConsoleToast } from "./useConsoleToast";

function dispatchToast(detail: { message: string; durationMs?: number; onUndo?: () => void }) {
  act(() => {
    window.dispatchEvent(new CustomEvent(CONSOLE_TOAST_EVENT, { detail }));
  });
}

describe("useConsoleToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses after the default 5.2s window", () => {
    const { result } = renderHook(() => useConsoleToast());
    dispatchToast({ message: "AP-3124 상신 완료" });
    expect(result.current.toast?.message).toBe("AP-3124 상신 완료");

    act(() => {
      vi.advanceTimersByTime(5_199);
    });
    expect(result.current.toast).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toast).toBeUndefined();
  });

  it("wins the undo race when undo fires just before the timer elapses", () => {
    const undo = vi.fn();
    const { result } = renderHook(() => useConsoleToast());
    dispatchToast({ message: "삭제됨", onUndo: undo });

    act(() => {
      vi.advanceTimersByTime(5_199);
    });
    act(() => {
      result.current.undoToast();
    });
    expect(undo).toHaveBeenCalledOnce();
    expect(result.current.toast).toBeUndefined();

    // The pending timeout is cleared by the toast-cleared effect cleanup, so
    // advancing past the original deadline must not clear a second (absent)
    // toast or otherwise throw.
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(result.current.toast).toBeUndefined();
    expect(undo).toHaveBeenCalledOnce();
  });

  it("closeToast cancels the pending auto-dismiss without invoking undo", () => {
    const undo = vi.fn();
    const { result } = renderHook(() => useConsoleToast());
    dispatchToast({ message: "저장됨", onUndo: undo });

    act(() => {
      result.current.closeToast();
    });
    expect(result.current.toast).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(undo).not.toHaveBeenCalled();
  });

  it("honors a per-toast durationMs override", () => {
    const { result } = renderHook(() => useConsoleToast());
    dispatchToast({ message: "빠른 알림", durationMs: 1_000 });

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current.toast).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toast).toBeUndefined();
  });
});
