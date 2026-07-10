import { Zap } from "lucide-react";
import type { CSSProperties } from "react";

import { TrayDock, useWindowManager } from "../../console/window";
import { ko } from "../../i18n/ko";

// TrayDock's default presentation is a floating pill; hosted in the dock band
// it flows inline so the quick-actions button and tray share one bottom strip.
const hostedTrayStyle: CSSProperties = {
  position: "static",
  border: "none",
  background: "transparent",
  boxShadow: "none",
  padding: 0,
  maxWidth: "none",
  flexWrap: "nowrap",
};

/**
 * Persistent bottom chrome (ref: bottom band): the 빠른 작업 dock button opens
 * the existing command palette, and the window-model TrayDock renders inline so
 * minimized panels stay visible on every screen (§4.7 최소화).
 */
export function ShellDock({
  onOpenCommandPalette,
}: {
  onOpenCommandPalette: () => void;
}) {
  const { minimizedIds, entries, restore } = useWindowManager();
  const trayItems = minimizedIds.flatMap((id) => {
    const entry = entries.get(id);
    return entry ? [{ id: entry.id, title: entry.title }] : [];
  });

  return (
    <div className="flex min-h-14 shrink-0 items-center gap-3 border-t border-line bg-white px-3 py-1.5">
      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg bg-signal px-4 text-sm font-bold text-ink transition hover:bg-signal/90 focus-visible:outline-2 focus-visible:outline-ink"
      >
        <Zap size={16} aria-hidden="true" />
        {ko.shell.dock.quickActions}
      </button>
      <div className="min-w-0 flex-1 overflow-x-auto">
        <TrayDock items={trayItems} onRestore={restore} style={hostedTrayStyle} />
      </div>
    </div>
  );
}
