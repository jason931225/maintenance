import type { KpiRollupScope } from "../../api/types";
import { ko } from "../../i18n/ko";

export function getDefaultKpiPeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return `${formatUtcDate(start)}..${formatUtcDate(end)}`;
}

export function getWallboardRefreshIntervalMs() {
  const configuredSeconds = Number(
    import.meta.env.VITE_WALLBOARD_REFRESH_SECONDS,
  );

  if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
    return configuredSeconds * 1_000;
  }

  return 60_000;
}

export function formatCount(value: number) {
  return `${String(value)}${ko.common.countUnit}`;
}

export function formatPoints(value: number) {
  return `${String(value)}${ko.common.pointUnit}`;
}

export function formatBps(value: number | null) {
  if (value === null) {
    return ko.common.notSet;
  }

  return `${trimDecimal(value / 100)}%`;
}

export function formatSeconds(value: number | null) {
  if (value === null) {
    return ko.common.notSet;
  }

  if (value >= 3_600) {
    return `${trimDecimal(value / 3_600)}${ko.common.hourUnit}`;
  }

  if (value >= 60) {
    return `${trimDecimal(value / 60)}${ko.common.minuteUnit}`;
  }

  return `${String(value)}${ko.common.secondUnit}`;
}

export function scopeKey(scope: KpiRollupScope | undefined) {
  if (!scope) {
    return "";
  }

  return scope.id ? `${scope.kind}:${scope.id}` : scope.kind;
}

function formatUtcDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function trimDecimal(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
