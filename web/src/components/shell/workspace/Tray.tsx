import { chipPrefix } from "../../../features/workspace/format";
import type { Panel } from "../../../features/workspace/types";
import { ko } from "../../../i18n/ko";
import { consoleIcons } from "../../console/icons";
import { Chip } from "../../console/primitives";

const RepeatIcon = consoleIcons.repeat;

/**
 * Bottom docked tray: minimized panel chips (click to restore) plus a
 * restore-default control that clears the screen's layout. Rendered as a normal
 * flex child so it reserves real space (content reflows above it).
 */
export function Tray({
  minimized,
  hasAnyPanels,
  onRestore,
  onRestoreDefault,
}: {
  minimized: Panel[];
  hasAnyPanels: boolean;
  onRestore: (id: string) => void;
  onRestoreDefault: () => void;
}) {
  if (minimized.length === 0 && !hasAnyPanels) return null;
  return (
    <div
      role="toolbar"
      aria-label={ko.console.workspace.tray.label}
      className="flex min-h-11 items-center gap-2 border-t border-console-border bg-console-surface px-3 py-1.5"
    >
      <span className="text-[10px] font-extrabold uppercase text-console-faint">
        {ko.console.workspace.tray.label}
      </span>
      <ul
        className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
        role="list"
      >
        {minimized.length === 0 ? (
          <li className="text-[11px] text-console-steel">
            {ko.console.workspace.tray.empty}
          </li>
        ) : (
          minimized.map((panel) => (
            <li key={panel.id}>
              <button
                type="button"
                aria-label={ko.console.workspace.tray.restore.replace(
                  "{title}",
                  panel.object.title,
                )}
                className="inline-flex min-h-7 items-center gap-1.5 rounded-[7px] border border-console-border bg-console-canvas px-2 text-[11px] font-bold text-console-ink hover:border-console-steel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
                onClick={() => {
                  onRestore(panel.id);
                }}
              >
                <Chip tone="neutral" className="px-1.5 font-mono">
                  {chipPrefix(panel.object.code)}
                </Chip>
                <span className="max-w-40 truncate">{panel.object.title}</span>
              </button>
            </li>
          ))
        )}
      </ul>
      {hasAnyPanels ? (
        <button
          type="button"
          className="inline-flex min-h-7 items-center gap-1 rounded-[7px] px-2 text-[11px] font-bold text-console-steel hover:bg-console-muted hover:text-console-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal"
          onClick={onRestoreDefault}
        >
          <RepeatIcon
            aria-hidden="true"
            className="h-3.5 w-3.5"
            strokeWidth={2}
          />
          {ko.console.workspace.tray.restoreDefault}
        </button>
      ) : null}
    </div>
  );
}
