import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ERROR_DISMISS_MS,
  SUCCESS_DISMISS_MS,
  useAutoDismiss,
  useFeedback,
} from "./useAutoDismiss";

describe("useAutoDismiss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls clear once the timeout elapses for a truthy value", () => {
    const clear = vi.fn();
    renderHook(() => {
      useAutoDismiss("hello", clear, 1000);
    });
    expect(clear).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("never fires for an empty/nullish value or a non-positive timeout", () => {
    const clear = vi.fn();
    renderHook(() => {
      useAutoDismiss(undefined, clear, 1000);
    });
    const clearZero = vi.fn();
    renderHook(() => {
      useAutoDismiss("hello", clearZero, 0);
    });
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(clear).not.toHaveBeenCalled();
    expect(clearZero).not.toHaveBeenCalled();
  });

  it("restarts the timer when the value changes", () => {
    const clear = vi.fn();
    const { rerender } = renderHook(
      ({ value }: { value: string }) => {
        useAutoDismiss(value, clear, 1000);
      },
      { initialProps: { value: "first" } },
    );
    act(() => {
      vi.advanceTimersByTime(600);
    });
    rerender({ value: "second" });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // The first timer was cancelled by the value change; only ~600ms into the
    // second window, so nothing has fired yet.
    expect(clear).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("useFeedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-clears a success message after the success window", () => {
    const { result } = renderHook(() => useFeedback());
    act(() => {
      result.current.showFeedback("saved");
    });
    expect(result.current.feedback).toBe("saved");
    act(() => {
      vi.advanceTimersByTime(SUCCESS_DISMISS_MS);
    });
    expect(result.current.feedback).toBeUndefined();
  });

  it("keeps an error message for the longer error window and clears the prior success", () => {
    const { result } = renderHook(() => useFeedback());
    act(() => {
      result.current.showFeedback("saved");
      result.current.showError("boom");
    });
    // A new error supersedes the lingering success immediately.
    expect(result.current.feedback).toBeUndefined();
    expect(result.current.error).toBe("boom");
    act(() => {
      vi.advanceTimersByTime(SUCCESS_DISMISS_MS);
    });
    // The error outlives the success window.
    expect(result.current.error).toBe("boom");
    act(() => {
      vi.advanceTimersByTime(ERROR_DISMISS_MS - SUCCESS_DISMISS_MS);
    });
    expect(result.current.error).toBeUndefined();
  });
});
