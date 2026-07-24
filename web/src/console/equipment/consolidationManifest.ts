/**
 * Handoff-only manifest for the owners of shared OpenAPI, generated clients,
 * and console routing. This module intentionally does not mutate those faces.
 */
export const EQUIPMENT_3R_CONSOLIDATION_MANIFEST = {
  openApi: [
    "Add /api/v1/equipment-3r unit, case, history, transition, and disposition operations.",
    "Change handover request evidenceReference:string to evidenceId:uuid; retain compatibility only during rollout.",
    "Remove financeGlPosting from disposition completion responses (no accounting posting is produced).",
  ],
  generatedClients: [
    "Regenerate TypeScript, Kotlin, and Swift faces from the consolidated OpenAPI contract.",
  ],
  router: [
    "Register /console/equipment-3r and EquipmentScreenBody in the shared console route/screen registry.",
    "Expose the module only when equipment_3r.observe is projected; backend remains authoritative.",
  ],
  evidenceIntegration: [
    "Use the existing evidence object upload/verification flow before selecting a handover record.",
    "Equipment accepts only an evidence UUID; backend verifies tenant, branch custody, admissibility, original WORM verification, and non-disposal.",
  ],
} as const;
