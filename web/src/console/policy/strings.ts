// Injected copy for BulkPolicyGateProvider's fail-closed error banner. Kept out
// of the component file (react-refresh/only-export-components) and free of
// Hangul (check-ui-strings); real values live at ko.console.policyGate — this
// module resolves it at call time so every BulkPolicyGateProvider call site
// gets the Korean copy without threading a `strings` prop through each page.

import { ko } from "../../i18n/ko";

export interface PolicyGateStrings {
  /** Reason line: authorization could not be resolved. */
  error: string;
  /** Retry affordance label (next action). */
  retry: string;
  /** aria-label for the retry control. */
  retryAria: string;
}

const ENGLISH_FALLBACK: PolicyGateStrings = {
  error: "Could not verify permissions. Controls are hidden until this succeeds.",
  retry: "Retry",
  retryAria: "Retry permission check",
};

export const DEFAULT_POLICY_GATE_STRINGS: PolicyGateStrings =
  (ko.console as unknown as { policyGate?: PolicyGateStrings }).policyGate ??
  ENGLISH_FALLBACK;
