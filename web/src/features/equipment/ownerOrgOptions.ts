import type { GroupAdminGroup } from "../../api/groupAdmin";
import type { EquipmentOwnerOrgOption } from "./EquipmentManagementPanel";

export function flattenEquipmentOwnerOrgOptions(
  groups: readonly GroupAdminGroup[],
): EquipmentOwnerOrgOption[] {
  return groups
    .flatMap((group) =>
      group.members.map((member) => ({
        id: member.id,
        name: member.name,
        slug: member.slug,
        groupName: group.name,
      })),
    )
    .sort(
      (a, b) =>
        a.groupName.localeCompare(b.groupName, "ko") ||
        a.name.localeCompare(b.name, "ko") ||
        a.slug.localeCompare(b.slug),
    );
}
