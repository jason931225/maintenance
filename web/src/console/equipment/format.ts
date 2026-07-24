import { equipmentStrings as text } from "../../i18n/equipment";
import type { CaseStatus, UnitAvailability } from "./equipmentApi";

const numberFormat = new Intl.NumberFormat("ko-KR");
const dateTimeFormat = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "short",
  timeStyle: "short",
});

/** KRW is zero-decimal: the minor unit is the won itself. */
export function formatKrw(amountMinor: number): string {
  return `${numberFormat.format(amountMinor)}${text.krwSuffix}`;
}

export function formatMonths(months: number): string {
  return `${numberFormat.format(months)}${text.monthsSuffix}`;
}

export function formatInstant(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : dateTimeFormat.format(parsed);
}

export function availabilityLabel(availability: UnitAvailability): string {
  return Object.hasOwn(text.availability, availability)
    ? text.availability[availability]
    : text.unknown;
}

export function caseStatusLabel(status: CaseStatus): string {
  return Object.hasOwn(text.caseStatus, status) ? text.caseStatus[status] : text.unknown;
}

/** Chip tone classes keyed to tokens.css status palettes (plain string literals). */
export const AVAILABILITY_CHIP: Record<UnitAvailability, string> = {
  AVAILABLE: "equipment__chip equipment__chip--ok",
  RESERVED: "equipment__chip equipment__chip--info",
  ON_RENT: "equipment__chip equipment__chip--accent",
  IN_ASSESSMENT: "equipment__chip equipment__chip--purple",
  IN_REPAIR: "equipment__chip equipment__chip--warn",
  IN_REFURBISHMENT: "equipment__chip equipment__chip--warn",
  FOR_SALE: "equipment__chip equipment__chip--info",
  SOLD: "equipment__chip equipment__chip--neutral",
};

export const CASE_CHIP: Record<CaseStatus, string> = {
  QUOTED: "equipment__chip equipment__chip--info",
  APPROVED: "equipment__chip equipment__chip--ok",
  DECLINED: "equipment__chip equipment__chip--danger",
  DISPATCHED: "equipment__chip equipment__chip--accent",
  HANDED_OVER: "equipment__chip equipment__chip--purple",
  RETURNED: "equipment__chip equipment__chip--warn",
  CLOSED: "equipment__chip equipment__chip--neutral",
};
