import { useConsoleScreen } from "../../../features/workspace/pin-context";
import { useWorkspaceStore } from "../../../features/workspace/store";
import type { PinnedObject } from "../../../features/workspace/types";
import { ko } from "../../../i18n/ko";
import { consoleIcons } from "../../console/icons";

const PinIcon = consoleIcons.pin;

/**
 * Pins a row's object into a detail panel on the current console screen.
 * Renders nothing when not inside ConsoleShell (no screen context), so the
 * migrated pages still work when rendered standalone.
 */
export function PinButton({ object }: { object: PinnedObject }) {
  const screen = useConsoleScreen();
  const pin = useWorkspaceStore((s) => s.pin);
  if (!screen) return null;
  return (
    <button
      type="button"
      aria-label={ko.console.workspace.pin.label.replace("{title}", object.title)}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] border border-console-border bg-console-surface text-console-steel shadow-console hover:border-console-steel hover:text-console-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal focus-visible:ring-offset-1 focus-visible:ring-offset-console-surface"
      onClick={() => {
        pin(screen, object);
      }}
    >
      <PinIcon aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
    </button>
  );
}
