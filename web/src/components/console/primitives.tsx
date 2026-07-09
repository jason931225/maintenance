import type * as React from "react";

import { ko } from "../../i18n/ko";
import { objectRegistry, type ObjectKind } from "../../lib/objectRegistry";
import { cn } from "../../lib/utils";
import { consoleIcons, type ConsoleIconName } from "./icons";

export type Tone = "neutral" | "accent" | "danger" | "warn" | "ok" | "info" | "purple";
type Status = Exclude<Tone, "neutral">;

const toneClasses: Record<Tone, string> = {
  neutral: "border-console-border bg-console-muted text-console-steel",
  accent: "border-console-accent-bd bg-console-accent-bg text-console-accent-tx",
  danger: "border-console-danger-bd bg-console-danger-bg text-console-danger-tx",
  warn: "border-console-warn-bd bg-console-warn-bg text-console-warn-tx",
  ok: "border-console-ok-bd bg-console-ok-bg text-console-ok-tx",
  info: "border-console-info-bd bg-console-info-bg text-console-info-tx",
  purple: "border-console-purple-bd bg-console-purple-bg text-console-purple-tx",
};

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  icon?: ConsoleIconName;
}

export function Chip({ tone = "neutral", icon, className, children, ...props }: ChipProps) {
  const Icon = icon ? consoleIcons[icon] : null;
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1 rounded-[6px] border px-2 py-0.5 text-[11px] font-extrabold leading-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal focus-visible:ring-offset-1 focus-visible:ring-offset-console-surface",
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      {Icon ? (
        <Icon
          aria-hidden="true"
          data-testid={`console-icon-${icon as ConsoleIconName}`}
          className="h-3.5 w-3.5 shrink-0"
          strokeWidth={2}
        />
      ) : null}
      {children}
    </span>
  );
}

export interface StatusChipProps extends ChipProps {
  status: Status;
}

export function StatusChip({ status, ...props }: StatusChipProps) {
  return <Chip tone={status} {...props} />;
}

export function MonoRef({
  value,
  className,
  ...props
}: { value: string } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("font-mono text-[11px] font-extrabold text-console-ink", className)}
      {...props}
    >
      {value}
    </span>
  );
}

/** Kept as an alias so existing imports of `ObjectChipKind` keep working —
 * the registry's `ObjectKind` (`lib/objectRegistry.ts`) is now the single
 * source of truth for which kinds exist, their chip tone, and their icon
 * (no second tone map to drift out of sync with it). */
export type ObjectChipKind = ObjectKind;

export function ObjectChip({
  kind,
  code,
  label,
  onOpen,
}: {
  kind: ObjectChipKind;
  code: string;
  label: string;
  onOpen?: (code: string) => void;
}) {
  const prefix = code.includes("-") ? code.split("-")[0] : code.slice(0, 2);
  return (
    <button
      type="button"
      aria-label={`${code} ${label}`}
      className={cn(
        "inline-flex min-h-7 items-center gap-1.5 rounded-[7px] border border-console-border bg-console-surface px-2 text-[11px] font-bold text-console-ink shadow-console",
        "hover:border-console-steel hover:bg-console-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal focus-visible:ring-offset-1 focus-visible:ring-offset-console-surface",
      )}
      onClick={() => onOpen?.(code)}
    >
      <Chip
        tone={objectRegistry[kind].chipTone}
        icon={objectRegistry[kind].icon}
        className="px-1.5 font-mono"
        aria-hidden="true"
      >
        {prefix}
      </Chip>
      <MonoRef value={code} />
      <span className="text-console-steel">{label}</span>
    </button>
  );
}

export interface StatBarItem {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}

export function StatBar({ items }: { items: StatBarItem[] }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2" role="list">
      {items.map((item, index) => (
        <li
          key={`${String(index)}:${item.label}:${item.value}`}
          className={cn(
            "min-h-14 rounded-[8px] border bg-console-surface px-3 py-2 shadow-console",
            toneClasses[item.tone ?? "neutral"],
          )}
        >
          <div className="text-[10px] font-extrabold uppercase text-current">
            {item.label}
          </div>
          <div className="mt-1 font-mono text-[15px] font-extrabold leading-none text-console-ink">
            {item.value}
          </div>
          {item.hint ? <div className="mt-1 text-[11px] text-console-steel">{item.hint}</div> : null}
        </li>
      ))}
    </ul>
  );
}

export function SearchInput({
  value,
  onChange,
  onEscape,
  label = ko.console.search.label,
  placeholder = ko.console.search.placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onEscape?: () => void;
  label?: string;
  placeholder?: string;
}) {
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <input
        type="search"
        role="searchbox"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onEscape?.();
        }}
        className="min-h-9 w-full rounded-[8px] border border-console-border bg-console-canvas px-3 pr-9 text-[13px] text-console-ink placeholder:text-console-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
      />
      {value ? (
        <button
          type="button"
          aria-label={ko.console.search.clear}
          className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-console-faint hover:bg-console-muted hover:text-console-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
          onClick={() => {
            onChange("");
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </label>
  );
}

export function SectionCard({
  title,
  meta,
  action,
  children,
  className,
}: {
  title: string;
  meta?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "rounded-[9px] border border-console-border bg-console-surface p-3 shadow-console",
        className,
      )}
    >
      <header className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <div>
          <h2 className="text-[12px] font-extrabold leading-none text-console-ink">{title}</h2>
          {meta ? <p className="mt-1 text-[11px] text-console-steel">{meta}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function ConsoleToast({
  message,
  onUndo,
  onClose,
}: {
  message: string;
  onUndo?: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      role="status"
      className="console-motion-toast fixed bottom-5 left-1/2 z-50 flex min-h-10 max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-[8px] bg-console-ink px-3 py-2 text-[12px] font-bold text-console-surface shadow-console-pop"
    >
      <span className="min-w-0 flex-1">{message}</span>
      {onUndo ? (
        <button
          type="button"
          className="rounded px-2 py-1 text-console-signal hover:bg-console-steel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
          onClick={onUndo}
        >
          {ko.console.toast.undo}
        </button>
      ) : null}
      {onClose ? (
        <button
          type="button"
          aria-label={ko.console.toast.close}
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-console-steel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}
