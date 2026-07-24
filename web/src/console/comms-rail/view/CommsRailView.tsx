import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";

import {
  COMMS_RAIL_SOURCES,
  type CommsRailItem,
  type CommsRailAction,
  type CommsRailLoadState,
  type CommsRailSnapshot,
  type CommsRailSource,
  type CommsRailTarget,
  unreadCount,
} from "../model";
import "./CommsRailView.css";

export type CommsRailPresentation = "persistent" | "drawer";

/** All human-facing copy is supplied by the shell/i18n boundary. */
export interface CommsRailCopy {
  landmark: string;
  drawerTitle: string;
  close: string;
  open: string;
  source: Record<CommsRailSource, string>;
  state: {
    loading: string;
    empty: string;
    denied: string;
    malformed: string;
    error: string;
    retry: string;
    retrying: string;
  };
  action: Record<CommsRailAction["kind"], string>;
  unread: (count: number) => string;
  collapse: (source: string) => string;
  expand: (source: string) => string;
  detail: string;
  occurredAt: (iso: string) => string;
}

export interface CommsRailComposeControl {
  /** A non-empty localized label plus the real authorized compose command. */
  label: string;
  onCompose: () => void;
}

type InlineTarget = Extract<CommsRailTarget, { kind: "inline" }>;
type FullModuleTarget = Extract<CommsRailTarget, { kind: "full-screen" }>;

interface CommsRailViewCommonProps {
  snapshot: CommsRailSnapshot;
  copy: CommsRailCopy;
  retryingSource?: CommsRailSource;
  onRetry?: (source: CommsRailSource) => void;
  onDrill?: (item: CommsRailItem, target: CommsRailTarget) => void;
  /** Inline detail ownership remains with the embedding console surface. */
  onDetail?: (item: CommsRailItem, target: InlineTarget) => void;
  /** Full module navigation remains with the embedding router surface. */
  onOpenFullModule?: (item: CommsRailItem, target: FullModuleTarget) => void;
  /** The store-backed mutation owner is injected by the container. */
  onAction?: (action: CommsRailAction) => void;
  /** Compose is omitted unless both label and real command are available. */
  compose?: CommsRailComposeControl;
  /** Optional real detail renderer supplied by the owning product surface. */
  renderInlineDetail?: (item: CommsRailItem) => ReactNode;
  /** Makes the shell integration invariant assertable without touching its owner. */
  workspacePreservedId?: string;
}

export type CommsRailViewProps = CommsRailViewCommonProps & (
  | { presentation?: "persistent"; drawerOpen?: never; onRequestClose?: never; returnFocusRef?: never }
  | {
    presentation: "drawer";
    drawerOpen: boolean;
    onRequestClose: () => void;
    /** The live trigger is supplied by the shell so focus restoration is exact. */
    returnFocusRef: RefObject<HTMLElement | null>;
  }
);

function itemTitle(item: CommsRailItem): string {
  switch (item.source) {
    case "messenger":
      return item.title ?? item.code;
    case "mail":
      return item.subject;
    case "notices":
      return item.title;
    case "notifications":
      return item.text;
  }
}

function itemSecondary(item: CommsRailItem): string | undefined {
  switch (item.source) {
    case "messenger":
      return item.visibility;
    case "mail":
      return item.hasAttachments ? item.code : undefined;
    case "notifications":
      return item.category;
    case "notices":
      return undefined;
  }
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
}

function useDrawerFocus(
  active: boolean,
  rootRef: RefObject<HTMLElement | null>,
  returnFocusRef: RefObject<HTMLElement | null> | undefined,
  onRequestClose: (() => void) | undefined,
) {
  useEffect(() => {
    if (!active) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const returnTarget = returnFocusRef?.current;
    const focusFirst = () => {
      focusableElements(rootRef.current ?? document.body)[0]?.focus();
    };
    focusFirst();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onRequestClose?.();
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) return;
      const elements = focusableElements(rootRef.current);
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      (returnTarget ?? prior)?.focus();
    };
  }, [active, onRequestClose, returnFocusRef, rootRef]);
}

