/** Public, module-owned mount contract for the shared console registry. */
export interface EquipmentRouteContract {
  branchId: string;
}

/** Public, module-owned descriptor consumed by the shared console integrator. */
export const EQUIPMENT_3R_PUBLIC_DESCRIPTOR = {
  route: "/console/equipment-3r",
  screen: "equipment-3r",
  requiredFeatures: ["equipment_3r.observe"],
  apiPrefix: "/api/v1/equipment-3r",
} as const;

/** Fixture is structural only: it deliberately contains no business records. */
export const EQUIPMENT_ROUTE_CONTRACT_FIXTURE: EquipmentRouteContract = {
  branchId: "00000000-0000-4000-8000-000000000000",
};
