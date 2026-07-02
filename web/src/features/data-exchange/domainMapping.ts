import {
  dataExchangeHeaderHints,
  dataExchangeTargetFields,
} from "../../i18n/dataExchange";

export type ImportDomain =
  | "employee_hr"
  | "attendance_direct"
  | "payroll"
  | "organization"
  | "rbac"
  | "site_location"
  | "machinery_equipment"
  | "customer_vendor"
  | "mixed"
  | "unknown";

export type Sensitivity = "public" | "internal" | "personal" | "sensitive" | "restricted";

export interface TargetField {
  id: string;
  domain: Exclude<ImportDomain, "mixed" | "unknown">;
  label: string;
  sensitivity: Sensitivity;
  requiredPermission?: "hr_import" | "payroll_import" | "rbac_import" | "equipment_import";
}

export interface SourceColumnProfile {
  header: string;
  normalizedHeader: string;
  domain: ImportDomain;
  sensitivity: Sensitivity;
  compatibleTargetIds: string[];
}

export interface DatasetProfile {
  domain: ImportDomain;
  domains: Exclude<ImportDomain, "mixed" | "unknown">[];
  columns: SourceColumnProfile[];
  unmappedHeaders: string[];
  requiresDryRun: boolean;
}

const EXACT_HEADER_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  dataExchangeTargetFields.reduce<Record<string, string[]>>((acc, field) => {
    const key = normalizeHeader(field.label);
    acc[key] = [...(acc[key] ?? []), field.id];
    return acc;
  }, {}),
);

function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, "").toLowerCase();
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function listTargetFields(): readonly TargetField[] {
  return dataExchangeTargetFields;
}

function headerMatches(header: string, aliases: readonly string[]): boolean {
  const normalizedHeader = normalizeHeader(header);
  return aliases.some((alias) => normalizedHeader.includes(normalizeHeader(alias)));
}

export function profileSourceColumn(header: string): SourceColumnProfile {
  const normalizedHeader = normalizeHeader(header);
  const exactTargetIds = EXACT_HEADER_TARGETS[normalizedHeader] ?? [];
  const exactTargets = exactTargetIds
    .map((id) => dataExchangeTargetFields.find((field) => field.id === id))
    .filter((field): field is TargetField => Boolean(field));

  if (exactTargets.length > 0) {
    const domain = unique(exactTargets.map((field) => field.domain));
    return {
      header,
      normalizedHeader,
      domain: domain.length === 1 ? domain[0] : "mixed",
      sensitivity: mostRestrictiveSensitivity(exactTargets.map((field) => field.sensitivity)),
      compatibleTargetIds: exactTargets.map((field) => field.id),
    };
  }

  const hint = dataExchangeHeaderHints.find(({ aliases }) =>
    headerMatches(header, aliases),
  );
  if (!hint) {
    return {
      header,
      normalizedHeader,
      domain: "unknown",
      sensitivity: "internal",
      compatibleTargetIds: [],
    };
  }

  const targetIds =
    hint.targetIds.length > 0
      ? hint.targetIds
      : dataExchangeTargetFields
          .filter((field) => field.domain === hint.domain)
          .map((field) => field.id);

  return {
    header,
    normalizedHeader,
    domain: hint.domain,
    sensitivity: hint.sensitivity,
    compatibleTargetIds: [...targetIds],
  };
}

export function classifyDataset(headers: readonly string[]): DatasetProfile {
  const columns = headers.map(profileSourceColumn);
  const domains = unique(
    columns
      .map((column) => column.domain)
      .filter(
        (domain): domain is Exclude<ImportDomain, "mixed" | "unknown"> =>
          domain !== "mixed" && domain !== "unknown",
      ),
  );

  return {
    domain: domains.length === 0 ? "unknown" : domains.length === 1 ? domains[0] : "mixed",
    domains,
    columns,
    unmappedHeaders: columns
      .filter((column) => column.compatibleTargetIds.length === 0)
      .map((column) => column.header),
    requiresDryRun: columns.some(
      (column) => column.sensitivity === "sensitive" || column.sensitivity === "restricted",
    ),
  };
}

export function isMappingAllowed(header: string, targetFieldId: string): boolean {
  return profileSourceColumn(header).compatibleTargetIds.includes(targetFieldId);
}

function mostRestrictiveSensitivity(values: readonly Sensitivity[]): Sensitivity {
  const order: readonly Sensitivity[] = ["public", "internal", "personal", "sensitive", "restricted"];
  return values.reduce(
    (current, next) => (order.indexOf(next) > order.indexOf(current) ? next : current),
    "public",
  );
}
