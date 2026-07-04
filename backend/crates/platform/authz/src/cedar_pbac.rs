//! Cedar/PBAC cutover contracts.
//!
//! This module is intentionally dependency-free: it does not pull in Cedar yet
//! and it is not on any live request path by itself. It gives later slices a
//! typed server-side boundary for Cedar authorization requests, compiled-bundle
//! cache identity, subject-freshness checks, and dual-engine fail-closed
//! semantics while preserving the existing legacy authorization functions.

use std::str::FromStr;

use mnt_kernel_core::{BranchId, KernelError, OrgId};

use crate::{Action, Feature, PermissionLevel, Principal, authorize, authorize_org_wide};

/// Mutable subject/version inputs that make stale subject material deny.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectFreshness {
    pub policy_version: u64,
    pub subject_version: u64,
    pub session_generation: u64,
    pub step_up_generation: Option<u64>,
}

impl SubjectFreshness {
    #[must_use]
    pub const fn has_subject_material(self) -> bool {
        self.policy_version > 0
            || self.subject_version > 0
            || self.session_generation > 0
            || self.step_up_generation.is_some()
    }

    #[must_use]
    pub const fn satisfies(self, required: SubjectFreshnessRequirement) -> bool {
        self.policy_version >= required.min_policy_version
            && self.subject_version >= required.min_subject_version
            && self.session_generation >= required.min_session_generation
            && match required.required_step_up_generation {
                Some(required_step_up) => match self.step_up_generation {
                    Some(actual_step_up) => actual_step_up >= required_step_up,
                    None => false,
                },
                None => true,
            }
    }
}

/// Minimum freshness the authorization boundary requires for this request.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectFreshnessRequirement {
    pub min_policy_version: u64,
    pub min_subject_version: u64,
    pub min_session_generation: u64,
    pub required_step_up_generation: Option<u64>,
}

impl SubjectFreshnessRequirement {
    #[must_use]
    pub const fn requires_subject_material(self) -> bool {
        self.min_policy_version > 0
            || self.min_subject_version > 0
            || self.min_session_generation > 0
            || self.required_step_up_generation.is_some()
    }
}

/// Server-loaded subject for a Cedar/PBAC authorization request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationSubject {
    pub principal: Principal,
    pub freshness: SubjectFreshness,
}

impl AuthorizationSubject {
    #[must_use]
    pub fn new(principal: Principal, freshness: SubjectFreshness) -> Self {
        Self {
            principal,
            freshness,
        }
    }
}

/// Server-loaded resource scope for authorization.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationResource {
    pub org_id: OrgId,
    pub branch_id: Option<BranchId>,
    pub resource_type: String,
    pub resource_id: Option<String>,
}

impl AuthorizationResource {
    #[must_use]
    pub fn branch(org_id: OrgId, branch_id: BranchId, resource_type: impl Into<String>) -> Self {
        Self {
            org_id,
            branch_id: Some(branch_id),
            resource_type: resource_type.into(),
            resource_id: None,
        }
    }

    #[must_use]
    pub fn org_wide(org_id: OrgId, resource_type: impl Into<String>) -> Self {
        Self {
            org_id,
            branch_id: None,
            resource_type: resource_type.into(),
            resource_id: None,
        }
    }

    #[must_use]
    pub fn with_resource_id(mut self, resource_id: impl Into<String>) -> Self {
        self.resource_id = Some(resource_id.into());
        self
    }
}

/// Non-authoritative context attributes supplied by the server boundary.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationContext {
    pub purpose: Option<String>,
    pub channel: Option<String>,
    pub request_id: Option<String>,
}

/// Evidence that DB reads used to build the Cedar request were performed under
/// an armed Postgres RLS scope. This is a typed witness for the cutover contract:
/// Cedar may decide capabilities/actions, but it never replaces `mnt_rt`/RLS row
/// isolation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RlsScopeProofSource {
    RuntimeRoleGuc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RlsScopeProof {
    pub org_id: OrgId,
    pub source: RlsScopeProofSource,
}

impl RlsScopeProof {
    #[must_use]
    pub const fn runtime_role_guc(org_id: OrgId) -> Self {
        Self {
            org_id,
            source: RlsScopeProofSource::RuntimeRoleGuc,
        }
    }
}

/// Typed authorization request used by both the legacy adapter and later Cedar
/// adapter. The server constructs this from verified token + DB-loaded facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationRequest {
    pub subject: AuthorizationSubject,
    pub action: Action,
    pub domain: String,
    pub resource: AuthorizationResource,
    pub context: AuthorizationContext,
    pub required_freshness: SubjectFreshnessRequirement,
    pub rls_scope_proof: Option<RlsScopeProof>,
}

