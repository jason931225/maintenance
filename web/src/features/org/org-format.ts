import { ROLES, type Role } from "../../components/shell/nav";
import { ko } from "../../i18n/ko";
import type { Team } from "../../api/types";

/** Selectable team codes, mirroring the backend `Team` enum. */
export const TEAMS: readonly Team[] = [
  "MAINTENANCE",
  "PREVENTION",
  "MANAGEMENT",
  "RECEPTION",
];

/** Assignable role codes, mirroring the backend `Role` enum. */
export const ASSIGNABLE_ROLES: readonly Role[] = [
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.MECHANIC,
  ROLES.RECEPTIONIST,
];

export function teamLabel(team: Team): string {
  return ko.users.teams[team];
}

export function roleLabel(role: string): string {
  // Map known role codes to their Korean labels. An unrecognized code (e.g. a
  // backend enum the client predates) falls back to a human label rather than
  // surfacing the raw internal code to the user.
  return (
    (ko.users.roles as Record<string, string>)[role] ?? ko.common.unknownLabel
  );
}
