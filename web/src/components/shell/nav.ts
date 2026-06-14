import {
  BarChart2,
  CheckSquare,
  ClipboardList,
  FilePlus,
  LifeBuoy,
  MapPin,
  MessageSquare,
  Wrench,
} from "lucide-react";

export const NAV_GROUPS = [
  {
    key: "operations",
    label: "nav.groups.operations",
    items: [
      { key: "dispatch",  href: "/dispatch",  labelKey: "nav.dispatch",  Icon: ClipboardList },
      { key: "intake",    href: "/intake",    labelKey: "nav.intake",    Icon: FilePlus },
      { key: "approvals", href: "/approvals", labelKey: "nav.approvals", Icon: CheckSquare },
      { key: "messenger", href: "/messenger", labelKey: "nav.messenger", Icon: MessageSquare },
      { key: "support",   href: "/support",   labelKey: "nav.support",   Icon: LifeBuoy },
    ],
  },
  {
    key: "data",
    label: "nav.groups.data",
    items: [
      { key: "kpi",       href: "/kpi",       labelKey: "nav.kpi",       Icon: BarChart2 },
      { key: "equipment", href: "/equipment", labelKey: "nav.equipment", Icon: Wrench },
    ],
  },
  {
    key: "settings",
    label: "nav.groups.settings",
    items: [
      { key: "location",  href: "/settings/location", labelKey: "nav.location", Icon: MapPin },
    ],
  },
] as const;

export type NavGroupKey = (typeof NAV_GROUPS)[number]["key"];
export type NavItemKey = (typeof NAV_GROUPS)[number]["items"][number]["key"];
