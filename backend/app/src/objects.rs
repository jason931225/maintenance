//! Generic object layer: cross-object links (BE-OBJ slice 1, stage 2) and the
//! object resolve endpoint (stage 3).
//!
//! `object_links` is the generic, org-scoped, audited edge store the design's
//! "related objects" / pin-A-to-B panels need. Links connect two known object
//! kinds (validated against the seeded `object_types` registry) and are
//! removable; every create/delete is audited via `with_audit`. Tenant isolation
//! is enforced by FORCE RLS on `object_links` keyed on `app.current_org`; the
//! `with_org_conn` / `with_audit` wrappers arm that GUC, so a cross-org read
//! returns nothing and a cross-org delete is a 404 (deny-by-omission).

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Extension, Json, Router};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, ErrorKind, KernelError, TraceContext,
};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Feature, PermissionLevel, Principal, permission_for};
use mnt_platform_db::{DbError, with_audit, with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use time::OffsetDateTime;
use uuid::Uuid;

pub const OBJECT_LINKS_PATH: &str = "/api/v1/object-links";
pub const OBJECT_LINK_BY_ID_PATH_TEMPLATE: &str = "/api/v1/object-links/{id}";
pub const OBJECT_RESOLVE_PATH_TEMPLATE: &str = "/api/objects/{kind}/{id}";
pub const OBJECT_GRAPH_PATH_TEMPLATE: &str = "/api/objects/{kind}/{id}/graph";

pub const OBJECT_ROUTE_PATHS: &[&str] = &[
    OBJECT_LINKS_PATH,
    OBJECT_LINK_BY_ID_PATH_TEMPLATE,
    OBJECT_RESOLVE_PATH_TEMPLATE,
    OBJECT_GRAPH_PATH_TEMPLATE,
];

/// Bounds on the graph walk: depth is clamped into `1..=GRAPH_MAX_DEPTH`, and
/// the returned node set is capped at `GRAPH_MAX_NODES` (a maintenance
/// object's neighborhood is small; this is a circuit breaker against a
/// pathologically dense link graph, not an expected ceiling). The walk is a
/// Rust-side level-by-level BFS (never a recursive SQL CTE): a `seen` set
/// makes every (kind, id) enter the frontier at most once, so a cycle in
/// object_links cannot cause unbounded/exponential work — cost is bounded by
/// (edges actually touched, ≤ GRAPH_MAX_DEPTH batch queries), not
/// degree^depth.
const GRAPH_MAX_DEPTH: i64 = 5;
const GRAPH_MAX_NODES: usize = 200;

/// Object kinds the resolve endpoint can dereference today (single-table
/// lookups reusing the domain's tenant + branch scoping). Other seeded kinds
/// resolve as unknown (404) until their resolver ships.
const RESOLVABLE_KINDS: &[&str] = &[
    "work_order",
    "equipment",
    "support_ticket",
    "org_unit",
    "person",
    "approval_run",
    "account",
    "passkey",
    "consent",
];

const ID_MAX: usize = 200;

#[derive(Debug, Clone)]
pub struct ObjectState {
    pool: PgPool,
    jwt_verifier: Option<JwtVerifier>,
}

impl ObjectState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self { pool, jwt_verifier }
    }
}

pub fn router(state: ObjectState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let router = Router::new()
        .route(
            OBJECT_LINKS_PATH,
            get(list_object_links).post(create_object_link),
        )
        .route(OBJECT_LINK_BY_ID_PATH_TEMPLATE, delete(delete_object_link))
        .route(OBJECT_RESOLVE_PATH_TEMPLATE, get(resolve_object))
        .route(OBJECT_GRAPH_PATH_TEMPLATE, get(object_graph))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

// ---------------------------------------------------------------------------
// Wire shapes.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateObjectLinkRequest {
    src_kind: String,
    src_id: String,
    dst_kind: String,
    dst_id: String,
    link_type: String,
}

#[derive(Debug, Deserialize)]
struct ListObjectLinksQuery {
    kind: String,
    id: String,
}

