//! Ontology REST API — the §18 registry surface + the §2/§16 single mutation
//! path (action preflight / execute) that serves humans and automation alike.
//!
//! The object-type and instance endpoints are thin pass-throughs over the
//! registry + instance stores (which already own RLS + audit + fixity). The
//! action `preflight` / `execute` endpoints are the substance of this lane:
//!
//!  * `preflight` resolves the action, runs the §16 gate chain (authority via the
//!    legacy authorization contract → self-checklist → four-eyes read from the DB
//!    → egress derived from side effects) and returns each gate's status WITHOUT
//!    committing anything;
//!  * `execute` runs the same chain, and if it allows, opens ONE `with_audits`
//!    writeback transaction that **re-checks** the mutable gate (four-eyes) inside
//!    the tx (TOCTOU-safe), then dispatches: an `instance_revision` action appends
//!    a fixity-chained revision through the instance store's in-tx helper; a
//!    `projected_usecase` action routes through the [`ProjectedDispatchRegistry`]
//!    into the OWNING domain crate's use-case (which owns its own RLS, audit, and
//!    transaction) — the engine never writes a domain table itself (§9.3, no second
//!    source of truth); an unknown `dispatch_target` fails closed.
//!
//! `router(state)` self-applies `with_request_context`; `build_router` merges it
//! (L-WIRE), this crate does not.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_governance_adapter_postgres::{
    PgGovernanceError, PgGovernanceStore, authority_effect_from_cedar, four_eyes_approved_conn,
};
use mnt_governance_domain::{
    AuthorityEffect, GateChainConfig, GateChainOutcome, GateEvidence, LifecycleState,
    evaluate_gate_chain, validate_lifecycle_transition,
};
use mnt_kernel_core::{AuditAction, AuditEvent, ErrorKind, KernelError, TraceContext};
use mnt_ontology_adapter_postgres::instances::{
    CreateInstance, InstanceHead, InstanceState, PgInstanceStore, RevisionSummary, StageRevision,
    TraversalGraph, create_instance_in_tx, stage_revision_in_tx,
};
use mnt_ontology_adapter_postgres::{
    ActingRule, ActionTypeSummary, CreateObjectTypeDraft, ObjectTypeDetail, ObjectTypeSummary,
    PgOntologyError, PgOntologyStore, ResolvedInstance,
};
use mnt_ontology_application::{
    ActionDispatch, apply_edits, egress_evidence, evaluate_submission_criteria, evaluation_context,
    parse_control_points, validate_params,
};
use mnt_ontology_domain::{InstanceId, InstanceLifecycleState, LinkTypeId, ObjectTypeId};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::cedar_pbac::evaluate_legacy_contract;
use mnt_platform_authz::{
    Action, AuthorizationRequest, AuthorizationResource, Feature, Principal, authorize_org_wide,
};
use mnt_platform_db::{DbError, with_audits};
use mnt_platform_request_context::current_org;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use time::OffsetDateTime;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// State + router
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct OntologyRestState {
    registry: PgOntologyStore,
    instances: PgInstanceStore,
    governance: PgGovernanceStore,
    jwt_verifier: Option<JwtVerifier>,
    /// Routes a `projected_usecase` action to the OWNING domain crate's use-case.
    /// Empty by default ⇒ every projected dispatch fails closed (`NotWiredYet`),
    /// preserving the pre-wire dark behavior. The App composition root installs
    /// the real handlers via [`Self::with_projected_dispatch`].
    projected_dispatch: ProjectedDispatchRegistry,
}

impl OntologyRestState {
    #[must_use]
    pub fn new(
        registry: PgOntologyStore,
        instances: PgInstanceStore,
        governance: PgGovernanceStore,
        jwt_verifier: Option<JwtVerifier>,
    ) -> Self {
        Self {
            registry,
            instances,
            governance,
            jwt_verifier,
            projected_dispatch: ProjectedDispatchRegistry::new(),
        }
    }

    /// Install the projected-dispatch registry (target → domain use-case). Supplied
    /// by the App tier, which alone may depend on the domain adapters; the ontology
    /// REST tier stays free of a domain-adapter edge (dependency inversion, exactly
    /// like `TenantConfigSeeder`). An unregistered target still fails closed.
    #[must_use]
    pub fn with_projected_dispatch(mut self, registry: ProjectedDispatchRegistry) -> Self {
        self.projected_dispatch = registry;
        self
    }
}

// ---------------------------------------------------------------------------
// Projected dispatch registry (§18 D1/D2, arch §1a + §9.3)
// ---------------------------------------------------------------------------

/// Everything a domain use-case needs to service one `projected_usecase` action,
/// resolved from the action + command (HTTP-independent). The engine performs NO
/// writeback of its own for a projected action; the handler routes into the owning
/// domain crate's use-case, which owns its RLS + audit + transaction (§9.3: never a
/// second source of truth). Tenant scope is ambient via `app.current_org`
/// (the caller already scoped it), so no org travels in this struct.
#[derive(Debug, Clone)]
pub struct ProjectedDispatch {
    /// The signed-in principal (actor + org + scope) for the domain command.
    pub principal: Principal,
    /// The `dispatch_target` key the registry routes on (e.g. `registry.update_equipment`).
    pub target: String,
    /// The projected entity's primary key (equipment id, work-order id, …) — the
    /// domain row the action targets. `None` for a create-style projected action.
    pub target_id: Option<Uuid>,
    /// Validated action params (the edit values) for the domain command.
    pub params: Value,
    /// Optional caller reason, forwarded to the domain audit trail.
    pub reason: Option<String>,
    /// Deterministic occurrence time for the domain audit event.
    pub occurred_at: OffsetDateTime,
}

/// One projected-dispatch handler: an async adapter that invokes the owning
/// domain use-case. Returns a JSON summary of the domain result (opaque to the
/// engine) or a typed [`ActionError`] (fail-closed).
pub type ProjectedHandler = Arc<
    dyn Fn(ProjectedDispatch) -> Pin<Box<dyn Future<Output = Result<Value, ActionError>> + Send>>
        + Send
        + Sync,
