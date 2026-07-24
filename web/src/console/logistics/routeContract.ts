/**
 * Public, module-owned mount contract for the shared console registry.
 * The registry mounts prop-less bodies, so the contract is the empty prop set:
 * the body derives api/session via useAuth() and selects its branch in-module
 * from the session `branches` claim.
 */
export interface LogisticsRouteContract {
  screen: "logistics";
}

/** Fixture is structural only: it deliberately contains no business records. */
export const LOGISTICS_ROUTE_CONTRACT_FIXTURE: LogisticsRouteContract = {
  screen: "logistics",
};
