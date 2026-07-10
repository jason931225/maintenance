import { Mail, MessageSquare, PanelRightClose } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";
import { PageEmpty } from "../states/PageEmpty";

/** The two communication surfaces the rail summarises and promotes to full view. */
export type CommsSurface = "messenger" | "mail";

const SURFACE_HREF: Record<CommsSurface, string> = {
  messenger: "/messenger",
  mail: "/mail",
};

interface CommsRailProps {
  open: boolean;
  surface: CommsSurface;
  onSurfaceChange: (surface: CommsSurface) => void;
  onClose: () => void;
}

/**
 * Right-hand communication rail (DESIGN §4.8). It carries a compact summary of a
 * communication surface (messenger / mail) and shares its selected `surface`
 * with the main region: "풀뷰 열기" promotes the rail's current surface to its
 * full-view page, so the rail summary and the main full view stay on the same
 * surface.
 *
 * wire-pending: the per-surface unread summary (thread/mail previews) lands in
 * Phase B/C once the rail reads the same messenger/mail state the pages do; the
 * scaffold reserves the shared-surface plumbing and the promotion affordance.
 */
export function CommsRail({
  open,
  surface,
  onSurfaceChange,
  onClose,
}: CommsRailProps) {
  const navigate = useNavigate();
  if (!open) return null;

  return (
    <aside
      aria-label={ko.commsRail.label}
      className="hidden w-80 shrink-0 flex-col border-l border-line bg-white lg:flex"
    >
      <div className="flex h-14 items-center gap-2 border-b border-line px-3">
        <div role="tablist" aria-label={ko.commsRail.label} className="flex gap-1">
          <SurfaceTab
            active={surface === "messenger"}
            label={ko.commsRail.surfaces.messenger}
            Icon={MessageSquare}
            onClick={() => {
              onSurfaceChange("messenger");
            }}
          />
          <SurfaceTab
            active={surface === "mail"}
            label={ko.commsRail.surfaces.mail}
            Icon={Mail}
            onClick={() => {
              onSurfaceChange("mail");
            }}
          />
        </div>
        <button
          type="button"
          aria-label={ko.commsRail.close}
          onClick={onClose}
          className="ml-auto rounded-md p-2 text-steel hover:bg-muted-panel hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
        >
          <PanelRightClose size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {/* wire-pending: live per-surface summary. */}
        <PageEmpty />
      </div>

      <div className="border-t border-line p-3">
        <button
          type="button"
          onClick={() => {
            void navigate(SURFACE_HREF[surface]);
          }}
          className="w-full min-h-11 rounded-md bg-signal px-3 py-2 text-sm font-bold text-ink transition hover:bg-signal/90 focus-visible:outline-2 focus-visible:outline-ink"
        >
          {ko.commsRail.fullView}
        </button>
      </div>
    </aside>
  );
}

function SurfaceTab({
  active,
  label,
  Icon,
  onClick,
}: {
  active: boolean;
  label: string;
  Icon: typeof MessageSquare;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-semibold transition-colors",
        active ? "bg-muted-panel text-ink" : "text-steel hover:text-ink",
      )}
    >
      <Icon size={15} aria-hidden="true" />
      {label}
    </button>
  );
}
