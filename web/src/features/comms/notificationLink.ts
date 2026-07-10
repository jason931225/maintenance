import { objectRegistry, type ObjectKind } from "../../lib/objectRegistry";
import type { NotificationLink } from "../../api/types";

// A notification either points at a domain object (kind + id → the object's
// route, via the M2a object registry) or at a bare app screen. Screen names map
// through this table; anything unknown falls back to the overview so a click is
// never a dead end.
const SCREEN_ROUTES: Record<string, string> = {
  overview: "/",
  approvals: "/approvals",
  messenger: "/messenger",
  mail: "/mail",
  support: "/support",
  attendance: "/attendance",
  payroll: "/payroll",
  "work-hub": "/work-hub",
  intake: "/intake",
  financial: "/financial",
};

const FALLBACK_ROUTE = "/";

// Object kinds with no console detail route (and no registry entry) but a
// sensible screen home — e.g. a messenger @-mention (#202) links kind
// "messenger_thread", and the app has no per-thread route, so land on /messenger.
const OBJECT_KIND_SCREENS: Record<string, string> = {
  messenger_thread: "/messenger",
};

function isObjectKind(kind: string): kind is ObjectKind {
  return Object.prototype.hasOwnProperty.call(objectRegistry, kind);
}

export function notificationRoute(link: NotificationLink): string {
  if (link.type === "screen") {
    return SCREEN_ROUTES[link.screen] ?? FALLBACK_ROUTE;
  }
  if (isObjectKind(link.kind)) {
    return objectRegistry[link.kind].route({ id: link.id });
  }
  return OBJECT_KIND_SCREENS[link.kind] ?? FALLBACK_ROUTE;
}
