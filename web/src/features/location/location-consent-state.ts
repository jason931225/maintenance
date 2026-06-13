import type { LocationConsentState } from "../../api/types";

export type LocationConsentEvent =
  | "grant"
  | "suspend"
  | "resume"
  | "withdraw";

export function mayCollectGps(
  consentState: LocationConsentState,
  onDuty: boolean,
): boolean {
  return consentState === "GRANTED" && onDuty;
}

export function applyLocationConsentEvent(
  consentState: LocationConsentState,
  event: LocationConsentEvent,
): LocationConsentState {
  switch (event) {
    case "grant":
      return consentState === "NO_RECORD" || consentState === "WITHDRAWN"
        ? "GRANTED"
        : consentState;
    case "suspend":
      return consentState === "GRANTED" ? "SUSPENDED" : consentState;
    case "resume":
      return consentState === "SUSPENDED" ? "GRANTED" : consentState;
    case "withdraw":
      return consentState === "GRANTED" || consentState === "SUSPENDED"
        ? "WITHDRAWN"
        : consentState;
  }
}