function sourceState(
  source: CommsRailSource,
  state: CommsRailLoadState,
  copy: CommsRailCopy,
  retryingSource: CommsRailSource | undefined,
  onRetry: ((source: CommsRailSource) => void) | undefined,
): ReactNode {
  if (state.kind === "ready") return null;
  if (state.kind === "error" && retryingSource === source) {
    return <p className="commsRail__state" data-comms-state="retry" role="status">{copy.state.retrying}</p>;
  }
  if (state.kind === "error") {
    return (
      <div className="commsRail__state" data-comms-state="error" role="alert">
        <span>{copy.state.error}</span>
        {onRetry ? <button type="button" className="commsRail__retry" onClick={() => { onRetry(source); }}>{copy.state.retry}</button> : null}
      </div>
    );
  }
  const label = state.kind === "loading"
    ? copy.state.loading
    : state.kind === "empty"
      ? copy.state.empty
      : state.kind === "denied"
        ? copy.state.denied
        : copy.state.malformed;
  return <p className="commsRail__state" data-comms-state={state.kind} role={state.kind === "denied" || state.kind === "malformed" ? "alert" : "status"}>{label}</p>;
}

function categoryItems(source: CommsRailSource, state: CommsRailLoadState): readonly CommsRailItem[] | undefined {
  if (state.kind !== "ready") return undefined;
  const items = state.items.filter((item) => item.source === source);
  return items.length === state.items.length ? items : undefined;
}