impl AuthorizationRequest {
    #[must_use]
    pub fn new(principal: Principal, action: Action, resource: AuthorizationResource) -> Self {
        Self {
            subject: AuthorizationSubject::new(principal, SubjectFreshness::default()),
            action,
            domain: String::new(),
            resource,
            context: AuthorizationContext::default(),
            required_freshness: SubjectFreshnessRequirement::default(),
            rls_scope_proof: None,
        }
    }

    #[must_use]
    pub fn with_policy_domain(mut self, domain: impl Into<String>) -> Self {
        self.domain = domain.into();
        self
    }

    #[must_use]
    pub fn with_subject_freshness(mut self, freshness: SubjectFreshness) -> Self {
        self.subject.freshness = freshness;
        self
    }

    #[must_use]
    pub fn requiring_freshness(mut self, required: SubjectFreshnessRequirement) -> Self {
        self.required_freshness = required;
        self
    }

    #[must_use]
    pub fn with_rls_scope_proof(mut self, proof: RlsScopeProof) -> Self {
        self.rls_scope_proof = Some(proof);
        self
    }
}

/// Immutable identity for compiled Cedar bundle material.
///
/// This is the only v1 cache key shape. It identifies parsed/validated bundle
/// material, not an allow/deny decision.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub struct CompiledBundleCacheKey {
    pub org_id: OrgId,
    pub policy_version: u64,
    pub schema_version: String,
    pub bundle_digest: String,
    pub cedar_sdk_version: String,
    pub cedar_language_version: String,
}

impl CompiledBundleCacheKey {
    pub fn new(
        org_id: OrgId,
        policy_version: u64,
        schema_version: impl Into<String>,
        bundle_digest: impl Into<String>,
        cedar_sdk_version: impl Into<String>,
        cedar_language_version: impl Into<String>,
    ) -> Result<Self, KernelError> {
        let key = Self {
            org_id,
            policy_version,
            schema_version: non_empty("schema_version", schema_version.into())?,
            bundle_digest: non_empty("bundle_digest", bundle_digest.into())?,
            cedar_sdk_version: non_empty("cedar_sdk_version", cedar_sdk_version.into())?,
            cedar_language_version: non_empty(
                "cedar_language_version",
                cedar_language_version.into(),
            )?,
        };
        Ok(key)
    }
}

/// Explicit dual-engine migration mode from the coexistence map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DualEngineMode {
    LegacyOnly,
    CedarShadowLegacyEnforce,
    CedarEnforceLegacyCompare,
    CedarOnly,
}

impl FromStr for DualEngineMode {
    type Err = KernelError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw {
            "legacy_only" => Ok(Self::LegacyOnly),
            "cedar_shadow_legacy_enforce" => Ok(Self::CedarShadowLegacyEnforce),
            "cedar_enforce_legacy_compare" => Ok(Self::CedarEnforceLegacyCompare),
            "cedar_only" => Ok(Self::CedarOnly),
            _ => Err(KernelError::validation(format!(
                "unsupported Cedar/PBAC dual-engine mode: {raw}"
            ))),
        }
    }
}

/// One explicit coexistence-map entry for an enrolled action/domain.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoexistenceMapEntry {
    pub id: String,
    pub domain: String,
    pub feature: Feature,
    pub resource_type: String,
    pub mode: DualEngineMode,
    pub bundle_key: Option<CompiledBundleCacheKey>,
}

impl CoexistenceMapEntry {
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        domain: impl Into<String>,
        feature: Feature,
        resource_type: impl Into<String>,
        mode: DualEngineMode,
        bundle_key: Option<CompiledBundleCacheKey>,
    ) -> Self {
        Self {
            id: id.into(),
            domain: domain.into(),
            feature,
            resource_type: resource_type.into(),
            mode,
            bundle_key,
        }
    }

    #[must_use]
    pub fn matches_request(&self, request: &AuthorizationRequest) -> bool {
        !self.domain.trim().is_empty()
            && !request.domain.trim().is_empty()
            && self.domain == request.domain
            && self.feature == request.action.feature()
            && self.resource_type == request.resource.resource_type
    }
}

/// Stubbed Cedar adapter result. Later code replaces construction of this enum
/// with real Cedar SDK evaluation; the boundary semantics stay stable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CedarEvaluation {
    NotConfigured,
    Allow {
        bundle_key: CompiledBundleCacheKey,
    },
    Deny {
        bundle_key: CompiledBundleCacheKey,
        reason: String,
    },
    Error {
        reason: String,
    },
}

