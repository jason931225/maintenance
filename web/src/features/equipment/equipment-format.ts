import type { EquipmentStatus } from "../../api/types";
import { toneBadgeClass } from "../../lib/semantic";

/** Tailwind classes for equipment status badges, backed by semantic tokens. */
export function equipmentStatusBadgeClass(status: EquipmentStatus): string {
  switch (status) {
    case "rented":
      return toneBadgeClass("accent");
    case "spare":
      return toneBadgeClass("neutral");
    case "disposed":
      return toneBadgeClass("danger");
    case "replacement":
      return toneBadgeClass("info");
    case "sold":
      return toneBadgeClass("success");
  }
}
