import { describe, expect, it } from "vitest";

import {
  buildNonAuthoritativePolicyProjection,
  normalizeCedarPolicyProjectionClaim,
  POLICY_PROJECTION_AUTHORITY,
  policyProjectionCanAuthorize,
  projectionHasElevatedHint,
} from "./policyProjection";

describe("policyProjection", () => {
  it("marks stale/elevated Cedar and JWT feature data as advisory-only", () => {
    const projection = buildNonAuthoritativePolicyProjection({
      feature_grants: ["mail_use", "role_manage"],
      policy_projection: {
        policy_version: "3",
        subject_version: "s2",
        stale: true,
        feature_grants: ["elevated_role_grant", "role_manage"],
        elevated_decisions: ["role_manage"],
        engine_mode: "cedar_shadow_legacy_enforce",
        bundle_digest: "sha256:x",
      },
    });

    expect(projection).toMatchObject({
      authority: POLICY_PROJECTION_AUTHORITY,
      sources: ["jwt_feature_grants", "cedar_projection"],
      policy_version: "3",
      subject_version: "s2",
      engine_mode: "cedar_shadow_legacy_enforce",
      bundle_digest: "sha256:x",
      stale: true,
      feature_grants: ["mail_use", "role_manage", "elevated_role_grant"],
    });
    expect(projectionHasElevatedHint(projection, "role_manage")).toBe(true);
    expect(projectionHasElevatedHint(projection, "elevated_role_grant")).toBe(
      true,
    );
    expect(policyProjectionCanAuthorize(projection, "role_manage")).toBe(false);
  });

  it("normalizes only explicit object/string claims", () => {
    expect(normalizeCedarPolicyProjectionClaim(undefined)).toBeUndefined();
    expect(normalizeCedarPolicyProjectionClaim(["role_manage"])).toBeUndefined();

    expect(
      normalizeCedarPolicyProjectionClaim({
        policy_version: 3,
        subject_version: "s2",
        engine_mode: "",
        stale: "true",
        feature_grants: ["mail_use", 1, "role_manage"],
        elevated_decisions: [false, "role_manage"],
      }),
    ).toEqual({
      policy_version: "3",
      subject_version: "s2",
      engine_mode: undefined,
      bundle_digest: undefined,
      stale: false,
      feature_grants: ["mail_use", "role_manage"],
      elevated_decisions: ["role_manage"],
    });
  });
});