#[derive(Debug, Serialize)]
struct ObjectLinkResponse {
    id: Uuid,
    src_kind: String,
    src_id: String,
    dst_kind: String,
    dst_id: String,
    link_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

/// Links touching one object, in both directions: `outgoing` are edges where
/// the object is the source, `incoming` where it is the destination.
#[derive(Debug, Serialize)]
struct ObjectLinksListResponse {
    outgoing: Vec<ObjectLinkResponse>,
    incoming: Vec<ObjectLinkResponse>,
}

#[derive(Debug)]
struct NormalizedLink {
    src_kind: String,
    src_id: String,
    dst_kind: String,
    dst_id: String,
    link_type: String,
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

async fn create_object_link(
    State(state): State<ObjectState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreateObjectLinkRequest>,
) -> Result<Json<ObjectLinkResponse>, ObjectError> {
    authorize_object_member(&principal)?;
    let link = normalize_link(body)?;
    let link_id = Uuid::new_v4();
    let org = principal.org_id;
    let actor = principal.user_id;
    let now = OffsetDateTime::now_utc();
    let audit_after = json!({
        "id": link_id,
        "src_kind": link.src_kind,
        "src_id": link.src_id,
        "dst_kind": link.dst_kind,
        "dst_id": link.dst_id,
        "link_type": link.link_type,
    });
    let audit_event = AuditEvent::new(
        Some(actor),
        AuditAction::new("object_link.create")?,
        "object_link",
        link_id.to_string(),
        TraceContext::generate(),
        now,
    )
    .with_org(org)
    .with_snapshots(None, Some(audit_after));

    let response = with_audit::<_, _, ObjectError>(&state.pool, audit_event, move |tx| {
        Box::pin(async move {
            // Both kinds must be known (clean 422 rather than a raw FK 500).
            ensure_kinds_exist(tx, &link.src_kind, &link.dst_kind).await?;
            let insert = sqlx::query(
                r#"
                INSERT INTO object_links (
                    id, org_id, src_kind, src_id, dst_kind, dst_id, link_type, created_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id, src_kind, src_id, dst_kind, dst_id, link_type,
                          created_by, created_at
                "#,
            )
            .bind(link_id)
            .bind(*org.as_uuid())
            .bind(&link.src_kind)
            .bind(&link.src_id)
            .bind(&link.dst_kind)
            .bind(&link.dst_id)
            .bind(&link.link_type)
            .bind(*actor.as_uuid())
            .fetch_one(tx.as_mut())
            .await;
            match insert {
                Ok(row) => object_link_from_row(&row),
                Err(err) if is_unique_violation(&err) => Err(ObjectError::conflict(
                    "an identical object link already exists",
                )),
                Err(err) => Err(ObjectError::from(err)),
            }
        })
    })
    .await?;
    Ok(Json(response))
}

async fn delete_object_link(
    State(state): State<ObjectState>,
    Extension(principal): Extension<Principal>,
    Path(link_id): Path<Uuid>,
) -> Result<StatusCode, ObjectError> {
    authorize_object_member(&principal)?;
    let org = principal.org_id;
    let actor = principal.user_id;
    let now = OffsetDateTime::now_utc();

    // The audit before-snapshot cannot be known until the row is loaded inside
    // the tx, so use with_audits (event computed in-transaction).
    with_audits::<_, (), ObjectError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            // Load first (under armed RLS): unknown id OR another tenant's link
            // are indistinguishable — both 404, the deny-by-omission guarantee.
            let existing = sqlx::query(
                r#"
                SELECT id, src_kind, src_id, dst_kind, dst_id, link_type,
                       created_by, created_at
                FROM object_links
                WHERE id = $1
                "#,
            )
            .bind(link_id)
            .fetch_optional(tx.as_mut())
            .await?;
            let Some(row) = existing else {
                return Err(ObjectError::not_found("object link not found"));
            };
            let before = object_link_from_row(&row)?;
            sqlx::query("DELETE FROM object_links WHERE id = $1")
                .bind(link_id)
                .execute(tx.as_mut())
                .await?;
            let event = AuditEvent::new(
                Some(actor),
                AuditAction::new("object_link.delete")?,
                "object_link",
                link_id.to_string(),
                TraceContext::generate(),
                now,
            )
            .with_org(org)
            .with_snapshots(audit_delete_snapshot(&before), None);
            Ok(((), vec![event]))
        })
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_object_links(
    State(state): State<ObjectState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ListObjectLinksQuery>,
) -> Result<Json<ObjectLinksListResponse>, ObjectError> {
    authorize_object_member(&principal)?;
    let kind = normalize_kind(&query.kind, "kind")?;
    let id = normalize_object_id(&query.id, "id")?;
    let org = principal.org_id;

    let response = with_org_conn::<_, _, ObjectError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let outgoing_rows = sqlx::query(
                r#"
                SELECT id, src_kind, src_id, dst_kind, dst_id, link_type,
                       created_by, created_at
                FROM object_links
                WHERE src_kind = $1 AND src_id = $2
                ORDER BY created_at DESC, id DESC
                "#,
            )
            .bind(&kind)
            .bind(&id)
            .fetch_all(tx.as_mut())
            .await?;
            let incoming_rows = sqlx::query(
                r#"
                SELECT id, src_kind, src_id, dst_kind, dst_id, link_type,
                       created_by, created_at
                FROM object_links
                WHERE dst_kind = $1 AND dst_id = $2
                ORDER BY created_at DESC, id DESC
                "#,
            )
            .bind(&kind)
            .bind(&id)
            .fetch_all(tx.as_mut())
            .await?;
            let outgoing = outgoing_rows
                .iter()
                .map(object_link_from_row)
                .collect::<Result<Vec<_>, _>>()?;
            let incoming = incoming_rows
                .iter()
                .map(object_link_from_row)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(ObjectLinksListResponse { outgoing, incoming })
        })
    })
    .await?;
    Ok(Json(response))
}

// ---------------------------------------------------------------------------
// Resolve: GET /api/objects/{kind}/{id} -> compact ObjectHead.
// ---------------------------------------------------------------------------

