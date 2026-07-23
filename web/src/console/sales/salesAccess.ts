const SALES_MANAGE = "sales_manage";
const SALES_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "EXECUTIVE"]);

export function canAccessSales(roles: readonly string[] | undefined, grants: readonly string[] | undefined): boolean {
  return grants?.includes(SALES_MANAGE) === true || roles?.some((role) => SALES_ROLES.has(role)) === true;
}