/// Final authorization effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionEffect {
    Allow,
    Deny,
}

impl DecisionEffect {
    #[must_use]
    pub const fn is_allow(self) -> bool {
        matches!(self, Self::Allow)
    }
}

/// Engine path responsible for the decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionEngine {
    BoundaryPreflight,
    Legacy,
    Cedar,
    DualEngine,
}

/// Machine-readable deny/allow reason for audit and metrics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionReason {
    LegacyAllowed,
    LegacyDenied,
    CedarAllowed,
    CedarDenied,
    CedarError,
    MissingCoexistenceMap,
    MalformedCoexistenceMap,
    BundleUnavailable,
    StalePolicyBundle,
    MissingSubjectFreshness,
    StaleSubject,
    MissingRlsScopeProof,
    RlsBoundaryMismatch,
    EngineDisagreement,
}

/// Auditable decision emitted by the boundary.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationDecision {
    pub effect: DecisionEffect,
    pub engine: DecisionEngine,
    pub reason: DecisionReason,
    pub mode: Option<DualEngineMode>,
}

impl AuthorizationDecision {
    #[must_use]
    pub const fn allow(
        engine: DecisionEngine,
        reason: DecisionReason,
        mode: Option<DualEngineMode>,
    ) -> Self {
        Self {
            effect: DecisionEffect::Allow,
            engine,
            reason,
            mode,
        }
    }

    #[must_use]
    pub const fn deny(
        engine: DecisionEngine,
        reason: DecisionReason,
        mode: Option<DualEngineMode>,
    ) -> Self {
        Self {
            effect: DecisionEffect::Deny,
            engine,
            reason,
            mode,
        }
    }
}

/// Low-cardinality labels for the Cedar/PBAC authorization metric.
///
/// Version and digest material intentionally stays on the audit event instead
/// of metric labels. That keeps the metric safe to emit on every decision while
/// the audit event carries the full forensic trail for stale-policy and
/// stale-subject investigations.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationMetricLabels {
    pub effect: DecisionEffect,
    pub engine: DecisionEngine,
    pub reason: DecisionReason,
    pub mode: Option<DualEngineMode>,
    pub domain: Option<String>,
}

/// Audit payload emitted with every Cedar/PBAC boundary decision.
///
/// This is a contract shape, not a live event sink. Later slices can hand this
/// to the existing audit writer after arming the request's RLS context. The
/// values are all server-derived so UI/JWT projections cannot fabricate an
/// authorization decision.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationAuditEvent {
    pub decision: AuthorizationDecision,
    pub coexistence_entry_id: Option<String>,
    pub domain: Option<String>,
    pub request_domain: String,
    pub action: String,
    pub required_permission: String,
    pub resource_type: String,
    pub resource_id: Option<String>,
    pub principal_org_id: OrgId,
    pub resource_org_id: OrgId,
    pub branch_id: Option<BranchId>,
    pub request_id: Option<String>,
    pub purpose: Option<String>,
    pub channel: Option<String>,
    pub subject_freshness: SubjectFreshness,
    pub required_freshness: SubjectFreshnessRequirement,
    pub rls_scope_proof: Option<RlsScopeProof>,
    /// Expected bundle identity from the coexistence map.
    pub bundle_key: Option<CompiledBundleCacheKey>,
    /// Actual bundle identity reported by Cedar evaluation, when Cedar returned
    /// a bundle-bearing result. This makes stale-policy investigations compare
    /// expected vs evaluated digests instead of losing the stale identity.
    pub evaluated_bundle_key: Option<CompiledBundleCacheKey>,
    /// Raw human-readable Cedar adapter denial/error text. The machine-readable
    /// `decision.reason` remains the stable audit/metric dimension; this detail
    /// preserves forensic context for triage without becoming a metric label.
    pub evaluated_reason_detail: Option<String>,
}

impl AuthorizationAuditEvent {
    #[must_use]
    pub fn metric_labels(&self) -> AuthorizationMetricLabels {
        AuthorizationMetricLabels {
            effect: self.decision.effect,
            engine: self.decision.engine,
            reason: self.decision.reason,
            mode: self.decision.mode,
            domain: self.domain.clone(),
        }
    }
}