/// Compact, kind-agnostic head for any object. `exists` is the deny-by-omission
/// signal for a SINGLE resolve: an object outside the caller's org/branch
/// scope resolves the SAME as a genuinely-absent id (`exists: false`), so the
/// caller can never distinguish "not yours" from "not there". A well-formed
/// but unregistered kind is 404. In a graph response (`ObjectGraphResponse`),
/// by contrast, an unresolvable node is never present at all (OMITTED, not an
/// `exists: false` stub) — deny-by-omission governs discovery itself there,
/// not just display, so `exists` is always `true` for a graph node.
///
/// No route/URL field: `objectRegistry` (`web/src/lib/objectRegistry.ts`) is
/// the sole kind->URL authority (charter decision, option b) — the backend
/// never issues routes.
#[derive(Debug, Serialize)]
struct ObjectHead {
    kind: String,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    exists: bool,
}

#[derive(Debug, Default)]
struct ResolvedHead {
    code: Option<String>,
    title: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphQuery {
    depth: Option<i64>,
}

/// The bounded neighborhood of an object: every node the caller can actually
/// resolve (each passed through the same per-kind visibility guard as
/// `resolve_object`; an unresolvable node is OMITTED, never included as a
/// stub, and the walk never expands through it) plus the edges between
/// resolved nodes (an edge touching an omitted node is omitted too).
#[derive(Debug, Serialize)]
struct ObjectGraphResponse {
    nodes: Vec<ObjectHead>,
    edges: Vec<ObjectLinkResponse>,
    /// `true` if `GRAPH_MAX_NODES` was hit before the walk exhausted `depth`
    /// — the response is a partial (but still correctly scoped) neighborhood.
    truncated: bool,
}

async fn resolve_object(
    State(state): State<ObjectState>,
    Extension(principal): Extension<Principal>,
    Path((kind, id)): Path<(String, String)>,
) -> Result<Json<ObjectHead>, ObjectError> {
    authorize_object_member(&principal)?;
    // A malformed slug is a client error; a well-formed unknown kind is 404.
    let kind = normalize_kind(&kind, "kind")?;
    if !RESOLVABLE_KINDS.contains(&kind.as_str()) {
        return Err(ObjectError::not_found("unknown object kind"));
    }
    // Feature parity with the domain read endpoints: work_order and equipment
    // GETs require WorkOrderReadAll (workorder/rest get_work_order, registry/rest
    // authorize_read_access), so the generic head must too — otherwise a MEMBER
    // (Login-only) could read heads its role is denied. The deny is kind-level,
    // independent of the id, so it cannot become an existence oracle. This is
    // the LOUD form (403) for a directly-requested top-level kind; resolve_head
    // (shared with object_graph) carries the quiet per-node form of the same
    // guard (omit, not error) for kinds discovered mid-walk.
    let can_read_work_order =
        authorize_object_feature(&principal, Feature::WorkOrderReadAll).is_ok();
    if matches!(kind.as_str(), "work_order" | "equipment") && !can_read_work_order {
        return Err(ObjectError::from_kernel(KernelError::forbidden(
            "insufficient permission for this object kind",
        )));
    }
    let org = principal.org_id;
    let scope = principal.branch_scope.clone();
    let caller = *principal.user_id.as_uuid();
    // Authority role keys the caller holds, computed exactly as the waiting-task
    // inbox does, so approval_run resolves for the same principals the inbox
    // exposes the run to (claimers + assignee-role holders), not just initiators.
    let held_role_keys = crate::workflow_studio::held_authority_role_keys(
        &principal,
        org,
        crate::workflow_studio::guard_branch(&principal),
    );

    // Every resolver reads under the caller's armed org (RLS) and, for
    // branch-scoped kinds, drops rows outside the caller's branch scope — so an
    // out-of-scope object is indistinguishable from a missing one.
    let resolved = with_org_conn::<_, Option<ResolvedHead>, ObjectError>(&state.pool, org, {
        let kind = kind.clone();
        let id = id.clone();
        move |tx| {
            Box::pin(async move {
                resolve_head(
                    tx,
                    &scope,
                    caller,
                    &held_role_keys,
                    can_read_work_order,
                    &kind,
                    &id,
                )
                .await
            })
        }
    })
    .await?;

    Ok(Json(object_head_from_resolved(kind, id, resolved)))
}

/// Dispatch a single (kind, id) to its per-kind resolver. Shared by
/// `resolve_object` (one object, 404/403 up front) and `object_graph` (many
/// nodes; an unregistered/unresolvable/insufficiently-privileged kind is just
/// omitted, never an error) — the SAME visibility guard (including the
/// WorkOrderReadAll feature gate — `can_read_work_order`), so a node in the
/// graph can never be more visible than a direct resolve of that node would be.
async fn resolve_head(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    scope: &BranchScope,
    caller: Uuid,
    held_role_keys: &[String],
    can_read_work_order: bool,
    kind: &str,
    id: &str,
) -> Result<Option<ResolvedHead>, ObjectError> {
    match kind {
        "work_order" if can_read_work_order => resolve_work_order(tx, scope, id).await,
        "equipment" if can_read_work_order => resolve_equipment(tx, scope, id).await,
        "support_ticket" => resolve_support_ticket(tx, scope, id).await,
        "org_unit" => resolve_org_unit(tx, scope, id).await,
        "person" => resolve_person(tx, scope, id).await,
        "approval_run" => resolve_approval_run(tx, caller, held_role_keys, id).await,
        // Identity kinds (Identity Console UI-M13 / charter G-b). account =
        // person's branch-membership visibility (lifecycle object, so it shows
        // deactivated in-scope accounts + status); passkey/consent are
        // self-owned (only the caller resolves their own credential/consent).
        "account" => resolve_account(tx, scope, id).await,
        "passkey" => resolve_passkey(tx, caller, id).await,
        "consent" => resolve_consent(tx, caller, id).await,
        // work_order/equipment without WorkOrderReadAll, any other kind
        // (including ones not in RESOLVABLE_KINDS): no resolver applies ->
        // treated identically to "not found"/"not visible".
        _ => Ok(None),
    }
}

fn object_head_from_resolved(
    kind: String,
    id: String,
    resolved: Option<ResolvedHead>,
) -> ObjectHead {
    match resolved {
        Some(fields) => ObjectHead {
            kind,
            id,
            code: fields.code,
            title: fields.title,
            status: fields.status,
            exists: true,
        },
        None => ObjectHead {
            kind,
            id,
            code: None,
            title: None,
            status: None,
            exists: false,
        },
    }
}

// ---------------------------------------------------------------------------
// Graph: GET /api/objects/{kind}/{id}/graph?depth=N -> bounded neighborhood.
// ---------------------------------------------------------------------------

async fn object_graph(
    State(state): State<ObjectState>,
    Extension(principal): Extension<Principal>,
    Path((kind, id)): Path<(String, String)>,
    Query(query): Query<GraphQuery>,
) -> Result<Json<ObjectGraphResponse>, ObjectError> {
    authorize_object_member(&principal)?;
    let kind = normalize_kind(&kind, "kind")?;
    let depth = query.depth.unwrap_or(1).clamp(1, GRAPH_MAX_DEPTH);
    let org = principal.org_id;
    let scope = principal.branch_scope.clone();
    let caller = *principal.user_id.as_uuid();
    // Same feature gate resolve_object enforces loudly (403) for a directly-
    // requested work_order/equipment kind; here it is quiet (a work_order or
    // equipment node the caller lacks WorkOrderReadAll for is simply omitted
    // from the walk, never a 403 for the whole graph request).
    let can_read_work_order =
        authorize_object_feature(&principal, Feature::WorkOrderReadAll).is_ok();
    let held_role_keys = crate::workflow_studio::held_authority_role_keys(
        &principal,
        org,
        crate::workflow_studio::guard_branch(&principal),
    );

    // Rust-side level-by-level BFS over object_links, NOT a recursive SQL CTE:
    // `seen` admits every (kind, id) into the frontier at most once, so a
    // cycle cannot cause unbounded/exponential work regardless of graph
    // density. At most GRAPH_MAX_DEPTH batch link queries run (one per level,
    // each scoped to the current frontier only) plus one resolve_head call
    // per newly-discovered candidate. Deny-by-omission governs discovery
    // itself: a node that does not resolve is OMITTED (never a stub) and the
    // walk never expands through it, so the caller only ever sees their own
    // visible subgraph.
    let (nodes, edges, truncated) =
        with_org_conn::<_, _, ObjectError>(&state.pool, org, move |tx| {
            Box::pin(async move {
                let root_key = (kind.clone(), id.clone());
                let mut seen: HashSet<(String, String)> = HashSet::new();
                seen.insert(root_key.clone());

                let mut nodes: Vec<ObjectHead> = Vec::new();
                // Raw edges touched while walking the frontier, keyed by link
                // id to dedupe re-fetches across levels; filtered down to the
                // resolved-only induced subgraph once the walk finishes.
                let mut edges_by_id: HashMap<Uuid, ObjectLinkResponse> = HashMap::new();
                let mut truncated = false;

                let root_resolved = resolve_head(
                    tx,
                    &scope,
                    caller,
                    &held_role_keys,
                    can_read_work_order,
                    &kind,
                    &id,
                )
                .await?;
                let Some(root_fields) = root_resolved else {
                    // The root itself is invisible/absent: an empty graph,
                    // never a stub — matches resolve_object's own
                    // deny-by-omission guarantee for this same (kind, id).
                    return Ok((Vec::new(), Vec::new(), false));
                };
                nodes.push(object_head_from_resolved(
                    kind.clone(),
                    id.clone(),
                    Some(root_fields),
                ));

                // `frontier` = nodes resolved in the PREVIOUS round whose
                // links have not been fetched yet.
                let mut frontier: Vec<(String, String)> = vec![root_key];

                for _hop in 0..depth {
                    if frontier.is_empty() || nodes.len() >= GRAPH_MAX_NODES {
                        if nodes.len() >= GRAPH_MAX_NODES {
                            truncated = true;
                        }
                        break;
                    }

                    let frontier_kinds: Vec<String> =
                        frontier.iter().map(|(k, _)| k.clone()).collect();
                    let frontier_ids: Vec<String> =
                        frontier.iter().map(|(_, i)| i.clone()).collect();
                    let link_rows = sqlx::query(
                        r#"
                        SELECT l.id, l.src_kind, l.src_id, l.dst_kind, l.dst_id, l.link_type,
                               l.created_by, l.created_at
                        FROM object_links l
                        WHERE EXISTS (
                            SELECT 1 FROM unnest($1::text[], $2::text[]) AS f(kind, id)
                            WHERE (l.src_kind = f.kind AND l.src_id = f.id)
                               OR (l.dst_kind = f.kind AND l.dst_id = f.id)
                        )
                        "#,
                    )
                    .bind(&frontier_kinds)
                    .bind(&frontier_ids)
                    .fetch_all(tx.as_mut())
                    .await?;

                    // Every link touching the frontier is recorded (even one
                    // between two already-resolved nodes — a cross edge, not
                    // just BFS-tree edges); candidate neighbors not yet seen
                    // are queued for resolution below.
                    let mut candidates: Vec<(String, String)> = Vec::new();
                    for row in &link_rows {
                        let link = object_link_from_row(row)?;
                        let src = (link.src_kind.clone(), link.src_id.clone());
                        let dst = (link.dst_kind.clone(), link.dst_id.clone());
                        edges_by_id.insert(link.id, link);
                        for candidate in [src, dst] {
                            if seen.insert(candidate.clone()) {
                                candidates.push(candidate);
                            }
                        }
                    }

                    let mut next_frontier: Vec<(String, String)> = Vec::new();
                    for (node_kind, node_id) in candidates {
                        if nodes.len() >= GRAPH_MAX_NODES {
                            truncated = true;
                            break;
                        }
                        let resolved = resolve_head(
                            tx,
                            &scope,
                            caller,
                            &held_role_keys,
                            can_read_work_order,
                            &node_kind,
                            &node_id,
                        )
                        .await?;
                        // Unresolved: dropped here — omitted from `nodes`,
                        // never added to `next_frontier` (never expanded),
                        // and any edge touching it is pruned in the filter
                        // below.
                        if let Some(fields) = resolved {
                            nodes.push(object_head_from_resolved(
                                node_kind.clone(),
                                node_id.clone(),
                                Some(fields),
                            ));
                            next_frontier.push((node_kind, node_id));
                        }
                    }
                    frontier = next_frontier;
                }

                // Keep only edges where BOTH endpoints resolved: an edge
                // touching an omitted node is omitted too, never leaked as a
                // dangling reference to something the caller cannot see.
                let resolved_keys: HashSet<(String, String)> = nodes
                    .iter()
                    .map(|n| (n.kind.clone(), n.id.clone()))
                    .collect();
                let edges: Vec<ObjectLinkResponse> = edges_by_id
                    .into_values()
                    .filter(|e| {
                        resolved_keys.contains(&(e.src_kind.clone(), e.src_id.clone()))
                            && resolved_keys.contains(&(e.dst_kind.clone(), e.dst_id.clone()))
                    })
                    .collect();

                Ok((nodes, edges, truncated))
            })
        })
        .await?;

    Ok(Json(ObjectGraphResponse {
        nodes,
        edges,
        truncated,
    }))
}

async fn resolve_work_order(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    scope: &BranchScope,
    id: &str,
) -> Result<Option<ResolvedHead>, ObjectError> {
    let Some(uuid) = parse_uuid(id) else {
        return Ok(None);
    };
    let row = sqlx::query("SELECT request_no, status, branch_id FROM work_orders WHERE id = $1")
        .bind(uuid)
        .fetch_optional(tx.as_mut())
        .await?;
    let Some(row) = row else { return Ok(None) };
    let branch_id: Uuid = row.try_get("branch_id")?;
    if !branch_visible(scope, Some(branch_id)) {
        return Ok(None);
    }
    Ok(Some(ResolvedHead {
        code: Some(row.try_get("request_no")?),
        title: None,
        status: Some(row.try_get("status")?),
    }))
}

async fn resolve_equipment(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    scope: &BranchScope,
    id: &str,
) -> Result<Option<ResolvedHead>, ObjectError> {
    let Some(uuid) = parse_uuid(id) else {
        return Ok(None);
    };
    let row =
        sqlx::query("SELECT manager_name, status, branch_id FROM registry_equipment WHERE id = $1")
            .bind(uuid)
            .fetch_optional(tx.as_mut())
            .await?;
    let Some(row) = row else { return Ok(None) };
    let branch_id: Uuid = row.try_get("branch_id")?;
    if !branch_visible(scope, Some(branch_id)) {
        return Ok(None);
    }
    Ok(Some(ResolvedHead {
        code: None,
        title: row.try_get("manager_name")?,
        status: Some(row.try_get("status")?),
    }))
}

async fn resolve_support_ticket(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    scope: &BranchScope,
    id: &str,
) -> Result<Option<ResolvedHead>, ObjectError> {
    let Some(uuid) = parse_uuid(id) else {
        return Ok(None);
    };
    let row = sqlx::query("SELECT title, status, branch_id FROM support_tickets WHERE id = $1")
        .bind(uuid)
        .fetch_optional(tx.as_mut())
        .await?;
    let Some(row) = row else { return Ok(None) };
    // branch_id is nullable: a NULL (org-wide) ticket is visible to any member.
    let branch_id: Option<Uuid> = row.try_get("branch_id")?;
    if !branch_visible(scope, branch_id) {
        return Ok(None);
    }
    Ok(Some(ResolvedHead {
        code: None,
        title: Some(row.try_get("title")?),
        status: Some(row.try_get("status")?),
    }))
}

async fn resolve_org_unit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    scope: &BranchScope,
    id: &str,
) -> Result<Option<ResolvedHead>, ObjectError> {
    let Some(uuid) = parse_uuid(id) else {
        return Ok(None);
    };
    // The org unit IS a branch: it is visible only if in the caller's scope.
    if !branch_visible(scope, Some(uuid)) {
        return Ok(None);
    }
    let row = sqlx::query("SELECT name FROM branches WHERE id = $1")
        .bind(uuid)
        .fetch_optional(tx.as_mut())
        .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(ResolvedHead {
        code: None,
        title: Some(row.try_get("name")?),
        status: None,
    }))
}