>;

/// Maps each `dispatch_target` to its domain-use-case handler. Owns the
/// fail-closed contract: an **unknown target is a typed `NotWiredYet` error**, so
/// a mis-seeded or not-yet-wired action can never silently no-op or write.
#[derive(Clone, Default)]
pub struct ProjectedDispatchRegistry {
    handlers: HashMap<String, ProjectedHandler>,
}

impl ProjectedDispatchRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a handler for one `dispatch_target`. Chainable builder.
    #[must_use]
    pub fn register(mut self, target: impl Into<String>, handler: ProjectedHandler) -> Self {
        self.handlers.insert(target.into(), handler);
        self
    }

    /// Route to the target's handler, or fail closed on an unknown target.
    async fn dispatch(&self, input: ProjectedDispatch) -> Result<Value, ActionError> {
        match self.handlers.get(&input.target) {
            Some(handler) => handler(input).await,
            None => Err(ActionError::NotWiredYet {
                target: Some(input.target),
            }),
        }
    }
}

pub const OBJECT_TYPES_PATH: &str = "/api/v1/ontology/object-types";
pub const OBJECT_TYPE_KEY_PATH: &str = "/api/v1/ontology/object-types/{key}";
pub const INSTANCES_PATH: &str = "/api/v1/ontology/instances";
pub const INSTANCE_ID_PATH: &str = "/api/v1/ontology/instances/{id}";
pub const INSTANCE_HISTORY_PATH: &str = "/api/v1/ontology/instances/{id}/history";
pub const INSTANCE_TRAVERSE_PATH: &str = "/api/v1/ontology/instances/{id}/traverse";
pub const INSTANCE_LIFECYCLE_PATH: &str = "/api/v1/ontology/instances/{id}/lifecycle";
pub const INSTANCE_ACTING_PATH: &str = "/api/v1/ontology/instances/{id}/acting";
pub const RESOLVE_PATH: &str = "/api/v1/ontology/resolve";
pub const ACTION_PREFLIGHT_PATH: &str = "/api/v1/ontology/actions/{action_key}/preflight";
pub const ACTION_EXECUTE_PATH: &str = "/api/v1/ontology/actions/{action_key}/execute";

pub const ONTOLOGY_ROUTE_PATHS: &[&str] = &[
    OBJECT_TYPES_PATH,
    OBJECT_TYPE_KEY_PATH,
    INSTANCES_PATH,
    INSTANCE_ID_PATH,
    INSTANCE_HISTORY_PATH,
    INSTANCE_TRAVERSE_PATH,
    INSTANCE_LIFECYCLE_PATH,
    INSTANCE_ACTING_PATH,
    RESOLVE_PATH,
    ACTION_PREFLIGHT_PATH,
    ACTION_EXECUTE_PATH,
];

