import type { PolicyGate } from "../policy";
import { FIRST_LOGIN_ACTIONS } from "./useFirstLoginFlow";

export const FIRST_LOGIN_POLICY_GATE: PolicyGate = {
  can: (action) =>
    Object.values(FIRST_LOGIN_ACTIONS).includes(
      action as (typeof FIRST_LOGIN_ACTIONS)[keyof typeof FIRST_LOGIN_ACTIONS],
    ),
};
