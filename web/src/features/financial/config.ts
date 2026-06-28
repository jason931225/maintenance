import type { FinancialConfigSnapshot } from "../../api/types";
import { formatWonAmount } from "../../lib/currency";
import { ROLES } from "../../components/shell/nav";

/**
 * Role sets derived directly from the backend permission matrix in
 * `backend/crates/platform/authz/src/lib.rs`. Column order is
 * [Receptionist, Mechanic, Admin, Executive, SuperAdmin]; a role is included
 * when its cell is `Allow` (the level every financial mutation requires via
 * `Action::new`). These gate the per-action controls so the UI never offers a
 * button the backend would 403; the backend re-checks on every call.
 */

/** PurchaseRequestCreate `[A, R, A, D, A]` — submit/prepare/restart also use Allow. */
export const PURCHASE_CREATE_ROLES = [
  ROLES.RECEPTIONIST,
  ROLES.ADMIN,
  ROLES.SUPER_ADMIN,
] as const;

/** PurchaseRequestApprove `[D, D, A, D, A]`. */
export const PURCHASE_APPROVE_ROLES = [ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;

/** PurchaseFinalApprove `[D, D, D, A, A]`. */
export const PURCHASE_FINAL_APPROVE_ROLES = [
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

/** PurchaseExecute `[A, D, A, D, A]`. */
export const PURCHASE_EXECUTE_ROLES = [
  ROLES.RECEPTIONIST,
  ROLES.ADMIN,
  ROLES.SUPER_ADMIN,
] as const;

/** Reject is allowed to PurchaseRequestApprove OR PurchaseFinalApprove holders. */
export const PURCHASE_REJECT_ROLES = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

/** RentalQuoteManage `[A, D, A, A, A]`. */
export const RENTAL_QUOTE_ROLES = [
  ROLES.RECEPTIONIST,
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

/** EquipmentCostLedgerRead `[D, D, A, A, A]`. */
export const COST_LEDGER_READ_ROLES = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

/** EquipmentCostLedgerWrite `[D, D, A, D, A]` — manual admin cost entry. */
export const COST_LEDGER_WRITE_ROLES = [
  ROLES.ADMIN,
  ROLES.SUPER_ADMIN,
] as const;

/**
 * Tenant financial parameters supplied with every quote/purchase command. The
 * backend takes these as a per-request snapshot rather than reading a config
 * table, so the console carries a sensible default mirroring the values
 * exercised in the backend adapter tests. The executive-approval threshold
 * decides whether `prepare-expenditure` routes to executive approval.
 */
export const DEFAULT_FINANCIAL_CONFIG: FinancialConfigSnapshot = {
  depreciation_method: "STRAIGHT_LINE",
  useful_life_months: 60,
  residual_rate_bps: 1_000,
  declining_balance_rate_bps: 2_000,
  management_fee_rate_bps: 1_000,
  profit_rate_bps: 500,
  floor_negative_quote_residual: true,
  executive_approval_threshold_won: 2_000_000,
};

/** Format an integer won amount with thousands separators (no currency glyph). */
export function formatWon(amount: number): string {
  return formatWonAmount(amount);
}