pub fn router(state: OntologyRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.registry.pool().clone();
    let router = Router::new()
        .route(
            OBJECT_TYPES_PATH,
            get(list_object_types).post(create_object_type),
        )
        .route(
            OBJECT_TYPE_KEY_PATH,
            get(get_object_type).put(stage_object_type_revision),
        )
        .route(INSTANCES_PATH, get(list_instances))
        .route(INSTANCE_ID_PATH, get(get_instance))
        .route(INSTANCE_HISTORY_PATH, get(get_instance_history))
        .route(INSTANCE_TRAVERSE_PATH, get(traverse_instance))
        .route(INSTANCE_LIFECYCLE_PATH, post(commit_lifecycle))
        .route(INSTANCE_ACTING_PATH, get(instance_acting))
        .route(RESOLVE_PATH, get(resolve_code))
        .route(ACTION_PREFLIGHT_PATH, post(action_preflight))
        .route(ACTION_EXECUTE_PATH, post(action_execute))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

// ---------------------------------------------------------------------------
// Registry surface (thin over PgOntologyStore)
// ---------------------------------------------------------------------------

async fn list_object_types(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ObjectTypeSummary>>, RestError> {
    authorize_ontology(&state, &headers).await?;
    let types = state
        .registry
        .list_object_types()
        .await
        .map_err(RestError::from_ontology)?;
    Ok(Json(types))
}

async fn create_object_type(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Json(draft): Json<CreateObjectTypeDraft>,
) -> Result<impl IntoResponse, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let summary = state
        .registry
        .create_object_type(
            principal.user_id,
            draft,
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(RestError::from_ontology)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

#[derive(Debug, Deserialize)]
struct ObjectTypeVersionQuery {
    #[serde(default)]
    version: Option<i64>,
}

async fn get_object_type(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Query(query): Query<ObjectTypeVersionQuery>,
) -> Result<Json<ObjectTypeDetail>, RestError> {
    authorize_ontology(&state, &headers).await?;
    let detail = state
        .registry
        .get_object_type(&key, query.version)
        .await
        .map_err(RestError::from_ontology)?;
    Ok(Json(detail))
}

async fn stage_object_type_revision(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(draft): Json<CreateObjectTypeDraft>,
) -> Result<impl IntoResponse, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let summary = state
        .registry
        .stage_revision(
            principal.user_id,
            &key,
            draft,
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(RestError::from_ontology)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

// ---------------------------------------------------------------------------
// Instance surface (thin over PgInstanceStore)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct InstanceListQuery {
    /// Object-type VERSION id (0105 head) whose current-state instances to list.
    r#type: Uuid,
}

async fn list_instances(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Query(query): Query<InstanceListQuery>,
) -> Result<Json<Vec<InstanceState>>, RestError> {
    authorize_ontology(&state, &headers).await?;
    let list = state
        .instances
        .list_instances(ObjectTypeId::from_uuid(query.r#type))
        .await
        .map_err(RestError::from_ontology)?;
    Ok(Json(list))
}

#[derive(Debug, Deserialize)]
struct AsOfQuery {
    /// RFC3339 instant for a bi-temporal as-of read; absent = current head.
    #[serde(default, with = "time::serde::rfc3339::option")]
    as_of: Option<OffsetDateTime>,
}

async fn get_instance(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<AsOfQuery>,
) -> Result<Json<InstanceState>, RestError> {
    authorize_ontology(&state, &headers).await?;
    let instance_id = InstanceId::from_uuid(id);
    let instance = match query.as_of {
        Some(at) => state.instances.get_as_of(instance_id, at).await,
        None => state.instances.get_current(instance_id).await,
    }
    .map_err(RestError::from_ontology)?;
    Ok(Json(instance))
}

async fn get_instance_history(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<RevisionSummary>>, RestError> {
    authorize_ontology(&state, &headers).await?;
    let history = state
        .instances
        .history(InstanceId::from_uuid(id))
        .await
        .map_err(RestError::from_ontology)?;
    Ok(Json(history))
}

#[derive(Debug, Deserialize)]
struct TraverseQuery {
    #[serde(default)]
    link_type: Option<Uuid>,
    #[serde(default = "default_depth")]
    depth: u32,
}

const fn default_depth() -> u32 {
    2
}

async fn traverse_instance(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<TraverseQuery>,
) -> Result<Json<TraversalGraph>, RestError> {
    authorize_ontology(&state, &headers).await?;
    let graph = state
        .instances
        .traverse(
            InstanceId::from_uuid(id),
            query.link_type.map(LinkTypeId::from_uuid),
            query.depth,
        )
        .await
        .map_err(RestError::from_ontology)?;
    Ok(Json(graph))
}

// ---------------------------------------------------------------------------
// Action preflight / execute (§2 single mutation path, §16 gate chain)
// ---------------------------------------------------------------------------

/// Typed action command (HTTP-independent) shared by preflight + execute, so the
/// same single mutation path is drivable from a test / automation caller without
/// a live HTTP request. `object_type_id` disambiguates the `action_key` (an action
/// key is unique only per object type); the target is `instance_id` for an edit,
/// or absent for a create (which then needs a `title`).
#[derive(Debug, Clone)]
pub struct ActionCommand {
    pub object_type_id: ObjectTypeId,
    pub instance_id: Option<InstanceId>,
    pub title: Option<String>,
    pub params: Value,
    pub reason: Option<String>,
    pub valid_from: Option<OffsetDateTime>,
    /// Client-supplied self-checklist acknowledgement (there is no checklist
    /// object store yet; §16 gate 2 reads this witness, fail-closed when absent).
    pub checklist_all_acknowledged: Option<bool>,
    /// Four-eyes request ref; its decision is read from the DB, never trusted
    /// from the caller.
    pub four_eyes_request_ref: Option<Uuid>,
}

/// The HTTP body for both preflight and execute (JSON with bare UUIDs); converted
/// to a typed [`ActionCommand`] before it touches the orchestration.
#[derive(Debug, Deserialize)]
struct ActionRequest {
    object_type_id: Uuid,
    #[serde(default)]
    instance_id: Option<Uuid>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    valid_from: Option<OffsetDateTime>,
    #[serde(default)]
    checklist_all_acknowledged: Option<bool>,
    #[serde(default)]
    four_eyes_request_ref: Option<Uuid>,
}

impl ActionRequest {
    fn into_command(self) -> ActionCommand {
        ActionCommand {
            object_type_id: ObjectTypeId::from_uuid(self.object_type_id),
            instance_id: self.instance_id.map(InstanceId::from_uuid),
            title: self.title,
            params: self.params,
            reason: self.reason,
            valid_from: self.valid_from,
            checklist_all_acknowledged: self.checklist_all_acknowledged,
            four_eyes_request_ref: self.four_eyes_request_ref,
        }
    }
}

/// Outcome of a preflight — each gate's status plus whether submit criteria hold,
/// without committing anything.
#[derive(Debug, Clone, Serialize)]
pub struct PreflightOutcome {
    pub dispatch: ActionDispatch,
    pub dispatch_target: Option<String>,
    pub config: GateChainConfig,
    pub gates: GateChainOutcome,
    pub criteria_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub criteria_error: Option<String>,
    /// Would `execute` proceed? (gates allow AND criteria hold).
    pub would_execute: bool,
}

/// Outcome of a successful execute — the gate chain that admitted it plus the
/// dispatch result. Exactly one of `instance` / `projected` is populated per the
/// `dispatch` kind; both are `Option` so the serialized shape stays backward-
/// compatible (an `instance_revision` result still carries the same top-level
/// `instance` key it always did — the console reads it unchanged).
#[derive(Debug, Clone, Serialize)]
pub struct ExecuteOutcome {
    pub dispatch: ActionDispatch,
    pub gates: GateChainOutcome,
    /// The appended revision head — present for an `instance_revision` dispatch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<InstanceState>,
    /// The domain use-case's JSON summary — present for a `projected_usecase`
    /// dispatch (the engine wrote nothing; the owning domain crate did).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected: Option<Value>,
}

/// Typed action failure, distinct from a raw DB error so callers (and tests) can
/// tell a gate deny from a not-yet-wired dispatch from a validation failure.
#[derive(Debug)]
pub enum ActionError {
    /// No action of that key on the given object type (or cross-tenant → hidden).
    NotFound,
    /// Params / control-point / edit shape rejected (fail-closed).
    Validation(String),
    /// A §16 gate blocked the action; nothing was written.
    GateDenied(String),
    /// A submission criterion did not hold; nothing was written.
    CriteriaFailed(String),
    /// A `projected_usecase` action whose `dispatch_target` has no registered
    /// domain handler (unwired or misconfigured). Fail-closed: no table write.
    NotWiredYet { target: Option<String> },
    /// A store / DB / context error.
    Store(PgOntologyError),
}

impl ActionError {
    /// Wrap a domain use-case's [`KernelError`] as a projected-dispatch failure,
    /// preserving its kind so the REST layer maps it to the right status (a domain
    /// `forbidden`/`conflict`/`not_found` stays a 403/409/404). The canonical way a
    /// [`ProjectedHandler`] surfaces a domain rejection without depending on the
    /// ontology adapter's error type.
    #[must_use]
    pub fn domain(error: KernelError) -> Self {
        Self::Store(PgOntologyError::Domain(error))
    }
}

/// Everything resolved for an action request, shared by preflight + execute.
struct Prepared {
    action: ActionTypeSummary,
    config: GateChainConfig,
    params: Value,
    base_attrs: Value,
    criteria: Result<(), KernelError>,
}

impl OntologyRestState {
    /// Preflight an action: resolve it, run the §16 gate chain and evaluate submit
    /// criteria, and report the per-gate status WITHOUT committing anything.
    pub async fn preflight_action(
        &self,
        principal: &Principal,
        action_key: &str,
        command: ActionCommand,
    ) -> Result<PreflightOutcome, ActionError> {
        let prepared = self.prepare(action_key, &command).await?;
        let gates = self.evaluate_gates(principal, &prepared, &command).await?;
        let criteria_ok = prepared.criteria.is_ok();
        let criteria_error = prepared.criteria.as_ref().err().map(|e| e.message.clone());
        Ok(PreflightOutcome {
            dispatch: prepared.action.dispatch,
            dispatch_target: prepared.action.dispatch_target.clone(),
            config: prepared.config,
            would_execute: gates.allow && criteria_ok,
            gates,
            criteria_ok,
            criteria_error,
        })
    }

    /// Execute an action — the core single mutation path for humans + automation.
    /// Fail-closed: an unmet gate, a failed submit criterion, or a malformed edit
    /// denies BEFORE any writeback opens. `instance_revision` then appends a
    /// fixity-chained revision inside one audited tx that re-checks the mutable
    /// gate; `projected_usecase` routes to the owning domain use-case via the
    /// [`ProjectedDispatchRegistry`] (unknown target ⇒ [`ActionError::NotWiredYet`]).
    pub async fn execute_action(
        &self,
        principal: &Principal,
        action_key: &str,
        command: ActionCommand,
    ) -> Result<ExecuteOutcome, ActionError> {
        let prepared = self.prepare(action_key, &command).await?;

        // Fail-closed pre-tx: an unmet gate / failed criterion writes nothing.
        let gates = self.evaluate_gates(principal, &prepared, &command).await?;
        if !gates.allow {
            let reason = gates.first_blocking().map_or_else(
                || "an action gate is not satisfied".to_owned(),
                |g| format!("gate {:?} blocked: {:?}", g.gate, g.status),
            );
            return Err(ActionError::GateDenied(reason));
        }
        if let Err(err) = &prepared.criteria {
            return Err(ActionError::CriteriaFailed(err.message.clone()));
        }

        match prepared.action.dispatch {
            ActionDispatch::ProjectedUsecase => {
                // No engine writeback: route to the owning domain crate's use-case,
                // which owns its own RLS + audit + tx (§9.3 — no second source of
                // truth). An unwired/unknown target fails closed (`NotWiredYet`).
                //
                // The §16 gate chain was already enforced fail-closed above. TOCTOU-
                // safety of the domain MUTATION is the domain use-case's own
                // responsibility and varies by use-case (a work-order transition
                // locks its row + guards the from-state; an equipment update is
                // last-write-wins with non-destructive version capture) — the engine
                // makes no claim about it here.
                //
                // Fail-closed on config the engine cannot honor: in v1 the engine
                // cannot read a projected domain row generically, so a submission
                // criterion (which would evaluate against an EMPTY base and could
                // silently pass — fail-open) is not faithfully evaluable for a
                // projected action. Reject it rather than dispatch on a criterion we
                // did not really check. Params-scoped projected criteria return with
                // the projected-state-read follow-up.
                if prepared
                    .action
                    .submission_criteria
                    .as_array()
                    .is_some_and(|criteria| !criteria.is_empty())
                {
                    return Err(ActionError::CriteriaFailed(
                        "submission criteria are not evaluable for a projected_usecase \
                         action in v1 (the engine cannot read the projected domain row); \
                         nothing was dispatched"
                            .to_owned(),
                    ));
                }
                let target = prepared.action.dispatch_target.clone().ok_or(
                    // A projected action with no target can never resolve a handler.
                    ActionError::NotWiredYet { target: None },
                )?;
                let projected = self
                    .projected_dispatch
                    .dispatch(ProjectedDispatch {
                        principal: principal.clone(),
                        target,
                        target_id: command.instance_id.map(|id| *id.as_uuid()),
                        params: prepared.params.clone(),
                        reason: command.reason.clone(),
                        occurred_at: OffsetDateTime::now_utc(),
                    })
                    .await?;
                Ok(ExecuteOutcome {
                    dispatch: ActionDispatch::ProjectedUsecase,
                    gates,
                    instance: None,
                    projected: Some(projected),
                })
            }
            ActionDispatch::InstanceRevision => {
                // Resolve the declarative edits into the new attribute bag.
                let new_attrs = apply_edits(
                    &prepared.action.edits,
                    &prepared.params,
                    &prepared.base_attrs,
                )
                .map_err(|e| ActionError::Validation(e.message))?;
                let instance = self
                    .execute_instance_revision(
                        principal, action_key, &command, &prepared, new_attrs,
                    )
                    .await
                    .map_err(ActionError::Store)?;
                Ok(ExecuteOutcome {
                    dispatch: ActionDispatch::InstanceRevision,
                    gates,
                    instance: Some(instance),
                    projected: None,
                })
            }
        }
    }

    /// Resolve the action, validate params, load the target's current attributes,
    /// evaluate submission criteria — the deterministic prep both paths share.
    async fn prepare(
        &self,
        action_key: &str,
        command: &ActionCommand,
    ) -> Result<Prepared, ActionError> {
        let action = self
            .registry
            .get_action_type(command.object_type_id, action_key)
            .await
            .map_err(ActionError::Store)?
            .ok_or(ActionError::NotFound)?;

        let config = parse_control_points(&action.control_points)
            .map_err(|e| ActionError::Validation(e.message))?;
        let params = validate_params(&action.params_schema, &command.params)
            .map_err(|e| ActionError::Validation(e.message))?;

        // Load the edit target's current attributes (empty for a create) so submit
        // criteria can read both the pending params and the object's current state.
        // Only an `instance_revision` target lives in `ont_instances`; a projected
        // action's target_id is a DOMAIN row (equipment, work order, …) that the
        // engine does not own, so we never resolve it here (submit criteria for a
        // projected action read params only).
        let base_attrs = match (action.dispatch, command.instance_id) {
            (ActionDispatch::InstanceRevision, Some(id)) => {
                self.instances
                    .get_current(id)
                    .await
                    .map_err(ActionError::Store)?
                    .revision
                    .attributes
            }
            _ => Value::Object(serde_json::Map::new()),
        };

        let context = evaluation_context(&base_attrs, &params);
        let criteria = evaluate_submission_criteria(&action.submission_criteria, &context);

        Ok(Prepared {
            action,
            config,
            params,
            base_attrs,
            criteria,
        })
    }

    /// Gather gate evidence and evaluate the chain. Authority is the legacy
    /// authorization contract's effect (the sole enforcer today; the seam is
    /// `authority_effect_from_cedar`); four-eyes is read from the DB; egress is
    /// derived from declared side effects; checklist is client-supplied.
    async fn evaluate_gates(
        &self,
        principal: &Principal,
        prepared: &Prepared,
        command: &ActionCommand,
    ) -> Result<GateChainOutcome, ActionError> {
        let authority = authority_effect(principal);
        let four_eyes_approved = match command.four_eyes_request_ref {
            Some(request_ref) => self
                .governance
                .four_eyes_approved(request_ref)
                .await
                .map_err(|e| ActionError::Store(governance_to_ontology(e)))?,
            None => None,
        };
        let evidence = GateEvidence {
            authority: Some(authority),
            checklist_all_acknowledged: command.checklist_all_acknowledged,
            four_eyes_approved,
            egress_cleared: egress_evidence(&prepared.action.side_effects),
        };
        Ok(evaluate_gate_chain(prepared.config, &evidence))
    }

    async fn execute_instance_revision(
        &self,
        principal: &Principal,
        action_key: &str,
        command: &ActionCommand,
        prepared: &Prepared,
        new_attrs: Value,
    ) -> Result<InstanceState, PgOntologyError> {
        instance_revision_writeback(self, principal, action_key, command, prepared, new_attrs).await
    }
}

/// The §16 Authority gate input: today the legacy role matrix is the sole
/// enforcer, evaluated through the typed authorization contract and mapped onto
/// the gate's [`AuthorityEffect`] via the governance seam. Ontology is an
/// org-scoped admin surface, so this authorizes org-wide `RoleManage` (matching
/// the governance console); L-WIRE may introduce a dedicated ontology feature.
fn authority_effect(principal: &Principal) -> AuthorityEffect {
    let request = AuthorizationRequest::new(
        principal.clone(),
        Action::new(Feature::RoleManage),
        AuthorizationResource::org_wide(principal.org_id, "ontology_action"),
    );
    authority_effect_from_cedar(evaluate_legacy_contract(&request).effect)
}

async fn action_preflight(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(action_key): Path<String>,
    Json(body): Json<ActionRequest>,
) -> Result<Json<PreflightOutcome>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let outcome = state
        .preflight_action(&principal, &action_key, body.into_command())
        .await
        .map_err(RestError::from_action)?;
    Ok(Json(outcome))
}

async fn action_execute(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(action_key): Path<String>,
    Json(body): Json<ActionRequest>,
) -> Result<Json<ExecuteOutcome>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let outcome = state
        .execute_action(&principal, &action_key, body.into_command())
        .await
        .map_err(RestError::from_action)?;
    Ok(Json(outcome))
}

/// The instance-revision writeback: ONE `with_audits` tx that re-checks the
/// mutable gate (four-eyes) INSIDE the tx (TOCTOU-safe), then appends the
/// revision through the store's in-tx helper and writes the action's audit row —
/// all atomic. A re-check failure returns `Err` so the tx rolls back with zero
/// rows written.
async fn instance_revision_writeback(
    state: &OntologyRestState,
    principal: &Principal,
    action_key: &str,
    command: &ActionCommand,
    prepared: &Prepared,
    new_attrs: Value,
) -> Result<InstanceState, PgOntologyError> {
    let body = command;
    let org = current_org().map_err(KernelError::from)?;
    let actor = principal.user_id;
    let action_type_id = prepared.action.id;
    let config = prepared.config;
    let authority = authority_effect(principal);
    let checklist = body.checklist_all_acknowledged;
    let egress = egress_evidence(&prepared.action.side_effects);
    let four_eyes_ref = body.four_eyes_request_ref;
    let instance_id = body.instance_id;
    let object_type_id = body.object_type_id;
    let title = body.title.clone();
    let reason = body.reason.clone();
    let valid_from = body.valid_from;
    let action_key = action_key.to_owned();

    with_audits::<_, InstanceState, PgOntologyError>(state.registry.pool(), org, move |tx| {
        Box::pin(async move {
            // TOCTOU re-check: read four-eyes evidence inside THIS tx, re-run the
            // whole chain. Anything not satisfied now ⇒ deny ⇒ rollback (0 rows).
            let four_eyes_approved = match four_eyes_ref {
                Some(request_ref) => four_eyes_approved_conn(tx.as_mut(), request_ref)
                    .await
                    .map_err(governance_to_ontology)?,
                None => None,
            };
            let evidence = GateEvidence {
                authority: Some(authority),
                checklist_all_acknowledged: checklist,
                four_eyes_approved,
                egress_cleared: egress,
            };
            if !evaluate_gate_chain(config, &evidence).allow {
                return Err(KernelError::forbidden(
                    "action gate re-check failed inside the writeback transaction",
                )
                .into());
            }

            let now = OffsetDateTime::now_utc();
            let result = match instance_id {
                Some(id) => {
                    stage_revision_in_tx(
                        tx,
                        actor,
                        org,
                        id,
                        StageRevision {
                            attributes: new_attrs,
                            valid_from,
                            action_type_id: Some(action_type_id),
                            reason,
                        },
                        now,
                    )
                    .await?
                }
                None => {
                    create_instance_in_tx(
                        tx,
                        actor,
                        org,
                        CreateInstance {
                            object_type_id,
                            title: title.unwrap_or_default(),
                            attributes: new_attrs,
                            valid_from,
                            action_type_id: Some(action_type_id),
                            reason,
                        },
                        now,
                    )
                    .await?
                }
            };

            let event = AuditEvent::new(
                Some(actor),
                AuditAction::new("ontology.action.execute")?,
                "ont_instances",
                result.instance.id.to_string(),
                TraceContext::generate(),
                now,
            )
            .with_org(org)
            .with_snapshots(
                None,
                Some(serde_json::json!({
                    "action_key": action_key,
                    "version": result.revision.version,
                    "attributes": result.revision.attributes,
                })),
            );
            Ok((result, vec![event]))
        })
    })
    .await
    // Side-effects (notify / webhook / WORM attachment) run AFTER commit and must
    // be idempotent. None are dispatched in v1.
    // ponytail: side-effect dispatch lands with the §13 egress / comms lane.
}

/// Map the governance store error onto the ontology error so both can flow
/// through one `with_audits` closure error type. Same two-variant shape.
fn governance_to_ontology(error: PgGovernanceError) -> PgOntologyError {
    match error {
        PgGovernanceError::Db(db) => PgOntologyError::Db(db),
        PgGovernanceError::Domain(kernel) => PgOntologyError::Domain(kernel),
    }
}

// ---------------------------------------------------------------------------
// Lifecycle commit (§3b governance-gated instance-lifecycle transition)
// ---------------------------------------------------------------------------

/// Typed lifecycle-transition command (HTTP-independent) — the write counterpart
/// to the governance `lifecycle/preflight` read: the console preflights the edge,
/// then hands the allowed transition here to commit it.
#[derive(Debug, Clone)]
pub struct LifecycleCommand {
    pub to_state: InstanceLifecycleState,
    pub reason: Option<String>,
    /// Client-supplied self-checklist witness (§16 gate 2; fail-closed when absent).
    pub checklist_all_acknowledged: Option<bool>,
    /// Four-eyes request ref; its decision is read from the DB, never trusted from
    /// the caller.
    pub four_eyes_request_ref: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct LifecycleRequest {
    to_state: InstanceLifecycleState,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    checklist_all_acknowledged: Option<bool>,
    #[serde(default)]
    four_eyes_request_ref: Option<Uuid>,
}

impl LifecycleRequest {
    fn into_command(self) -> LifecycleCommand {
        LifecycleCommand {
            to_state: self.to_state,
            reason: self.reason,
            checklist_all_acknowledged: self.checklist_all_acknowledged,
            four_eyes_request_ref: self.four_eyes_request_ref,
        }
    }
}

/// Outcome of a committed transition — the new instance head plus the gate chain
/// that admitted it (mirrors [`ExecuteOutcome`]).
#[derive(Debug, Clone, Serialize)]
pub struct LifecycleOutcome {
    pub instance: InstanceHead,
    pub config: GateChainConfig,
    pub gates: GateChainOutcome,
}

/// The instance lifecycle FSM and the governance lifecycle FSM are the same five
/// states under different casings; map onto the governance state for validation +
/// config lookup (which the console preflight already speaks).
const fn to_governance_state(state: InstanceLifecycleState) -> LifecycleState {
    match state {
        InstanceLifecycleState::Draft => LifecycleState::Draft,
        InstanceLifecycleState::Active => LifecycleState::Active,
        InstanceLifecycleState::Locked => LifecycleState::Locked,
        InstanceLifecycleState::Archived => LifecycleState::Archived,
        InstanceLifecycleState::Disposed => LifecycleState::Disposed,
    }
}

impl OntologyRestState {
    /// Commit a §3b instance-lifecycle transition — the write counterpart to the
    /// governance lifecycle preflight. Validated against the base FSM AND the
    /// per-object-type `gov_lifecycle_transitions` config (an unconfigured edge is
    /// fail-closed), gated by the §16 chain (authority via the legacy contract,
    /// four-eyes read from the DB, checklist client-supplied), then committed in ONE
    /// audited tx that re-checks four-eyes and guards the from-state (TOCTOU-safe).
    pub async fn commit_lifecycle(
        &self,
        principal: &Principal,
        instance_id: InstanceId,
        command: LifecycleCommand,
    ) -> Result<LifecycleOutcome, ActionError> {
        // Load the target (RLS-scoped): a cross-org / missing id ⇒ NotFound, no leak.
        let head = self
            .instances
            .get_current(instance_id)
            .await
            .map_err(|e| match e {
                PgOntologyError::Domain(k) if k.kind == ErrorKind::NotFound => {
                    ActionError::NotFound
                }
                other => ActionError::Store(other),
            })?
            .instance;
        let from = to_governance_state(head.lifecycle_state);
        let to = to_governance_state(command.to_state);

        // Base FSM: an illegal edge can never commit (preserves the kernel kind, so
        // an illegal edge is a 409, a disposed source is a conflict).
        validate_lifecycle_transition(from, to)
            .map_err(|k| ActionError::Store(PgOntologyError::Domain(k)))?;

        // Per-object-type config: an unconfigured edge is fail-closed (deny).
        let reqs = self
            .governance
            .transition_requirements(*head.object_type_id.as_uuid(), from, to)
            .await
            .map_err(|e| ActionError::Store(governance_to_ontology(e)))?
            .ok_or_else(|| {
                ActionError::GateDenied(format!(
                    "lifecycle transition {} -> {} is not configured for this object type",
                    from.as_db_str(),
                    to.as_db_str()
                ))
            })?;

        // `requires_reason` is a config precondition, not a §16 gate.
        let has_reason = command
            .reason
            .as_deref()
            .is_some_and(|r| !r.trim().is_empty());
        if reqs.requires_reason && !has_reason {
            return Err(ActionError::CriteriaFailed(
                "this lifecycle transition requires a reason".to_owned(),
            ));
        }

        let config = GateChainConfig {
            authority: true,
            self_checklist: reqs.requires_checklist,
            four_eyes: reqs.requires_four_eyes,
            // A pure lifecycle transition has no outbound side-effects to classify.
            egress_dlp: false,
        };

        // Fail-closed pre-tx gate evaluation.
        let gates = self
            .evaluate_lifecycle_gates(principal, config, &command)
            .await?;
        if !gates.allow {
            let reason = gates.first_blocking().map_or_else(
                || "a lifecycle gate is not satisfied".to_owned(),
                |g| format!("gate {:?} blocked: {:?}", g.gate, g.status),
            );
            return Err(ActionError::GateDenied(reason));
        }

        // Audited writeback with TOCTOU re-check + from-state guard.
        let instance = lifecycle_writeback(self, principal, instance_id, command, config, head)
            .await
            .map_err(ActionError::Store)?;
        Ok(LifecycleOutcome {
            instance,
            config,
            gates,
        })
    }

    async fn evaluate_lifecycle_gates(
        &self,
        principal: &Principal,
        config: GateChainConfig,
        command: &LifecycleCommand,
    ) -> Result<GateChainOutcome, ActionError> {
        let authority = authority_effect(principal);
        let four_eyes_approved = match command.four_eyes_request_ref {
            Some(request_ref) => self
                .governance
                .four_eyes_approved(request_ref)
                .await
                .map_err(|e| ActionError::Store(governance_to_ontology(e)))?,
            None => None,
        };
        let evidence = GateEvidence {
            authority: Some(authority),
            checklist_all_acknowledged: command.checklist_all_acknowledged,
            four_eyes_approved,
            egress_cleared: None,
        };
        Ok(evaluate_gate_chain(config, &evidence))
    }
}

async fn commit_lifecycle(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<LifecycleRequest>,
) -> Result<Json<LifecycleOutcome>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let outcome = state
        .commit_lifecycle(&principal, InstanceId::from_uuid(id), body.into_command())
        .await
        .map_err(RestError::from_action)?;
    Ok(Json(outcome))
}

/// The lifecycle writeback: ONE `with_audits` tx that re-reads four-eyes evidence
/// INSIDE the tx (TOCTOU-safe) and re-runs the chain, then updates the head state
/// with a from-state guard (`WHERE lifecycle_state = <expected>`) so a concurrent
/// transition can never be double-applied — a mismatch or a re-check failure rolls
/// the tx back with zero rows written.
async fn lifecycle_writeback(
    state: &OntologyRestState,
    principal: &Principal,
    instance_id: InstanceId,
    command: LifecycleCommand,
    config: GateChainConfig,
    head: InstanceHead,
) -> Result<InstanceHead, PgOntologyError> {
    let org = current_org().map_err(KernelError::from)?;
    let actor = principal.user_id;
    let authority = authority_effect(principal);
    let checklist = command.checklist_all_acknowledged;
    let four_eyes_ref = command.four_eyes_request_ref;
    let to = command.to_state;
    let reason = command.reason.clone();
    let expected_from = head.lifecycle_state;

    with_audits::<_, InstanceHead, PgOntologyError>(state.registry.pool(), org, move |tx| {
        Box::pin(async move {
            // TOCTOU re-check: read four-eyes evidence inside THIS tx, re-run the chain.
            let four_eyes_approved = match four_eyes_ref {
                Some(request_ref) => four_eyes_approved_conn(tx.as_mut(), request_ref)
                    .await
                    .map_err(governance_to_ontology)?,
                None => None,
            };
            let evidence = GateEvidence {
                authority: Some(authority),
                checklist_all_acknowledged: checklist,
                four_eyes_approved,
                egress_cleared: None,
            };
            if !evaluate_gate_chain(config, &evidence).allow {
                return Err(KernelError::forbidden(
                    "lifecycle gate re-check failed inside the writeback transaction",
                )
                .into());
            }

            let now = OffsetDateTime::now_utc();
            // From-state guard: the transition applies iff the state is still the one
            // preflight validated (also covers cross-org/missing → 0 rows).
            let result = sqlx::query(
                "UPDATE ont_instances SET lifecycle_state = $2, updated_at = $3 \
                 WHERE id = $1 AND lifecycle_state = $4",
            )
            .bind(*instance_id.as_uuid())
            .bind(to.as_db_str())
            .bind(now)
            .bind(expected_from.as_db_str())
            .execute(tx.as_mut())
            .await?;
            if result.rows_affected() == 0 {
                return Err(KernelError::conflict(
                    "instance lifecycle state changed during the transition; retry",
                )
                .into());
            }

            let event = AuditEvent::new(
                Some(actor),
                AuditAction::new("ontology.instance.transition")?,
                "ont_instances",
                instance_id.to_string(),
                TraceContext::generate(),
                now,
            )
            .with_org(org)
            .with_snapshots(
                Some(serde_json::json!({ "lifecycle_state": expected_from.as_db_str() })),
                Some(serde_json::json!({
                    "lifecycle_state": to.as_db_str(),
                    "reason": reason,
                })),
            );
            Ok((
                InstanceHead {
                    lifecycle_state: to,
                    ..head
                },
                vec![event],
            ))
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// Acting-read (§2 dynamics chips) + code→instance resolve
// ---------------------------------------------------------------------------

async fn instance_acting(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<ActingRule>>, RestError> {
    authorize_ontology(&state, &headers).await?;
    let acting = state
        .registry
        .acting_on_instance(id)
        .await
        .map_err(RestError::from_ontology)?;
    Ok(Json(acting))
}

#[derive(Debug, Deserialize)]
struct ResolveQuery {
    code: String,
}

async fn resolve_code(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Query(query): Query<ResolveQuery>,
) -> Result<Json<ResolvedInstance>, RestError> {
    authorize_ontology(&state, &headers).await?;
    // Deny-by-omission: an unknown / cross-tenant code is a 404, never a 403.
    state
        .registry
        .resolve_by_code(&query.code)
        .await
        .map_err(RestError::from_ontology)?
        .map(Json)
        .ok_or_else(|| {
            RestError::from_kernel(KernelError::not_found("no instance resolves that code"))
        })
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/// Ontology is an org-scoped admin surface, so it authorizes org-wide.
// ponytail: dark/unwired surface — every endpoint gates on org-wide RoleManage
// (the existing PBAC-admin capability, as the governance console does). L-WIRE
// assigns per-endpoint ontology features when it merges this router live.
async fn authorize_ontology(
    state: &OntologyRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let principal = principal_from_headers(state, headers).await?;
    authorize_org_wide(&principal, Action::new(Feature::RoleManage))
        .map_err(RestError::from_kernel)?;
    Ok(principal)
}

async fn principal_from_headers(
    state: &OntologyRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for ontology API")
    })?;
    mnt_platform_request_context::resolve_principal(verifier, state.registry.pool(), headers)
        .await
        .map_err(rest_error_from_request_context)
}

// ---------------------------------------------------------------------------
// Errors (mirrors the governance rest error surface)
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct RestError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl RestError {
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "unavailable",
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
        }
    }

    /// A §16 gate denied the action (nothing was written).
    fn gate_denied(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "gate_denied",
            message: message.into(),
        }
    }

    /// A `projected_usecase` action whose real domain dispatch is not yet wired
    /// (L-WIRE). Typed so callers can distinguish "not implemented" from a deny.
    fn not_wired_yet(target: Option<&str>) -> Self {
        let message = target.map_or_else(
            || {
                "projected_usecase dispatch is not wired yet (lands in L-WIRE); nothing was written"
                    .to_owned()
            },
            |t| {
                format!(
                    "projected_usecase dispatch to '{t}' is not wired yet (lands in L-WIRE); nothing was written"
                )
            },
        );
        Self {
            status: StatusCode::NOT_IMPLEMENTED,
            code: "not_wired_yet",
            message,
        }
    }

    fn from_kernel(error: KernelError) -> Self {
        Self {
            status: status_for_error_kind(error.kind),
            code: code_for_error_kind(error.kind),
            message: error.message,
        }
    }

    fn from_ontology(error: PgOntologyError) -> Self {
        match error {
            PgOntologyError::Domain(kernel) => Self::from_kernel(kernel),
            PgOntologyError::Db(db) => Self::from_db(db),
        }
    }

    fn from_action(error: ActionError) -> Self {
        match error {
            ActionError::NotFound => Self::from_kernel(KernelError::not_found(
                "action type was not found for that object type",
            )),
            ActionError::Validation(message) => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "validation",
                message,
            },
            ActionError::GateDenied(message) => Self::gate_denied(message),
            ActionError::CriteriaFailed(message) => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "criteria_failed",
                message,
            },
            ActionError::NotWiredYet { target } => Self::not_wired_yet(target.as_deref()),
            ActionError::Store(error) => Self::from_ontology(error),
        }
    }

    fn from_db(error: DbError) -> Self {
        match error {
            DbError::Sqlx(sqlx::Error::RowNotFound) => {
                Self::from_kernel(KernelError::not_found("row was not found"))
            }
            DbError::Sqlx(sqlx::Error::Database(err))
                if err.code().is_some_and(|code| code == "23505") =>
            {
                tracing::error!(error = %err, "ontology unique-constraint violation");
                Self::from_kernel(KernelError::conflict("resource already exists"))
            }
            DbError::Sqlx(err) => {
                tracing::error!(error = %err, "database error");
                Self::internal("internal server error")
            }
            DbError::Serialize(err) => {
                tracing::error!(error = %err, "serialization error");
                Self::internal("internal server error")
            }
            DbError::CodeIssuance(err) => {
                tracing::error!(error = %err, "object-code issuance error");
                Self::internal("internal server error")
            }
        }
    }
}

fn rest_error_from_request_context(
    err: mnt_platform_request_context::RequestContextError,
) -> RestError {
    use mnt_platform_request_context::RequestContextError as E;
    match err {
        E::VerifierUnavailable => {
            RestError::unavailable("JWT verification is not configured for ontology API")
        }
        E::WrongTokenTier => RestError::from_kernel(KernelError::forbidden(
            "token tier is not valid for this route",
        )),
        E::AccessScope(error) => RestError::from_kernel(error),
        E::BranchScope(message) | E::EffectivePolicy(message) => RestError::internal(message),
        E::MissingOrg => RestError::internal("no tenant context is bound to the current request"),
        E::MissingBearer => RestError::unauthorized("missing or malformed bearer token"),
        E::InvalidToken => RestError::unauthorized("invalid bearer token"),
        E::InvalidClaim(message) => {
            RestError::unauthorized(format!("token claim is invalid: {message}"))
        }
    }
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

const fn status_for_error_kind(kind: ErrorKind) -> StatusCode {
    match kind {
        ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorKind::NotFound => StatusCode::NOT_FOUND,
        ErrorKind::Forbidden => StatusCode::FORBIDDEN,
        ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
        ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

const fn code_for_error_kind(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Validation => "validation",
        ErrorKind::NotFound => "not_found",
        ErrorKind::Forbidden => "forbidden",
        ErrorKind::Conflict => "conflict",
        ErrorKind::InvalidTransition => "invalid_transition",
        ErrorKind::Internal => "internal",
    }
}
