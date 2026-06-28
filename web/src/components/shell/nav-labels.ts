import { ko } from "../../i18n/ko";

const navLabels = ko.nav as Record<string, unknown>;
const navGroupLabels = ko.nav.groups as Record<string, string | undefined>;

export function navItemLabel(key: string): string {
  const label = navLabels[key];
  return typeof label === "string" ? label : key;
}

export function navGroupLabel(key: string): string {
  return navGroupLabels[key] ?? key;
}
