//! Postgres ontology-registry adapter (§18 registry + §3a schema lifecycle).
//!
//! Each object type is a VERSIONED complete schema snapshot: one row per
//! `(org, stable_key, schema_version)` in `ont_object_types`, with its
//! property/link/action/analytic children hung off that version's id. Creating a
//! draft, staging a v+1 revision, and advancing the lifecycle FSM all wrap
//! [`with_audit`] so the mutation and its audit row land in one transaction, and
//! all read/write paths arm `app.current_org` so Postgres RLS scopes every row
//! to the tenant.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod instances;
pub mod seed;

use mnt_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext, UserId};
use mnt_ontology_domain::{
    ActionDispatch, ActionTypeId, AnalyticId, BackingKind, FieldKind, LinkCardinality, LinkTypeId,
    ObjectTypeId, PropertyDefId, SchemaLifecycleState, validate_schema_transition,
};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use mnt_platform_request_context::current_org;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;

#[derive(Debug, thiserror::Error)]
pub enum PgOntologyError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl From<sqlx::Error> for PgOntologyError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

// ===========================================================================
// Inputs (a complete schema snapshot for one object-type version).
// ===========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertyDefInput {
    pub key: String,
    pub title: String,
    /// The discriminated-union tag (§3c). Stored verbatim; unknown tags degrade
    /// on read to [`FieldKind::Unknown`] rather than failing.
    pub field_type: String,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub backing_column: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub in_property_policy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkTypeInput {
    pub stable_key: String,
    pub title: String,
    /// Optional reverse (back-)link name (design change-log 74).
    #[serde(default)]
    pub reverse_title: Option<String>,
    #[serde(default)]
    pub to_object_type_id: Option<ObjectTypeId>,
    pub cardinality: LinkCardinality,
    #[serde(default = "default_true")]
    pub traversable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionTypeInput {
    pub stable_key: String,
    pub title: String,
    #[serde(default)]
    pub params_schema: serde_json::Value,
    #[serde(default)]
    pub edits: serde_json::Value,
    #[serde(default)]
    pub submission_criteria: serde_json::Value,
    #[serde(default)]
    pub side_effects: serde_json::Value,
    pub dispatch: ActionDispatch,
    #[serde(default)]
    pub dispatch_target: Option<String>,
    #[serde(default)]
    pub control_points: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticInput {
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub formula: serde_json::Value,
    #[serde(default)]
    pub result_type: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateObjectTypeDraft {
    pub stable_key: String,
    pub title: String,
    #[serde(default)]
    pub title_property_key: Option<String>,
    pub backing_kind: BackingKind,
    #[serde(default)]
    pub backing_table: Option<String>,
    #[serde(default)]
    pub primary_key_property: Option<String>,
    #[serde(default)]
    pub properties: Vec<PropertyDefInput>,
    #[serde(default)]
    pub links: Vec<LinkTypeInput>,
    #[serde(default)]
    pub actions: Vec<ActionTypeInput>,
    #[serde(default)]
    pub analytics: Vec<AnalyticInput>,
}

const fn default_true() -> bool {
    true
}

// ===========================================================================
// Summaries (read models).
// ===========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectTypeSummary {
    pub id: ObjectTypeId,
    pub stable_key: String,
    pub title: String,
    pub backing_kind: BackingKind,
    pub schema_version: i64,
    pub lifecycle_state: SchemaLifecycleState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertyDefSummary {
    pub id: PropertyDefId,
    pub key: String,
    pub title: String,
    /// Raw stored tag.
    pub field_type: String,
    /// Parsed tag; [`FieldKind::Unknown`] for a tag this build does not know.
    pub field_kind: FieldKind,
    pub config: serde_json::Value,
    pub backing_column: Option<String>,
    pub required: bool,
    pub in_property_policy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkTypeSummary {
    pub id: LinkTypeId,
    pub stable_key: String,
    pub title: String,
    /// Optional reverse (back-)link name (design change-log 74).
    pub reverse_title: Option<String>,
    pub to_object_type_id: Option<ObjectTypeId>,
    pub cardinality: LinkCardinality,
    pub traversable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionTypeSummary {
    pub id: ActionTypeId,
    pub stable_key: String,
    pub title: String,
    pub params_schema: serde_json::Value,
    pub edits: serde_json::Value,
    pub submission_criteria: serde_json::Value,
    pub side_effects: serde_json::Value,
    pub dispatch: ActionDispatch,
    pub dispatch_target: Option<String>,
    pub control_points: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticSummary {
    pub id: AnalyticId,
    pub key: String,
    pub title: String,
    pub formula: serde_json::Value,
    pub result_type: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectTypeDetail {
    pub object_type: ObjectTypeSummary,
    pub title_property_key: Option<String>,
    pub backing_table: Option<String>,
    pub primary_key_property: Option<String>,
    pub properties: Vec<PropertyDefSummary>,
    pub links: Vec<LinkTypeSummary>,
    pub actions: Vec<ActionTypeSummary>,
    pub analytics: Vec<AnalyticSummary>,
}

// ===========================================================================
// Store.
// ===========================================================================

#[derive(Debug, Clone)]
pub struct PgOntologyStore {
    pool: PgPool,
}

impl PgOntologyStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Create a brand-new object type as schema_version 1 in `draft`, together
    /// with its full child snapshot, in one audited transaction.
    pub async fn create_object_type(
        &self,
        actor: UserId,
        draft: CreateObjectTypeDraft,
        trace: TraceContext,
        occurred_at: OffsetDateTime,
    ) -> Result<ObjectTypeSummary, PgOntologyError> {
        validate_draft(&draft)?;
        let object_type_id = ObjectTypeId::new();
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = ontology_audit_event(
            "ontology.object_type.create",
            actor,
            object_type_id,
            trace,
            occurred_at,
        )?
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "stable_key": draft.stable_key,
                "schema_version": 1,
                "lifecycle_state": SchemaLifecycleState::Draft.as_db_str(),
            })),
        );

        with_audit::<_, ObjectTypeSummary, PgOntologyError>(&self.pool, event, |tx| {
            Box::pin(async move {
                insert_object_type_version_tx(
                    tx,
                    object_type_id,
                    org_uuid,
                    actor,
                    &draft,
                    1,
                    occurred_at,
                )
                .await?;
                object_type_summary_by_id_tx(tx, object_type_id).await
            })
        })
        .await
    }

    /// Stage a v+1 revision draft for an existing object-type key. The new draft
    /// carries the caller's full replacement snapshot; existing published/older
    /// versions are untouched (immutable history). Fails closed if the key is
    /// unknown to the tenant or a draft is already in flight (partial unique idx).
    pub async fn stage_revision(
        &self,
        actor: UserId,
        stable_key: &str,
        draft: CreateObjectTypeDraft,
        trace: TraceContext,
        occurred_at: OffsetDateTime,
    ) -> Result<ObjectTypeSummary, PgOntologyError> {
        if draft.stable_key != stable_key {
            return Err(
                KernelError::validation("draft stable_key must match the revised type").into(),
            );
        }
        validate_draft(&draft)?;
        let object_type_id = ObjectTypeId::new();
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let stable_key = stable_key.to_owned();
        let event = ontology_audit_event(
            "ontology.object_type.stage_revision",
            actor,
            object_type_id,
            trace,
            occurred_at,
        )?
        .with_org(org);

        with_audit::<_, ObjectTypeSummary, PgOntologyError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let current_max: Option<i64> = sqlx::query_scalar(
                    "SELECT MAX(schema_version) FROM ont_object_types WHERE stable_key = $1",
                )
                .bind(&stable_key)
                .fetch_one(tx.as_mut())
                .await?;
                let next_version = current_max.ok_or_else(|| {
                    KernelError::not_found("no existing object type for that key to revise")
                })? + 1;
                insert_object_type_version_tx(
                    tx,
                    object_type_id,
                    org_uuid,
                    actor,
                    &draft,
                    next_version,
                    occurred_at,
                )
                .await?;
                object_type_summary_by_id_tx(tx, object_type_id).await
            })
        })
        .await
    }

    /// Advance one object-type version along the §3a lifecycle FSM. Publishing a
    /// version supersedes the key's currently-published head in the same tx, so
    /// the "one published per key" invariant holds atomically.
    pub async fn transition_lifecycle(
        &self,
        actor: UserId,
        object_type_id: ObjectTypeId,
        to: SchemaLifecycleState,
        protection_enabled: bool,
        trace: TraceContext,
        occurred_at: OffsetDateTime,
    ) -> Result<ObjectTypeSummary, PgOntologyError> {
        let org = current_org().map_err(KernelError::from)?;
        let event = ontology_audit_event(
            "ontology.object_type.transition",
            actor,
            object_type_id,
            trace,
            occurred_at,
        )?
        .with_org(org);

        with_audit::<_, ObjectTypeSummary, PgOntologyError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    "SELECT stable_key, lifecycle_state FROM ont_object_types WHERE id = $1 FOR UPDATE",
                )
                .bind(*object_type_id.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("object type version was not found"))?;
                let stable_key: String = row.try_get("stable_key")?;
                let from = SchemaLifecycleState::from_db_str(row.try_get("lifecycle_state")?)?;
                validate_schema_transition(from, to, protection_enabled)?;

                if to == SchemaLifecycleState::Published {
                    // Supersede the prior published head (if any, and not self).
                    sqlx::query(
                        r#"
                        UPDATE ont_object_types
                        SET lifecycle_state = 'superseded', updated_at = $3
                        WHERE stable_key = $1
                          AND lifecycle_state = 'published'
                          AND id <> $2
                        "#,
                    )
                    .bind(&stable_key)
                    .bind(*object_type_id.as_uuid())
                    .bind(occurred_at)
                    .execute(tx.as_mut())
                    .await?;
                }

                sqlx::query(
                    "UPDATE ont_object_types SET lifecycle_state = $2, updated_at = $3 WHERE id = $1",
                )
                .bind(*object_type_id.as_uuid())
                .bind(to.as_db_str())
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;

                object_type_summary_by_id_tx(tx, object_type_id).await
            })
        })
        .await
    }

    /// List the current head per object-type key (the published version if one
    /// exists, else the highest schema_version), tenant-scoped by RLS.
    pub async fn list_object_types(&self) -> Result<Vec<ObjectTypeSummary>, PgOntologyError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, Vec<ObjectTypeSummary>, PgOntologyError>(&self.pool, org, |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    r#"
                    SELECT DISTINCT ON (stable_key)
                        id, stable_key, title, backing_kind, schema_version, lifecycle_state
                    FROM ont_object_types
                    ORDER BY stable_key,
                             (lifecycle_state = 'published') DESC,
                             schema_version DESC
                    "#,
                )
                .fetch_all(tx.as_mut())
                .await?;
                rows.iter().map(object_type_summary_from_row).collect()
            })
        })
        .await
    }

    /// Fetch one object-type version plus its full child snapshot. With
    /// `version = None` the head (published, else latest) is returned; with an
    /// explicit version, that exact revision (as-of schema).
    pub async fn get_object_type(
        &self,
        stable_key: &str,
        version: Option<i64>,
    ) -> Result<ObjectTypeDetail, PgOntologyError> {
        let org = current_org().map_err(KernelError::from)?;
        let stable_key = stable_key.to_owned();
        with_org_conn::<_, ObjectTypeDetail, PgOntologyError>(&self.pool, org, |tx| {
            Box::pin(async move {
                let head = sqlx::query(
                    r#"
                    SELECT DISTINCT ON (stable_key)
                        id, stable_key, title, title_property_key, backing_kind,
                        backing_table, primary_key_property, schema_version, lifecycle_state
                    FROM ont_object_types
                    WHERE stable_key = $1
                      AND ($2::BIGINT IS NULL OR schema_version = $2)
                    ORDER BY stable_key,
                             (lifecycle_state = 'published') DESC,
                             schema_version DESC
                    "#,
                )
                .bind(&stable_key)
                .bind(version)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("object type was not found"))?;

                let object_type = object_type_summary_from_row(&head)?;
                let type_id = *object_type.id.as_uuid();

                let properties = sqlx::query(
                    r#"
                    SELECT id, key, title, type, config, backing_column, required, in_property_policy
                    FROM ont_property_defs
                    WHERE object_type_id = $1
                    ORDER BY key
                    "#,
                )
                .bind(type_id)
                .fetch_all(tx.as_mut())
                .await?
                .iter()
                .map(property_def_from_row)
                .collect::<Result<Vec<_>, _>>()?;

                let links = sqlx::query(
                    r#"
                    SELECT id, stable_key, title, reverse_title, to_object_type_id,
                           cardinality, traversable
                    FROM ont_link_types
                    WHERE object_type_id = $1
                    ORDER BY stable_key
                    "#,
                )
                .bind(type_id)
                .fetch_all(tx.as_mut())
                .await?
                .iter()
                .map(link_type_from_row)
                .collect::<Result<Vec<_>, _>>()?;

                let actions = sqlx::query(
                    r#"
                    SELECT id, stable_key, title, params_schema, edits, submission_criteria,
                           side_effects, dispatch, dispatch_target, control_points
                    FROM ont_action_types
                    WHERE object_type_id = $1
                    ORDER BY stable_key
                    "#,
                )
                .bind(type_id)
                .fetch_all(tx.as_mut())
                .await?
                .iter()
                .map(action_type_from_row)
                .collect::<Result<Vec<_>, _>>()?;

                let analytics = sqlx::query(
                    r#"
                    SELECT id, key, title, formula, result_type
                    FROM ont_analytics
                    WHERE object_type_id = $1
                    ORDER BY key
                    "#,
                )
                .bind(type_id)
                .fetch_all(tx.as_mut())
                .await?
                .iter()
                .map(analytic_from_row)
                .collect::<Result<Vec<_>, _>>()?;

                Ok(ObjectTypeDetail {
                    object_type,
                    title_property_key: head.try_get("title_property_key")?,
                    backing_table: head.try_get("backing_table")?,
                    primary_key_property: head.try_get("primary_key_property")?,
                    properties,
                    links,
                    actions,
                    analytics,
                })
            })
        })
        .await
    }

    /// Resolve one action type by its `(object_type_id, stable_key)` — the pair
    /// that uniquely identifies an action within the tenant (action `stable_key`
    /// is a single segment, unique per object-type version). RLS-scoped: an action
    /// belonging to another tenant returns `None`, never leaks. `None` = the key
    /// is unknown to this tenant/object type.
    pub async fn get_action_type(
        &self,
        object_type_id: ObjectTypeId,
        action_key: &str,
    ) -> Result<Option<ActionTypeSummary>, PgOntologyError> {
        let org = current_org().map_err(KernelError::from)?;
        let action_key = action_key.to_owned();
        with_org_conn::<_, Option<ActionTypeSummary>, PgOntologyError>(&self.pool, org, |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    SELECT id, stable_key, title, params_schema, edits, submission_criteria,
                           side_effects, dispatch, dispatch_target, control_points
                    FROM ont_action_types
                    WHERE object_type_id = $1 AND stable_key = $2
                    "#,
                )
                .bind(*object_type_id.as_uuid())
                .bind(&action_key)
                .fetch_optional(tx.as_mut())
                .await?;
                row.as_ref().map(action_type_from_row).transpose()
            })
        })
        .await
    }

    /// Read-only §2 "dynamics": the automation rules + PBAC policies acting on this
    /// instance's object type — workflow definitions bound to the type key, plus
    /// object-policy (row) and property-policy (field) attachments for the type.
    /// RLS-scoped; a cross-org / unknown id yields `NotFound` (no existence leak).
    pub async fn acting_on_instance(
        &self,
        instance_id: uuid::Uuid,
    ) -> Result<Vec<ActingRule>, PgOntologyError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, Vec<ActingRule>, PgOntologyError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                // Resolve the instance's type (RLS-scoped): missing ⇒ NotFound.
                let type_row = sqlx::query(
                    r#"
                    SELECT o.stable_key AS stable_key, i.object_type_id AS object_type_id
                    FROM ont_instances i
                    JOIN ont_object_types o ON o.id = i.object_type_id
                    WHERE i.id = $1
                    "#,
                )
                .bind(instance_id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("instance was not found"))?;
                let stable_key: String = type_row.try_get("stable_key")?;
                let object_type_id: uuid::Uuid = type_row.try_get("object_type_id")?;

                let mut acting = Vec::new();

                // Automations: live workflow definitions bound to the type key.
                let automations = sqlx::query(
                    r#"
                    SELECT id, display_name
                    FROM workflow_definitions
                    WHERE object_type = $1 AND status <> 'RETIRED'
                    ORDER BY updated_at DESC
                    "#,
                )
                .bind(&stable_key)
                .fetch_all(tx.as_mut())
                .await?;
                for row in &automations {
                    acting.push(ActingRule {
                        id: row.try_get("id")?,
                        label: row.try_get("display_name")?,
                        kind: ActingKind::Automation,
                    });
                }

                // Policies: object-policy (row) + property-policy (field) attachments
                // for this type, labelled by the authored catalog title.
                let policies = sqlx::query(
                    r#"
                    SELECT c.id AS id, c.title AS title
                    FROM ont_object_policies a
                    JOIN cedar_policy_catalog_entries c
                      ON c.id = a.cedar_policy_id AND c.org_id = a.org_id
                    WHERE a.object_type_id = $1
                    UNION
                    SELECT c.id AS id, c.title AS title
                    FROM ont_property_policies a
                    JOIN cedar_policy_catalog_entries c
                      ON c.id = a.cedar_policy_id AND c.org_id = a.org_id
                    WHERE a.property_def_id IN (
                        SELECT id FROM ont_property_defs WHERE object_type_id = $1
                    )
                    "#,
                )
                .bind(object_type_id)
                .fetch_all(tx.as_mut())
                .await?;
                for row in &policies {
                    acting.push(ActingRule {
                        id: row.try_get("id")?,
                        label: row.try_get("title")?,
                        kind: ActingKind::Policy,
                    });
                }

                Ok(acting)
            })
        })
        .await
    }

    /// Resolve a human-facing instance `code` (the head revision's `code` attribute)
    /// to its identity, for run-log chips + drag-drop lookups. RLS-scoped and
    /// deny-by-omission: another tenant's code — or an unknown one — resolves to
    /// `None`, which the caller renders as a 404 (never a 403), so the endpoint
    /// leaks neither existence nor cross-tenant membership.
    // ponytail: matches the head revision's `code` attribute; lift to a per-type
    // configurable code property if a type ever names its code column differently.
    pub async fn resolve_by_code(
        &self,
        code: &str,
    ) -> Result<Option<ResolvedInstance>, PgOntologyError> {
        let org = current_org().map_err(KernelError::from)?;
        let code = code.to_owned();
        with_org_conn::<_, Option<ResolvedInstance>, PgOntologyError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    SELECT i.id AS id, o.stable_key AS type_key, i.title AS title
                    FROM ont_instances i
                    JOIN ont_object_types o ON o.id = i.object_type_id
                    JOIN ont_instance_revisions r
                      ON r.instance_id = i.id AND r.valid_to IS NULL
                    WHERE r.attributes->>'code' = $1
                    LIMIT 1
                    "#,
                )
                .bind(&code)
                .fetch_optional(tx.as_mut())
                .await?;
                row.as_ref()
                    .map(|row| {
                        Ok::<_, PgOntologyError>(ResolvedInstance {
                            id: row.try_get("id")?,
                            type_key: row.try_get("type_key")?,
                            title: row.try_get("title")?,
                        })
                    })
                    .transpose()
            })
        })
        .await
    }
}