/// Build the auditable/metric-ready observation for a boundary decision.
///
/// The caller supplies the already-computed decision so observation cannot
/// mutate enforcement. Missing map entries still produce an event with no
/// bundle key/domain, proving the failure was fail-closed rather than hidden.
#[must_use]
pub fn observe_cedar_pbac_decision(
    request: &AuthorizationRequest,
    map_entry: Option<&CoexistenceMapEntry>,
    cedar: Option<&CedarEvaluation>,
    decision: AuthorizationDecision,
) -> AuthorizationAuditEvent {
    AuthorizationAuditEvent {
        decision,
        coexistence_entry_id: map_entry.map(|entry| entry.id.clone()),
        domain: map_entry.map(|entry| entry.domain.clone()),
        request_domain: request.domain.clone(),
        action: request.action.feature().as_str().to_owned(),
        required_permission: permission_level_code(request.action.required_permission()).to_owned(),
        resource_type: request.resource.resource_type.clone(),
        resource_id: request.resource.resource_id.clone(),
        principal_org_id: request.subject.principal.org_id,
        resource_org_id: request.resource.org_id,
        branch_id: request.resource.branch_id,
        request_id: request.context.request_id.clone(),
        purpose: request.context.purpose.clone(),
        channel: request.context.channel.clone(),
        subject_freshness: request.subject.freshness,
        required_freshness: request.required_freshness,
        rls_scope_proof: request.rls_scope_proof,
        bundle_key: map_entry.and_then(|entry| entry.bundle_key.clone()),
        evaluated_bundle_key: cedar.and_then(cedar_evaluation_bundle_key),
        evaluated_reason_detail: cedar.and_then(cedar_evaluation_reason_detail),
    }
}

/// Evaluate the existing authorization behavior through the new typed contract.
///
/// This is the compatibility adapter: with default freshness and same-org
/// resources it delegates to the current `authorize` / `authorize_org_wide`
/// implementation.
#[must_use]
pub fn evaluate_legacy_contract(request: &AuthorizationRequest) -> AuthorizationDecision {
    if let Some(decision) = preflight_denial(request, None) {
        return decision;
    }

    let result = match request.resource.branch_id {
        Some(branch_id) => authorize(&request.subject.principal, request.action, branch_id),
        None => authorize_org_wide(&request.subject.principal, request.action),
    };

    match result {
        Ok(()) => AuthorizationDecision::allow(
            DecisionEngine::Legacy,
            DecisionReason::LegacyAllowed,
            Some(DualEngineMode::LegacyOnly),
        ),
        Err(_) => AuthorizationDecision::deny(
            DecisionEngine::Legacy,
            DecisionReason::LegacyDenied,
            Some(DualEngineMode::LegacyOnly),
        ),
    }
}

/// Evaluate an enrolled action through the explicit Cedar/PBAC coexistence map.
#[must_use]
pub fn evaluate_cedar_pbac_boundary(
    request: &AuthorizationRequest,
    map_entry: Option<&CoexistenceMapEntry>,
    cedar: CedarEvaluation,
) -> AuthorizationDecision {
    let Some(map_entry) = map_entry else {
        return AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::MissingCoexistenceMap,
            None,
        );
    };

    let mode = Some(map_entry.mode);
    if let Some(decision) = preflight_denial(request, mode) {
        return decision;
    }

    if !map_entry.matches_request(request) {
        return AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::MalformedCoexistenceMap,
            mode,
        );
    }

    if cedar_required(map_entry.mode)
        && let Some(decision) = cedar_precondition_denial(request, mode)
    {
        return decision;
    }

    if cedar_required(map_entry.mode) && map_entry.bundle_key.is_none() {
        return AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::BundleUnavailable,
            mode,
        );
    }

    match map_entry.mode {
        DualEngineMode::LegacyOnly => evaluate_legacy_contract(request),
        DualEngineMode::CedarShadowLegacyEnforce => {
            let cedar_shadow = cedar_decision(map_entry, &cedar, mode);
            if !cedar_shadow.effect.is_allow() {
                return cedar_shadow;
            }
            let legacy = evaluate_legacy_contract(request);
            if legacy.effect.is_allow() {
                AuthorizationDecision::allow(
                    DecisionEngine::DualEngine,
                    DecisionReason::LegacyAllowed,
                    mode,
                )
            } else {
                AuthorizationDecision::deny(
                    DecisionEngine::DualEngine,
                    DecisionReason::LegacyDenied,
                    mode,
                )
            }
        }
        DualEngineMode::CedarEnforceLegacyCompare => {
            let cedar_decision = cedar_decision(map_entry, &cedar, mode);
            if !cedar_decision.effect.is_allow() {
                return cedar_decision;
            }
            let legacy = evaluate_legacy_contract(request);
            if legacy.effect.is_allow() {
                AuthorizationDecision::allow(
                    DecisionEngine::DualEngine,
                    DecisionReason::CedarAllowed,
                    mode,
                )
            } else {
                AuthorizationDecision::deny(
                    DecisionEngine::DualEngine,
                    DecisionReason::EngineDisagreement,
                    mode,
                )
            }
        }
        DualEngineMode::CedarOnly => cedar_decision(map_entry, &cedar, mode),
    }
}