function RailCategory({
  source,
  state,
  copy,
  retryingSource,
  onRetry,
  onDrill,
  onDetail,
  onOpenFullModule,
  onAction,
  renderInlineDetail,
}: {
  source: CommsRailSource;
  state: CommsRailLoadState;
  copy: CommsRailCopy;
  retryingSource?: CommsRailSource;
  onRetry?: (source: CommsRailSource) => void;
  onDrill?: (item: CommsRailItem, target: CommsRailTarget) => void;
  onDetail?: (item: CommsRailItem, target: InlineTarget) => void;
  onOpenFullModule?: (item: CommsRailItem, target: FullModuleTarget) => void;
  onAction?: (action: CommsRailAction) => void;
  renderInlineDetail?: (item: CommsRailItem) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const [detail, setDetail] = useState<CommsRailItem | undefined>();
  const sectionId = useId();
  const name = copy.source[source];
  const items = categoryItems(source, state);
  const malformed = state.kind === "ready" && items === undefined;
  const unread = items ? unreadCount(items) : 0;

  const openItem = (item: CommsRailItem) => {
    const target = item.target;
    if (!target) return;
    if (target.kind === "inline") {
      if (renderInlineDetail) setDetail(item);
      onDetail?.(item, target);
    } else {
      onOpenFullModule?.(item, target);
    }
    onDrill?.(item, target);
  };

  return (
    <section className="commsRail__category" data-comms-source={source} data-testid={`latest-comms-source-${source}`} data-audit-source={source}>
      <div className="commsRail__heading">
        <button
          type="button"
          className="commsRail__collapse"
          aria-expanded={expanded}
          aria-controls={sectionId}
          aria-label={expanded ? copy.collapse(name) : copy.expand(name)}
          onClick={() => { setExpanded((value) => !value); }}
        >
          <span>{name}</span>
          {unread > 0 ? <span className="commsRail__unread" aria-label={copy.unread(unread)}>{unread}</span> : null}
        </button>
      </div>
      {expanded ? (
        <div id={sectionId}>
          {malformed
            ? <p className="commsRail__state" data-comms-state="malformed" role="alert">{copy.state.malformed}</p>
            : sourceState(source, state, copy, retryingSource, onRetry)}
          {items && items.length > 0 ? (
            <ul className="commsRail__items" aria-label={name}>
              {items.map((item) => (
                <li key={item.id} data-comms-row={item.id} data-testid={`latest-comms-row-${source}-${item.id}`} data-correlation-id={item.id} data-unread={item.unread || undefined}>
                  {item.target && (onDrill || onDetail || onOpenFullModule || renderInlineDetail) ? (
                    <button
                      type="button"
                      className="commsRail__row"
                      aria-expanded={detail?.id === item.id}
                      data-testid={item.target.kind === "full-screen" ? `latest-comms-open-full-module-${source}-${item.id}` : `latest-comms-drill-${source}-${item.id}`}
                      data-latest-comms-drill
                      data-latest-comms-open-full-module={item.target.kind === "full-screen" || undefined}
                      data-audit-id={`${source}:${item.id}`}
                      onClick={() => { openItem(item); }}
                    >
                      <RowContents item={item} copy={copy} />
                    </button>
                  ) : <div className="commsRail__row commsRail__row--static"><RowContents item={item} copy={copy} /></div>}
                  {item.action && onAction && copy.action[item.action.kind].trim() ? (
                    <button type="button" className="commsRail__action" data-testid={`latest-comms-action-${source}-${item.id}`} onClick={() => { if (item.action) onAction(item.action); }}>
                      {copy.action[item.action.kind]}
                    </button>
                  ) : null}
                  {detail?.id === item.id && renderInlineDetail ? (
                    <section className="commsRail__detail" aria-label={copy.detail} data-comms-detail={item.id} data-testid="latest-comms-detail">
                      {renderInlineDetail(item)}
                    </section>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RowContents({ item, copy }: { item: CommsRailItem; copy: CommsRailCopy }) {
  const secondary = itemSecondary(item);
  return <>
    <span className="commsRail__rowMain">
      <strong>{itemTitle(item)}</strong>
      {secondary ? <span>{secondary}</span> : null}
    </span>
    <span className="commsRail__rowMeta">
      <time dateTime={item.occurredAt}>{copy.occurredAt(item.occurredAt)}</time>
      {item.unread ? <span className="commsRail__unreadDot" aria-label={copy.unread(1)}>●</span> : null}
    </span>
  </>;
}

export function CommsRailView({
  snapshot,
  copy,
  presentation = "persistent",
  drawerOpen = false,
  onRequestClose,
  returnFocusRef,
  retryingSource,
  onRetry,
  onDrill,
  onDetail,
  onOpenFullModule,
  onAction,
  compose,
  renderInlineDetail,
  workspacePreservedId,
}: CommsRailViewProps) {
  const rootRef = useRef<HTMLElement>(null);
  const isDrawer = presentation === "drawer";
  useDrawerFocus(isDrawer && drawerOpen, rootRef, returnFocusRef, onRequestClose);
  if (isDrawer && !drawerOpen) return null;

  const contents = (
    <>
      <header className="commsRail__top">
        <h2>{isDrawer ? copy.drawerTitle : copy.landmark}</h2>
        {compose && compose.label.trim().length > 0 ? <button type="button" className="commsRail__compose" onClick={compose.onCompose}>{compose.label}</button> : null}
        {isDrawer ? <button type="button" className="commsRail__close" onClick={onRequestClose}>{copy.close}</button> : null}
      </header>
      {COMMS_RAIL_SOURCES.map((source) => (
        <RailCategory
          key={source}
          source={source}
          state={snapshot[source]}
          copy={copy}
          retryingSource={retryingSource}
          onRetry={onRetry}
          onDrill={onDrill}
          onDetail={onDetail}
          onOpenFullModule={onOpenFullModule}
          onAction={onAction}
          renderInlineDetail={renderInlineDetail}
        />
      ))}
    </>
  );

  if (isDrawer) {
    return (
      <div className="commsRail__backdrop" data-comms-drawer-backdrop>
        <aside
          ref={rootRef}
          className="commsRail commsRail--drawer"
          role="dialog"
          aria-modal="true"
          aria-label={copy.drawerTitle}
          data-comms-presentation="drawer"
          data-comms-preserves-workspace={workspacePreservedId ?? "true"}
        >
          {contents}
        </aside>
      </div>
    );
  }
  return <aside ref={rootRef} className="commsRail" aria-label={copy.landmark} data-comms-presentation="persistent" data-comms-preserves-workspace={workspacePreservedId ?? "true"}>{contents}</aside>;
}