async fn resolve_person(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    scope: &BranchScope,
    id: &str,
) -> Result<Option<ResolvedHead>, ObjectError> {
    let Some(uuid) = parse_uuid(id) else {
        return Ok(None);
    };
    // Match GET /api/messenger/members exactly (messenger adapter list_members):
    // is_active = true AND the user shares a branch with the caller's scope.
    // Out-of-scope OR inactive -> no row -> exists:false, byte-identical to a
    // missing id (no cross-branch existence/deactivation oracle).
    let row = match scope {
        BranchScope::All => {
            sqlx::query("SELECT display_name FROM users WHERE id = $1 AND is_active = true")
                .bind(uuid)
                .fetch_optional(tx.as_mut())
                .await?
        }
        BranchScope::Branches(set) => {
            let branches: Vec<Uuid> = set.iter().map(|b| *b.as_uuid()).collect();
            sqlx::query(
                r#"
                SELECT u.display_name
                FROM users u
                JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ANY($2)
                WHERE u.id = $1 AND u.is_active = true
                LIMIT 1
                "#,
            )
            .bind(uuid)
            .bind(branches)
            .fetch_optional(tx.as_mut())
            .await?
        }
    };
    let Some(row) = row else { return Ok(None) };
    Ok(Some(ResolvedHead {
        code: None,
        title: Some(row.try_get("display_name")?),
        status: None,
    }))
}

