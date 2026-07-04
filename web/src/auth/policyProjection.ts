export const POLICY_PROJECTION_AUTHORITY = "advisory_ui_only" as const;

export const ELEVATED_POLICY_FEATURES = [
  "role_manage",
  "elevated_role_grant",
] as const;

export type ElevatedPolicyFeature = (typeof ELEVATED_POLICY_FEATURES)[number];

export interface CedarPolicyProjectionClaim {
  policy_version?: string;
  subject_version?: string;
  engine_mode?: string;
  bundle_digest?: string;
  stale?: boolean;
  feature_grants?: readonly string[];
  elevated_decisions?: readonly string[];
}

export interface NonAuthoritativePolicyProjection {
  /**
   * Contract marker: this projection can only shape UX. It is never an
   * authorization decision and must not unlock RoleManage-tier surfaces.
   */
  authority: typeof POLICY_PROJECTION_AUTHORITY;
  sources: readonly ("jwt_feature_grants" | "cedar_projection")[];
  policy_version?: string;
  subject_version?: string;
  engine_mode?: string;
  bundle_digest?: string;
  stale: boolean;
  feature_grants: readonly string[];
  elevated_feature_hints: readonly ElevatedPolicyFeature[];
}

export interface PolicyProjectionCarrier {
  feature_grants?: readonly string[];
  policy_projection?: CedarPolicyProjectionClaim;
}

export function normalizeCedarPolicyProjectionClaim(
  raw: unknown,
): CedarPolicyProjectionClaim | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return {
    policy_version: stringClaim(record.policy_version),
    subject_version: stringClaim(record.subject_version),
    engine_mode: stringClaim(record.engine_mode),
    bundle_digest: stringClaim(record.bundle_digest),
    stale: record.stale === true,
    feature_grants: stringArrayClaim(record.feature_grants),
    elevated_decisions: stringArrayClaim(record.elevated_decisions),
  };
}

export function buildNonAuthoritativePolicyProjection(
  carrier: PolicyProjectionCarrier,
): NonAuthoritativePolicyProjection | undefined {
  const jwtGrants = stringArrayClaim(carrier.feature_grants);
  const cedarProjection = carrier.policy_projection;
  const cedarGrants = stringArrayClaim(cedarProjection?.feature_grants);
  const allGrants = uniqueStrings([...jwtGrants, ...cedarGrants]);
  const elevatedHints = elevatedFeatureHints([
    ...allGrants,
    ...stringArrayClaim(cedarProjection?.elevated_decisions),
  ]);
  const sources = [
    ...(jwtGrants.length > 0 ? (["jwt_feature_grants"] as const) : []),
    ...(cedarProjection ? (["cedar_projection"] as const) : []),
  ];

  if (sources.length === 0 && allGrants.length === 0) return undefined;

  return {
    authority: POLICY_PROJECTION_AUTHORITY,
    sources,
    policy_version: cedarProjection?.policy_version,
    subject_version: cedarProjection?.subject_version,
    engine_mode: cedarProjection?.engine_mode,
    bundle_digest: cedarProjection?.bundle_digest,
    stale: cedarProjection?.stale === true,
    feature_grants: allGrants,
    elevated_feature_hints: elevatedHints,
  };
}

export function projectionHasElevatedHint(
  projection: NonAuthoritativePolicyProjection | undefined,
  feature: ElevatedPolicyFeature,
): boolean {
  return projection?.elevated_feature_hints.includes(feature) ?? false;
}

export function policyProjectionCanAuthorize(
  projection: NonAuthoritativePolicyProjection | undefined,
  feature: string,
): false {
  void projection;
  void feature;
  return false;
}

function stringClaim(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function stringArrayClaim(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function elevatedFeatureHints(
  values: readonly string[],
): ElevatedPolicyFeature[] {
  const elevated = new Set<string>(ELEVATED_POLICY_FEATURES);
  return uniqueStrings(values).filter((value): value is ElevatedPolicyFeature =>
    elevated.has(value),
  );
}
