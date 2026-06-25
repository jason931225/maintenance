import { ko } from "../../i18n/ko";
import type { OrgStatus } from "../../api/platform";

/** All tenant lifecycle statuses, in display order. */
export const ORG_STATUSES: OrgStatus[] = ["ACTIVE", "SUSPENDED", "ARCHIVED"];

/** Korean label for a tenant status. */
export function orgStatusLabel(status: OrgStatus): string {
  return ko.platform.status[status];
}

/** Tailwind classes tinting the status badge by lifecycle state. */
export function orgStatusBadgeClass(status: OrgStatus): string {
  switch (status) {
    case "ACTIVE":
      return "border-emerald-300 text-emerald-800";
    case "SUSPENDED":
      return "border-amber-300 text-amber-800";
    case "ARCHIVED":
      return "border-line text-steel";
  }
}