/// Account = the login object behind a person. SAME branch-membership guard as
/// `resolve_person` (a cross-branch/cross-org account is byte-identical to a
/// missing one — the leak class caught in review), but it is the admin
/// LIFECYCLE object, so unlike `person` it does NOT filter `is_active`: it
/// surfaces deactivated in-scope accounts with `status = active|inactive` (what
/// the S2 activate/deactivate transition renders). Deactivation preserves
/// `user_branches`, so the join still matches a deactivated in-scope user.
async fn resolve_account(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    scope: &BranchScope,
    id: &str,
) -> Result<Option<ResolvedHead>, ObjectError> {
    let Some(uuid) = parse_uuid(id) else {
        return Ok(None);
    };
    let row = match scope {
        BranchScope::All => {
            sqlx::query("SELECT display_name, is_active FROM users WHERE id = $1")
                .bind(uuid)
                .fetch_optional(tx.as_mut())
                .await?
        }
        BranchScope::Branches(set) => {
            let branches: Vec<Uuid> = set.iter().map(|b| *b.as_uuid()).collect();
            sqlx::query(
                r#"
                SELECT u.display_name, u.is_active
                FROM users u
                JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ANY($2)
                WHERE u.id = $1
                LIMIT 1
                "#,
            )
            .bind(uuid)
            .bind(branches)
            .fetch_optional(tx.as_mut())
            .await?
        }
    };
    let Some(row) = row else { return Ok(None) };
    let is_active: bool = row.try_get("is_active")?;
    Ok(Some(ResolvedHead {
        code: None,
        title: Some(row.try_get("display_name")?),
        status: Some(if is_active { "active" } else { "inactive" }.to_owned()),
    }))
}

