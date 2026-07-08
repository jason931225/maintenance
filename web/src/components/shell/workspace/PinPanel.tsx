import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { PinKind, PinnedObject } from "../../../features/workspace/types";
import { ko } from "../../../i18n/ko";
import { cn } from "../../../lib/utils";
import { consoleIcons } from "../../console/icons";
import { Chip } from "../../console/primitives";

const MinimizeIcon = consoleIcons.minz;
const PopoutIcon = consoleIcons.share;
const CloseIcon = consoleIcons.close;

const KIND_TONE: Record<PinKind, "info" | "accent" | "warn" | "ok" | "purple"> = {
  workOrder: "info",
  support: "warn",
  approval: "accent",
  dailyPlan: "purple",
  conversation: "ok",
  attendance: "ok",
  person: "purple",
};

function chipPrefix(code: string): string {
  return code.includes("-") ? code.split("-")[0] : code.slice(0, 2);
}

export interface PinPanelProps {
  object: PinnedObject;
  floating?: boolean;
  onMinimize: () => void;
  onPopout?: () => void;
  onClose: () => void;
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * Shared pin-panel chrome: header (kind chip + mono ref + title + minimize /
 * popout / close) over a GENERIC field-grid body. Object-specific renderers
 * arrive in UI-M2a; this is the fallback body for every kind today.
 */
export function PinPanel({
  object,
  floating = false,
  onMinimize,
  onPopout,
  onClose,
  onHeaderPointerDown,
}: PinPanelProps) {
  return (
    <section
      aria-label={`${object.code} ${object.title}`}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-[9px] border border-console-border bg-console-surface shadow-console",
        floating && "h-full shadow-console-pop",
      )}
    >
      <header
        onPointerDown={onHeaderPointerDown}
        className={cn(
          "flex min-h-[42px] items-center gap-2 border-b border-console-border-soft px-3 py-2",
          onHeaderPointerDown && "cursor-grab touch-none select-none active:cursor-grabbing",
        )}
      >
        <Chip tone={KIND_TONE[object.kind]} className="px-1.5 font-mono">
          {chipPrefix(object.code)}
        </Chip>
        <span className="font-mono text-[11px] font-extrabold text-console-ink">{object.code}</span>
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-extrabold text-console-ink">
          {object.title}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          <PanelButton label={ko.console.workspace.panel.minimize} onClick={onMinimize}>
            <MinimizeIcon aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
          </PanelButton>
          {onPopout ? (
            <PanelButton label={ko.console.workspace.panel.popout} onClick={onPopout}>
              <PopoutIcon aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
            </PanelButton>
          ) : null}
          <PanelButton label={ko.console.workspace.panel.close} onClick={onClose}>
            <CloseIcon aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
          </PanelButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <dl className="grid gap-2">
          {object.fields.map((field) => (
            <div key={field.label} className="grid grid-cols-[6rem_1fr] gap-2">
              <dt className="text-[11px] font-extrabold uppercase text-console-faint">
                {field.label}
              </dt>
              <dd className="min-w-0 break-words text-[12px] text-console-ink">{field.value}</dd>
            </div>
          ))}
        </dl>
        {object.href ? (
          <a
            href={object.href}
            className="mt-3 inline-flex text-[12px] font-bold text-console-teal hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
          >
            {ko.console.workspace.panel.open}
          </a>
        ) : null}
      </div>
    </section>
  );
}

function PanelButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      // Stop the header's drag from starting when a control is pressed.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-console-steel hover:bg-console-muted hover:text-console-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
    >
      {children}
    </button>
  );
}
