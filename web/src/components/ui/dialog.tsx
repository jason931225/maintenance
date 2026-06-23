import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Card } from "./card";

/** Selector for the elements a focus trap may move focus to. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export interface DialogProps {
  /** Whether the dialog is mounted/visible. */
  open: boolean;
  /** Fired on Escape, scrim click, or the close affordance. */
  onClose: () => void;
  /**
   * Accessible name. Provide `titleId` instead when the title is rendered
   * inside `children` (then the dialog is labelled by that element).
   */
  label?: string;
  /** Id of the element inside `children` that titles the dialog. */
  titleId?: string;
  /** Id of the element inside `children` that describes the dialog. */
  describedById?: string;
  /**
   * Focus this element on open instead of the first focusable descendant.
   * Falls back to the first focusable element when absent.
   */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** When false, a scrim click does not close (e.g. a busy mutation). */
  closeOnScrimClick?: boolean;
  /** Layout variant: a centered modal or an edge-anchored slide-over. */
  variant?: "modal" | "drawer";
  /** Extra classes for the dialog surface (the Card). */
  className?: string;
  children: ReactNode;
}

/**
 * Accessible modal primitive. Renders through a React portal to `document.body`
 * with a scrim, `role="dialog"` + `aria-modal`, Escape-to-close, a focus trap
 * (Tab/Shift+Tab cycle within), initial-focus management, return-focus to the
 * trigger on close, and a body-scroll lock while open. Generalizes the
 * hand-rolled `fixed inset-0 role=dialog` overlays into one robust shell so
 * keyboard and screen-reader users are properly confined to the dialog.
 */
export function Dialog({
  open,
  onClose,
  label,
  titleId,
  describedById,
  initialFocusRef,
  closeOnScrimClick = true,
  variant = "modal",
  className,
  children,
}: DialogProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  // The element focused before the dialog opened, restored on close so focus
  // returns to the trigger (WCAG 2.4.3 focus order).
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Latest onClose without re-running the open effect on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Lock body scroll while the modal is open; restore the prior value.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move initial focus into the dialog (a given ref, else the first
    // focusable descendant, else the surface itself).
    const surface = surfaceRef.current;
    const focusTarget =
      initialFocusRef?.current ??
      (surface ? focusableWithin(surface)[0] : null) ??
      surface;
    focusTarget?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !surfaceRef.current) return;
      const focusable = focusableWithin(surfaceRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        surfaceRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      // Cycle focus within the dialog at the boundaries.
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (
        active instanceof HTMLElement &&
        !surfaceRef.current.contains(active)
      ) {
        // Focus escaped the dialog (e.g. a programmatic blur); pull it back.
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      // Return focus to the trigger that opened the dialog.
      returnFocusRef.current?.focus();
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  const overlayClass =
    variant === "drawer"
      ? "fixed inset-0 z-40 flex justify-end bg-ink/40"
      : "fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4";

  const surfaceClass =
    variant === "drawer"
      ? cn(
          "h-full w-full max-w-md overflow-y-auto rounded-none border-y-0 border-r-0",
          className,
        )
      : cn("w-full max-w-md", className);

  return createPortal(
    <div
      className={overlayClass}
      onMouseDown={(event) => {
        // Only a click that starts AND ends on the scrim closes; this avoids a
        // drag that began inside the dialog closing on release outside.
        if (
          closeOnScrimClick &&
          event.target === event.currentTarget
        ) {
          onClose();
        }
      }}
    >
      <Card
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-label={titleId ? undefined : label}
        aria-labelledby={titleId}
        aria-describedby={describedById}
        tabIndex={-1}
        className={cn("grid gap-4 outline-none", surfaceClass)}
        onMouseDown={(event) => {
          // Clicks inside the surface must not bubble to the scrim handler.
          event.stopPropagation();
        }}
      >
        {children}
      </Card>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  /** Whether the confirm dialog is open. */
  open: boolean;
  /** Dialog title (the accessible name). */
  title: string;
  /** Body copy explaining the consequence of confirming. */
  message: ReactNode;
  /** Optional secondary line (e.g. an amber/red warning). */
  warning?: ReactNode;
  /** Confirm button label. */
  confirmLabel: string;
  /** Cancel button label. Defaults to the shared `ko.common.cancel`. */
  cancelLabel?: string;
  /** Label shown on the confirm button while `busy`. */
  busyLabel?: string;
  /** Destructive actions get a red confirm button and a red warning tone. */
  destructive?: boolean;
  /** Disables both buttons and shows `busyLabel` during the mutation. */
  busy?: boolean;
  /** Optional inline error surfaced above the actions. */
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation modal built on {@link Dialog}. Replaces `window.confirm` and the
 * bespoke confirm overlays: a title, message, optional warning/error, a cancel
 * and a confirm button (red when `destructive`), and a `busy` state that locks
 * both buttons during the mutation. Initial focus lands on Cancel so a stray
 * Enter does not fire a destructive action.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  warning,
  confirmLabel,
  cancelLabel,
  busyLabel,
  destructive = false,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // While busy, a scrim click / Escape must not abandon the in-flight mutation.
  const handleClose = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      titleId={titleId}
      describedById={messageId}
      initialFocusRef={cancelRef}
      closeOnScrimClick={!busy}
    >
      <div className="grid gap-1">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        <p id={messageId} className="text-sm text-steel">
          {message}
        </p>
        {warning ? (
          <p
            className={cn(
              "text-sm font-medium",
              destructive ? "text-red-700" : "text-amber-800",
            )}
          >
            {warning}
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          ref={cancelRef}
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel ?? ko.common.cancel}
        </Button>
        <Button
          type="button"
          variant={destructive ? "destructive" : "default"}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? busyLabel ?? confirmLabel : confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