/// Passkey = self-owned WebAuthn credential. Visible ONLY to its owner: the row
/// must exist AND belong to the caller. A passkey owned by anyone else (or a
/// missing id) is `exists:false` — no cross-user credential-enumeration oracle.
/// `auth_webauthn_credentials` gained a NOT NULL `org_id` + FORCE RLS in
/// migrations 0032/0034/0035, so this is defense in depth: `with_org_conn`
/// already arms `app.current_org` (RLS drops cross-org rows before this query
/// runs); the explicit `user_id = caller` filter additionally scopes to the
/// caller's OWN credentials within their org.
async fn resolve_passkey(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    caller: Uuid,
    id: &str,
) -> Result<Option<ResolvedHead>, ObjectError> {
    let Some(uuid) = parse_uuid(id) else {
        return Ok(None);
    };
    let row = sqlx::query(
        "SELECT last_used_at FROM auth_webauthn_credentials WHERE id = $1 AND user_id = $2",
    )
    .bind(uuid)
    .bind(caller)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else { return Ok(None) };
    let last_used_at: Option<OffsetDateTime> = row.try_get("last_used_at")?;
    Ok(Some(ResolvedHead {
        code: None,
        title: None,
        status: Some(
            if last_used_at.is_some() {
                "used"
            } else {
                "unused"
            }
            .to_owned(),
        ),
    }))
}

