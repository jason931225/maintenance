import { test, expect } from "@playwright/test";

import {
  browserPersonaMatrix,
  LIVE_ORG_SLUGS,
  PERSONA_LIVE_VERIFICATION_STEPS,
  PERSONA_UI_STATES,
  personasForOrg,
} from "../fixtures/personas";

test.describe("platform maturity persona matrix contract", () => {
  test("covers every live org, required UI state, and live verification step", () => {
    expect(browserPersonaMatrix.goalId).toBe("G003-browser-e2e-persona-harness");
    for (const orgSlug of LIVE_ORG_SLUGS) {
      expect(personasForOrg(orgSlug), `${orgSlug} should have at least one persona`).not.toHaveLength(0);
    }
    for (const persona of browserPersonaMatrix.personas) {
      for (const state of PERSONA_UI_STATES) {
        expect(persona.uiStates, `${persona.personaId} missing ${state}`).toContain(state);
      }
      for (const step of PERSONA_LIVE_VERIFICATION_STEPS) {
        expect(persona.liveVerification, `${persona.personaId} missing ${step}`).toContain(step);
      }
      expect(persona.denialPaths.length, `${persona.personaId} needs denial paths`).toBeGreaterThan(0);
      expect(persona.screenshotTraceEvidence).toContain("screenshot");
      expect(persona.screenshotTraceEvidence).toContain("trace");
    }
  });
});