fn cedar_evaluation_bundle_key(cedar: &CedarEvaluation) -> Option<CompiledBundleCacheKey> {
    match cedar {
        CedarEvaluation::Allow { bundle_key } | CedarEvaluation::Deny { bundle_key, .. } => {
            Some(bundle_key.clone())
        }
        CedarEvaluation::Error { .. } | CedarEvaluation::NotConfigured => None,
    }
}

fn cedar_evaluation_reason_detail(cedar: &CedarEvaluation) -> Option<String> {
    match cedar {
        CedarEvaluation::Deny { reason, .. } | CedarEvaluation::Error { reason } => {
            Some(reason.clone())
        }
        CedarEvaluation::Allow { .. } | CedarEvaluation::NotConfigured => None,
    }
}

fn cedar_precondition_denial(
    request: &AuthorizationRequest,
    mode: Option<DualEngineMode>,
) -> Option<AuthorizationDecision> {
    if !request.subject.freshness.has_subject_material()
        || !request.required_freshness.requires_subject_material()
    {
        return Some(AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::MissingSubjectFreshness,
            mode,
        ));
    }

    let Some(proof) = request.rls_scope_proof else {
        return Some(AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::MissingRlsScopeProof,
            mode,
        ));
    };

    if proof.org_id != request.subject.principal.org_id || proof.org_id != request.resource.org_id {
        return Some(AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::RlsBoundaryMismatch,
            mode,
        ));
    }

    None
}

fn preflight_denial(
    request: &AuthorizationRequest,
    mode: Option<DualEngineMode>,
) -> Option<AuthorizationDecision> {
    if request.subject.principal.org_id != request.resource.org_id {
        return Some(AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::RlsBoundaryMismatch,
            mode,
        ));
    }

    if !request
        .subject
        .freshness
        .satisfies(request.required_freshness)
    {
        return Some(AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::StaleSubject,
            mode,
        ));
    }

    None
}

const fn cedar_required(mode: DualEngineMode) -> bool {
    matches!(
        mode,
        DualEngineMode::CedarShadowLegacyEnforce
            | DualEngineMode::CedarEnforceLegacyCompare
            | DualEngineMode::CedarOnly
    )
}

fn cedar_matches_map(map_entry: &CoexistenceMapEntry, cedar: &CedarEvaluation) -> bool {
    match (map_entry.bundle_key.as_ref(), cedar) {
        (Some(expected), CedarEvaluation::Allow { bundle_key })
        | (Some(expected), CedarEvaluation::Deny { bundle_key, .. }) => expected == bundle_key,
        (_, CedarEvaluation::Error { .. }) => true,
        (_, CedarEvaluation::NotConfigured) => false,
        (None, _) => false,
    }
}

fn cedar_decision(
    map_entry: &CoexistenceMapEntry,
    cedar: &CedarEvaluation,
    mode: Option<DualEngineMode>,
) -> AuthorizationDecision {
    if matches!(cedar, CedarEvaluation::NotConfigured) {
        return AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::BundleUnavailable,
            mode,
        );
    }

    if !cedar_matches_map(map_entry, cedar) {
        return AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::StalePolicyBundle,
            mode,
        );
    }

    match cedar {
        CedarEvaluation::Allow { .. } => {
            AuthorizationDecision::allow(DecisionEngine::Cedar, DecisionReason::CedarAllowed, mode)
        }
        CedarEvaluation::Deny { .. } => {
            AuthorizationDecision::deny(DecisionEngine::Cedar, DecisionReason::CedarDenied, mode)
        }
        CedarEvaluation::Error { .. } => {
            AuthorizationDecision::deny(DecisionEngine::Cedar, DecisionReason::CedarError, mode)
        }
        CedarEvaluation::NotConfigured => AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::BundleUnavailable,
            mode,
        ),
    }
}

fn non_empty(field: &str, value: String) -> Result<String, KernelError> {
    if value.trim().is_empty() {
        Err(KernelError::validation(format!(
            "compiled Cedar bundle cache key missing {field}"
        )))
    } else {
        Ok(value)
    }
}

const fn permission_level_code(permission: PermissionLevel) -> &'static str {
    match permission {
        PermissionLevel::Deny => "deny",
        PermissionLevel::RequestOnly => "request_only",
        PermissionLevel::Limited => "limited",
        PermissionLevel::Allow => "allow",
    }
}