/// Consent = self-owned versioned policy acceptance. There is no consent table:
/// acceptance is recorded as an `audit_events` row (`privacy.required_accept` /
/// `target_type = 'privacy_terms'`), so the consent object's id IS the policy
/// version string (e.g. `kr-pipa-v1-2026-06-25`), NOT a UUID. Visible only when
/// the CALLER has accepted that version (`actor = caller`); another user's
/// consent, or an unaccepted version, is `exists:false`. `audit_events` is
/// org-RLS-scoped (GUC armed by `with_org_conn`), so this cannot cross orgs.
async fn resolve_consent(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    caller: Uuid,
    id: &str,
) -> Result<Option<ResolvedHead>, ObjectError> {
    let accepted: Option<OffsetDateTime> = sqlx::query_scalar(
        r#"
        SELECT occurred_at
        FROM audit_events
        WHERE actor = $1
          AND action = 'privacy.required_accept'
          AND target_type = 'privacy_terms'
          AND target_id = $2
        ORDER BY occurred_at DESC
        LIMIT 1
        "#,
    )
    .bind(caller)
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?;
    if accepted.is_none() {
        return Ok(None);
    }
    Ok(Some(ResolvedHead {
        code: None,
        title: Some(id.to_owned()),
        status: Some("accepted".to_owned()),
    }))
}

async fn resolve_approval_run(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    caller: Uuid,
    held_role_keys: &[String],
    id: &str,
) -> Result<Option<ResolvedHead>, ObjectError> {
    let Some(uuid) = parse_uuid(id) else {
        return Ok(None);
    };
    // Visible to the same principals the waiting-task inbox exposes the run to:
    // the initiator, anyone who has claimed a task on it, and holders of a role
    // a task is routed to. Everyone else -> exists:false (deny-by-omission).
    let row = sqlx::query(
        r#"
        SELECT r.status
        FROM workflow_runs r
        WHERE r.id = $1
          AND (
              r.initiated_by = $2
              OR EXISTS (
                  SELECT 1 FROM workflow_waiting_tasks t
                  WHERE t.run_id = r.id AND t.org_id = r.org_id
                    AND t.status IN ('OPEN', 'CLAIMED')
                    AND (t.claimed_by = $2 OR t.assignee_role_key = ANY($3))
              )
          )
        "#,
    )
    .bind(uuid)
    .bind(caller)
    .bind(held_role_keys)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(ResolvedHead {
        code: None,
        title: None,
        status: Some(row.try_get("status")?),
    }))
}

fn parse_uuid(id: &str) -> Option<Uuid> {
    Uuid::parse_str(id.trim()).ok()
}

/// Branch-scope visibility. `All` sees everything; a bounded scope sees a row
/// only when its branch is in scope. A NULL branch (org-wide row) is visible to
/// any org member.
fn branch_visible(scope: &BranchScope, branch_id: Option<Uuid>) -> bool {
    match (scope, branch_id) {
        (BranchScope::All, _) => true,
        (BranchScope::Branches(_), None) => true,
        (BranchScope::Branches(set), Some(branch)) => set.contains(&BranchId::from_uuid(branch)),
    }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/// Confirm both link endpoints reference a seeded kind, inside the write tx so
/// the check and the insert are atomic. Runs on `tx.as_mut()` (armed), never a
/// bare pool.
async fn ensure_kinds_exist(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    src_kind: &str,
    dst_kind: &str,
) -> Result<(), ObjectError> {
    let found: i64 =
        sqlx::query_scalar("SELECT COUNT(DISTINCT kind) FROM object_types WHERE kind = ANY($1)")
            .bind(vec![src_kind.to_owned(), dst_kind.to_owned()])
            .fetch_one(tx.as_mut())
            .await?;
    // Distinct kinds requested: 1 if src==dst (rejected earlier), else 2.
    let expected = if src_kind == dst_kind { 1 } else { 2 };
    if found == expected {
        Ok(())
    } else {
        Err(ObjectError::validation(
            "src_kind and dst_kind must be known object kinds",
        ))
    }
}

fn normalize_link(body: CreateObjectLinkRequest) -> Result<NormalizedLink, ObjectError> {
    let src_kind = normalize_kind(&body.src_kind, "src_kind")?;
    let dst_kind = normalize_kind(&body.dst_kind, "dst_kind")?;
    let src_id = normalize_object_id(&body.src_id, "src_id")?;
    let dst_id = normalize_object_id(&body.dst_id, "dst_id")?;
    let link_type = normalize_kind(&body.link_type, "link_type")?;
    if src_kind == dst_kind && src_id == dst_id {
        return Err(ObjectError::validation(
            "an object cannot be linked to itself",
        ));
    }
    Ok(NormalizedLink {
        src_kind,
        src_id,
        dst_kind,
        dst_id,
        link_type,
    })
}

/// Slug validation matching the DB CHECK (`^[a-z][a-z0-9_]{1,63}$`): a leading
/// lowercase letter then 1..63 more of lowercase/digit/underscore.
fn normalize_kind(raw: &str, field: &'static str) -> Result<String, ObjectError> {
    let value = raw.trim().to_ascii_lowercase();
    let mut chars = value.chars();
    let leads = chars.next().is_some_and(|ch| ch.is_ascii_lowercase());
    let rest_ok = chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_');
    if leads && rest_ok && (2..=64).contains(&value.len()) {
        Ok(value)
    } else {
        Err(ObjectError::validation(format!(
            "{field} is not a valid kind"
        )))
    }
}

fn normalize_object_id(raw: &str, field: &'static str) -> Result<String, ObjectError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(ObjectError::validation(format!("{field} is required")));
    }
    if value.chars().count() > ID_MAX {
        return Err(ObjectError::validation(format!(
            "{field} must be {ID_MAX} characters or less"
        )));
    }
    Ok(value.to_owned())
}

