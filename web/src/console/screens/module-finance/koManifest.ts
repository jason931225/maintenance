// `console.modules.finance` copy this lane's S14 FSM re-model needs. Sourced
// from the merged ko.ts (web/src/i18n/ko.ts) — the single source of truth,
// per check-ui-strings (no Hangul literals outside web/src/i18n or test files).
import { ko } from "../../../i18n/ko";

const F = ko.console.modules.finance;

export const financeKoManifest = {
  stats: {
    pending: F.stats.pending,
    postedThisMonth: F.stats.postedThisMonth,
    postedAmountThisMonth: F.stats.postedAmountThisMonth,
    auto: F.stats.auto,
  },
  statuses: {
    balance_checked: F.statuses.balance_checked,
    approved: F.statuses.approved,
    reversed: F.statuses.reversed,
  },
  actions: {
    submitVoucher: F.actions.submitVoucher,
    approveVoucher: F.actions.approveVoucher,
  },
  detail: {
    documentFlow: F.detail.documentFlow,
    balanceCheck: F.detail.balanceCheck,
    approvedBy: F.detail.approvedBy,
  },
  links: {
    reversalOf: F.links.reversalOf,
    reversedBy: F.links.reversedBy,
  },
  compose: {
    branchField: F.compose.branchField,
    branchLoading: F.compose.branchLoading,
  },
} as const;