/// One automation rule or PBAC policy acting on an object type (§2 dynamics).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActingRule {
    pub id: uuid::Uuid,
    pub label: String,
    pub kind: ActingKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActingKind {
    Automation,
    Policy,
}

/// A code→instance resolution: the instance identity + its object-type key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedInstance {
    pub id: uuid::Uuid,
    #[serde(rename = "type")]
    pub type_key: String,
    pub title: String,
}

// ===========================================================================
// tx helpers
// ===========================================================================

async fn insert_object_type_version_tx(
    tx: &mut Transaction<'_, Postgres>,
    object_type_id: ObjectTypeId,
    org_uuid: uuid::Uuid,
    actor: UserId,
    draft: &CreateObjectTypeDraft,
    schema_version: i64,
    occurred_at: OffsetDateTime,
) -> Result<(), PgOntologyError> {
    sqlx::query(
        r#"
        INSERT INTO ont_object_types (
            id, org_id, stable_key, title, title_property_key,
            backing_kind, backing_table, primary_key_property,
            schema_version, lifecycle_state, created_by, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $11, $11)
        "#,
    )
    .bind(*object_type_id.as_uuid())
    .bind(org_uuid)
    .bind(draft.stable_key.trim())
    .bind(draft.title.trim())
    .bind(draft.title_property_key.as_deref())
    .bind(draft.backing_kind.as_db_str())
    .bind(draft.backing_table.as_deref())
    .bind(draft.primary_key_property.as_deref())
    .bind(schema_version)
    .bind(*actor.as_uuid())
    .bind(occurred_at)
    .execute(tx.as_mut())
    .await?;

    for property in &draft.properties {
        sqlx::query(
            r#"
            INSERT INTO ont_property_defs (
                id, org_id, object_type_id, key, title, type, config,
                backing_column, required, in_property_policy
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
        )
        .bind(*PropertyDefId::new().as_uuid())
        .bind(org_uuid)
        .bind(*object_type_id.as_uuid())
        .bind(property.key.trim())
        .bind(property.title.trim())
        .bind(property.field_type.trim())
        .bind(json_or_empty_object(&property.config))
        .bind(property.backing_column.as_deref())
        .bind(property.required)
        .bind(property.in_property_policy)
        .execute(tx.as_mut())
        .await?;
    }

    for link in &draft.links {
        sqlx::query(
            r#"
            INSERT INTO ont_link_types (
                id, org_id, object_type_id, stable_key, title, reverse_title,
                to_object_type_id, cardinality, traversable
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
        )
        .bind(*LinkTypeId::new().as_uuid())
        .bind(org_uuid)
        .bind(*object_type_id.as_uuid())
        .bind(link.stable_key.trim())
        .bind(link.title.trim())
        .bind(link.reverse_title.as_deref().map(str::trim))
        .bind(link.to_object_type_id.map(|id| *id.as_uuid()))
        .bind(link.cardinality.as_db_str())
        .bind(link.traversable)
        .execute(tx.as_mut())
        .await?;
    }

    for action in &draft.actions {
        sqlx::query(
            r#"
            INSERT INTO ont_action_types (
                id, org_id, object_type_id, stable_key, title, params_schema,
                edits, submission_criteria, side_effects, dispatch,
                dispatch_target, control_points
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            "#,
        )
        .bind(*ActionTypeId::new().as_uuid())
        .bind(org_uuid)
        .bind(*object_type_id.as_uuid())
        .bind(action.stable_key.trim())
        .bind(action.title.trim())
        .bind(json_or_empty_object(&action.params_schema))
        .bind(json_or_empty_array(&action.edits))
        .bind(json_or_empty_array(&action.submission_criteria))
        .bind(json_or_empty_array(&action.side_effects))
        .bind(action.dispatch.as_db_str())
        .bind(action.dispatch_target.as_deref())
        .bind(json_or_empty_array(&action.control_points))
        .execute(tx.as_mut())
        .await?;
    }

    for analytic in &draft.analytics {
        sqlx::query(
            r#"
            INSERT INTO ont_analytics (
                id, org_id, object_type_id, key, title, formula, result_type
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(*AnalyticId::new().as_uuid())
        .bind(org_uuid)
        .bind(*object_type_id.as_uuid())
        .bind(analytic.key.trim())
        .bind(analytic.title.trim())
        .bind(json_or_empty_object(&analytic.formula))
        .bind(json_or_empty_object(&analytic.result_type))
        .execute(tx.as_mut())
        .await?;
    }

    Ok(())
}

async fn object_type_summary_by_id_tx(
    tx: &mut Transaction<'_, Postgres>,
    object_type_id: ObjectTypeId,
) -> Result<ObjectTypeSummary, PgOntologyError> {
    let row = sqlx::query(
        r#"
        SELECT id, stable_key, title, backing_kind, schema_version, lifecycle_state
        FROM ont_object_types
        WHERE id = $1
        "#,
    )
    .bind(*object_type_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("object type version was not found"))?;
    object_type_summary_from_row(&row)
}

// ===========================================================================
// row → summary mappers
// ===========================================================================

fn object_type_summary_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<ObjectTypeSummary, PgOntologyError> {
    Ok(ObjectTypeSummary {
        id: ObjectTypeId::from_uuid(row.try_get("id")?),
        stable_key: row.try_get("stable_key")?,
        title: row.try_get("title")?,
        backing_kind: BackingKind::from_db_str(row.try_get("backing_kind")?)?,
        schema_version: row.try_get("schema_version")?,
        lifecycle_state: SchemaLifecycleState::from_db_str(row.try_get("lifecycle_state")?)?,
    })
}

fn property_def_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<PropertyDefSummary, PgOntologyError> {
    let field_type: String = row.try_get("type")?;
    let field_kind = FieldKind::parse(&field_type);
    Ok(PropertyDefSummary {
        id: PropertyDefId::from_uuid(row.try_get("id")?),
        key: row.try_get("key")?,
        title: row.try_get("title")?,
        field_type,
        field_kind,
        config: row.try_get("config")?,
        backing_column: row.try_get("backing_column")?,
        required: row.try_get("required")?,
        in_property_policy: row.try_get("in_property_policy")?,
    })
}

fn link_type_from_row(row: &sqlx::postgres::PgRow) -> Result<LinkTypeSummary, PgOntologyError> {
    let to: Option<uuid::Uuid> = row.try_get("to_object_type_id")?;
    Ok(LinkTypeSummary {
        id: LinkTypeId::from_uuid(row.try_get("id")?),
        stable_key: row.try_get("stable_key")?,
        title: row.try_get("title")?,
        reverse_title: row.try_get("reverse_title")?,
        to_object_type_id: to.map(ObjectTypeId::from_uuid),
        cardinality: LinkCardinality::from_db_str(row.try_get("cardinality")?)?,
        traversable: row.try_get("traversable")?,
    })
}

fn action_type_from_row(row: &sqlx::postgres::PgRow) -> Result<ActionTypeSummary, PgOntologyError> {
    Ok(ActionTypeSummary {
        id: ActionTypeId::from_uuid(row.try_get("id")?),
        stable_key: row.try_get("stable_key")?,
        title: row.try_get("title")?,
        params_schema: row.try_get("params_schema")?,
        edits: row.try_get("edits")?,
        submission_criteria: row.try_get("submission_criteria")?,
        side_effects: row.try_get("side_effects")?,
        dispatch: ActionDispatch::from_db_str(row.try_get("dispatch")?)?,
        dispatch_target: row.try_get("dispatch_target")?,
        control_points: row.try_get("control_points")?,
    })
}

fn analytic_from_row(row: &sqlx::postgres::PgRow) -> Result<AnalyticSummary, PgOntologyError> {
    Ok(AnalyticSummary {
        id: AnalyticId::from_uuid(row.try_get("id")?),
        key: row.try_get("key")?,
        title: row.try_get("title")?,
        formula: row.try_get("formula")?,
        result_type: row.try_get("result_type")?,
    })
}

// ===========================================================================
// small helpers
// ===========================================================================

fn ontology_audit_event(
    action: &str,
    actor: UserId,
    object_type_id: ObjectTypeId,
    trace: TraceContext,
    occurred_at: OffsetDateTime,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action)?,
        "ont_object_types",
        object_type_id.to_string(),
        trace,
        occurred_at,
    ))
}

/// The registry JSONB columns are `CHECK (jsonb_typeof = 'object')`; a caller
/// that left the field as JSON `null` gets an empty object instead of a CHECK
/// violation. Non-null values pass through untouched.
fn json_or_empty_object(value: &serde_json::Value) -> serde_json::Value {
    if value.is_object() {
        value.clone()
    } else {
        serde_json::json!({})
    }
}

/// Same as [`json_or_empty_object`] for the `CHECK (jsonb_typeof = 'array')`
/// columns.
fn json_or_empty_array(value: &serde_json::Value) -> serde_json::Value {
    if value.is_array() {
        value.clone()
    } else {
        serde_json::json!([])
    }
}

fn validate_draft(draft: &CreateObjectTypeDraft) -> Result<(), PgOntologyError> {
    if draft.stable_key.trim().is_empty() {
        return Err(KernelError::validation("object type stable_key is required").into());
    }
    if draft.title.trim().is_empty() {
        return Err(KernelError::validation("object type title is required").into());
    }
    match draft.backing_kind {
        BackingKind::Projected => {
            if draft
                .backing_table
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
                || draft
                    .primary_key_property
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
            {
                return Err(KernelError::validation(
                    "projected object types require backing_table and primary_key_property",
                )
                .into());
            }
        }
        BackingKind::Instance => {
            if draft.backing_table.is_some() || draft.primary_key_property.is_some() {
                return Err(KernelError::validation(
                    "instance object types must not carry a backing table",
                )
                .into());
            }
        }
    }
    Ok(())
}