fn object_link_from_row(row: &sqlx::postgres::PgRow) -> Result<ObjectLinkResponse, ObjectError> {
    Ok(ObjectLinkResponse {
        id: row.try_get("id")?,
        src_kind: row.try_get("src_kind")?,
        src_id: row.try_get("src_id")?,
        dst_kind: row.try_get("dst_kind")?,
        dst_id: row.try_get("dst_id")?,
        link_type: row.try_get("link_type")?,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
    })
}

fn audit_delete_snapshot(before: &ObjectLinkResponse) -> Option<Value> {
    Some(json!({
        "id": before.id,
        "src_kind": before.src_kind,
        "src_id": before.src_id,
        "dst_kind": before.dst_kind,
        "dst_id": before.dst_id,
        "link_type": before.link_type,
    }))
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error().and_then(|db| db.code()).as_deref() == Some("23505")
}

fn authorize_object_member(principal: &Principal) -> Result<(), ObjectError> {
    authorize_object_feature(principal, Feature::Login).map_err(|_| {
        ObjectError::from_kernel(KernelError::forbidden(
            "object links require an authenticated tenant member",
        ))
    })
}

fn authorize_object_feature(principal: &Principal, feature: Feature) -> Result<(), ObjectError> {
    let allowed_by_role = principal
        .roles
        .iter()
        .any(|role| permission_for(*role, feature) == PermissionLevel::Allow);
    let allowed_by_custom_grant = principal
        .effective_feature_grants
        .iter()
        .any(|grant| grant.feature == feature && grant.permission == PermissionLevel::Allow);
    if allowed_by_role || allowed_by_custom_grant {
        return Ok(());
    }
    Err(ObjectError::from_kernel(KernelError::forbidden(
        "insufficient permission for this object kind",
    )))
}

// ---------------------------------------------------------------------------
// Error type (mirrors the collaboration module's shape).
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct ObjectError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ObjectError {
    fn from_kernel(error: KernelError) -> Self {
        let status = match error.kind {
            ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorKind::NotFound => StatusCode::NOT_FOUND,
            ErrorKind::Forbidden => StatusCode::FORBIDDEN,
            ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
            ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self {
            status,
            code: error_code(error.kind),
            message: error.message,
        }
    }

    fn validation(message: impl Into<String>) -> Self {
        Self::from_kernel(KernelError::validation(message.into()))
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::from_kernel(KernelError::not_found(message.into()))
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::from_kernel(KernelError::conflict(message.into()))
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
        }
    }
}

impl From<KernelError> for ObjectError {
    fn from(error: KernelError) -> Self {
        Self::from_kernel(error)
    }
}

impl From<DbError> for ObjectError {
    fn from(value: DbError) -> Self {
        tracing::error!(error = %value, "object-layer database operation failed");
        Self::internal("object-layer request failed")
    }
}

impl From<sqlx::Error> for ObjectError {
    fn from(value: sqlx::Error) -> Self {
        Self::from(DbError::Sqlx(value))
    }
}

impl IntoResponse for ObjectError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

fn error_code(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Validation => "validation",
        ErrorKind::NotFound => "not_found",
        ErrorKind::Forbidden => "forbidden",
        ErrorKind::Conflict => "conflict",
        ErrorKind::InvalidTransition => "invalid_transition",
        ErrorKind::Internal => "internal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_self_link_and_bad_kinds() {
        let self_link = CreateObjectLinkRequest {
            src_kind: "work_order".into(),
            src_id: "wo-1".into(),
            dst_kind: "work_order".into(),
            dst_id: "wo-1".into(),
            link_type: "relates_to".into(),
        };
        assert!(normalize_link(self_link).is_err());

        assert!(normalize_kind("Work Order", "src_kind").is_err());
        assert!(normalize_kind("1bad", "src_kind").is_err());
        assert!(normalize_kind("work_order", "src_kind").is_ok());
        assert!(normalize_object_id("  ", "id").is_err());
    }
}
