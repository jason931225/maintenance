import matrixJson from "../../docs/benchmarks/browser-persona-e2e-matrix.json" with { type: "json" };

export const LIVE_ORG_SLUGS = [
  "cheongun-hr",
  "cheongun-logis",
  "cnl",
  "coss",
  "dsl",
  "lso",
  "jy-tech",
  "knl",
] as const;

export const PERSONA_UI_STATES = [
  "loading",
  "empty",
  "error",
  "permission-denied",
] as const;

export const PERSONA_LIVE_VERIFICATION_STEPS = [
  "db",
  "api",
  "browser",
  "screenshot",
  "trace",
  "logs",
  "rollout",
] as const;

export type LiveOrgSlug = (typeof LIVE_ORG_SLUGS)[number];
export type PersonaUiState = (typeof PERSONA_UI_STATES)[number];
export type PersonaLiveVerificationStep = (typeof PERSONA_LIVE_VERIFICATION_STEPS)[number];

export type BrowserPersona = {
  personaId: string;
  displayName: string;
  orgSlug: string;
  groupSlug: string | null;
  roleProfile: string[];
  scopeModes: string[];
  routeGroups: string[];
  e2eSpecs: string[];
  denialPaths: string[];
  uiStates: PersonaUiState[];
  screenshotTraceEvidence: string;
  liveVerification: PersonaLiveVerificationStep[];
};

export type BrowserPersonaMatrix = {
  schemaVersion: 1;
  goalId: "G003-browser-e2e-persona-harness";
  liveOrgSlugs: LiveOrgSlug[];
  personas: BrowserPersona[];
};

export const browserPersonaMatrix = matrixJson as BrowserPersonaMatrix;

export function personasForOrg(orgSlug: string): BrowserPersona[] {
  return browserPersonaMatrix.personas.filter((persona) => persona.orgSlug === orgSlug);
}

export function personaById(personaId: string): BrowserPersona | undefined {
  return browserPersonaMatrix.personas.find((persona) => persona.personaId === personaId);
}

export function requiredSpecsForPersona(personaId: string): string[] {
  return personaById(personaId)?.e2eSpecs ?? [];
}
