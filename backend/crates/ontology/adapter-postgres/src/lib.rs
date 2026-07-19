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
use mnt_platform_db::{DbError, with_audit, with_audits, with_org_conn};
use mnt_platform_request_context::current_org;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::HashMap;
use time::OffsetDateTime;

#[derive(Debug, thiserror::Error)]
pub enum PgOntologyError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),

    #[error("ontology object type write precondition failed")]
    PreconditionFailed { current: ObjectTypeWriteVersion },
}

impl From<sqlx::Error> for PgOntologyError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

// ===========================================================================
// Inputs (a complete schema snapshot for one object-type version).
// ===========================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PropertyDefInput {
    pub key: String,
    pub title: String,
    /// The discriminated-union tag (§3c). Stored verbatim; unknown tags degrade
    /// on read to [`FieldKind::Unknown`] rather than failing.
    pub field_type: String,
    #[serde(default = "empty_json_object")]
    pub config: serde_json::Value,
    #[serde(default)]
    pub backing_column: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub in_property_policy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionTypeInput {
    pub stable_key: String,
    pub title: String,
    #[serde(default = "empty_json_object")]
    pub params_schema: serde_json::Value,
    #[serde(default = "empty_json_array")]
    pub edits: serde_json::Value,
    #[serde(default = "empty_json_array")]
    pub submission_criteria: serde_json::Value,
    #[serde(default = "empty_json_array")]
    pub side_effects: serde_json::Value,
    pub dispatch: ActionDispatch,
    #[serde(default)]
    pub dispatch_target: Option<String>,
    #[serde(default = "empty_json_array")]
    pub control_points: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnalyticInput {
    pub key: String,
    pub title: String,
    #[serde(default = "empty_json_object")]
    pub formula: serde_json::Value,
    #[serde(default = "empty_json_object")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectTypeWriteVersion {
    pub etag: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectTypeWritePrecondition {
    pub validator_id: uuid::Uuid,
    pub revision: i64,
}

fn object_type_key_etag(validator_id: uuid::Uuid, revision: i64) -> String {
    format!(
        "\"ont-object-type-key:{}:r{revision}\"",
        validator_id.simple()
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectTypeSummary {
    pub id: ObjectTypeId,
    pub stable_key: String,
    pub title: String,
    pub backing_kind: BackingKind,
    pub schema_version: i64,
    pub lifecycle_state: SchemaLifecycleState,
    pub key_write_revision: i64,
    pub key_write_etag: String,
    #[serde(skip, default = "uuid::Uuid::nil")]
    key_write_validator_id: uuid::Uuid,
}

impl ObjectTypeSummary {
    #[must_use]
    pub fn write_version(&self) -> ObjectTypeWriteVersion {
        ObjectTypeWriteVersion {
            etag: self.key_write_etag.clone(),
            revision: self.key_write_revision,
        }
    }

    #[must_use]
    pub fn write_precondition(&self) -> ObjectTypeWritePrecondition {
        ObjectTypeWritePrecondition {
            validator_id: self.key_write_validator_id,
            revision: self.key_write_revision,
        }
    }
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
                lock_object_type_key_tx(tx, org_uuid, &draft.stable_key).await?;
                let key_exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM ont_object_types WHERE org_id = $1 AND stable_key = $2)",
                )
                .bind(org_uuid)
                .bind(&draft.stable_key)
                .fetch_one(tx.as_mut())
                .await?;
                if key_exists {
                    return Err(KernelError::conflict(
                        "an object type with that stable key already exists",
                    )
                    .into());
                }
                sqlx::query(
                    r#"
                    INSERT INTO ont_object_type_key_revisions (org_id, stable_key)
                    VALUES ($1, $2)
                    "#,
                )
                .bind(org_uuid)
                .bind(&draft.stable_key)
                .execute(tx.as_mut())
                .await?;
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
    /// versions are untouched (immutable history). An existing in-flight head is
    /// edited under the same tenant/key lock; an unknown key fails closed.
    pub async fn stage_revision(
        &self,
        actor: UserId,
        stable_key: &str,
        expected: ObjectTypeWritePrecondition,
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
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let stable_key = stable_key.to_owned();

        // The audit target cannot be chosen truthfully until the tenant/key lock
        // reveals whether this operation edits the in-flight head or creates a
        // new version. `with_audits` lets that identity be resolved inside the
        // same armed transaction and emits the resulting event before commit.
        with_audits::<_, ObjectTypeSummary, PgOntologyError>(&self.pool, org, |tx| {
            Box::pin(async move {
                lock_object_type_key_tx(tx, org_uuid, &stable_key).await?;
                advance_object_type_write_version_tx(
                    tx,
                    org_uuid,
                    &stable_key,
                    expected,
                    occurred_at,
                )
                .await?;
                let existing_draft = draft_head_id_tx(tx, org_uuid, &stable_key).await?;
                let object_type_id = existing_draft.unwrap_or_else(ObjectTypeId::new);

                if existing_draft.is_some() {
                    update_draft_head_tx(
                        tx,
                        object_type_id,
                        org_uuid,
                        &stable_key,
                        &draft,
                        occurred_at,
                    )
                    .await?;
                    append_new_draft_children_tx(tx, object_type_id, org_uuid, &draft).await?;
                } else {
                    let current_max: Option<i64> = sqlx::query_scalar(
                        "SELECT MAX(schema_version) FROM ont_object_types WHERE org_id = $1 AND stable_key = $2",
                    )
                    .bind(org_uuid)
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
                }
                let summary = object_type_summary_by_id_tx(tx, object_type_id).await?;
                let event = ontology_audit_event(
                    "ontology.object_type.stage_revision",
                    actor,
                    object_type_id,
                    trace,
                    occurred_at,
                )?
                .with_org(org);
                Ok((summary, vec![event]))
            })
        })
        .await
    }

    /// Advance one object-type version along the §3a lifecycle FSM. Publishing a
    /// version supersedes the key's currently-published head in the same tx, so
    /// the "one published per key" invariant holds atomically.
    #[allow(clippy::too_many_arguments)] // explicit CAS + lifecycle/audit context; a params struct adds no domain meaning
    pub async fn transition_lifecycle(
        &self,
        actor: UserId,
        object_type_id: ObjectTypeId,
        expected: ObjectTypeWritePrecondition,
        to: SchemaLifecycleState,
        protection_enabled: bool,
        trace: TraceContext,
        occurred_at: OffsetDateTime,
    ) -> Result<ObjectTypeSummary, PgOntologyError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
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
                let stable_key: String = sqlx::query_scalar(
                    "SELECT stable_key FROM ont_object_types WHERE id = $1 AND org_id = $2",
                )
                .bind(*object_type_id.as_uuid())
                .bind(org_uuid)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("object type version was not found"))?;
                lock_object_type_key_tx(tx, org_uuid, &stable_key).await?;
                advance_object_type_write_version_tx(
                    tx,
                    org_uuid,
                    &stable_key,
                    expected,
                    occurred_at,
                )
                .await?;
                let row = sqlx::query(
                    "SELECT lifecycle_state, backing_kind FROM ont_object_types WHERE id = $1 AND org_id = $2 AND stable_key = $3 FOR UPDATE",
                )
                .bind(*object_type_id.as_uuid())
                .bind(org_uuid)
                .bind(&stable_key)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("object type version was not found"))?;
                let from = SchemaLifecycleState::from_db_str(row.try_get("lifecycle_state")?)?;
                let backing_kind = BackingKind::from_db_str(row.try_get("backing_kind")?)?;
                validate_schema_transition(from, to, protection_enabled)?;

                if to == SchemaLifecycleState::Published {
                    // No-code gap ①: a user-authored instance-backed type
                    // published with no create-capable action would have no
                    // way to ever create an instance (there is no direct
                    // POST /instances — creation only happens via an
                    // `instance_revision` action). Auto-attach the same
                    // generic create action `seed.rs` hand-builds so the
                    // no-code loop (draft → publish → create instance) closes
                    // with zero engineering.
                    if backing_kind == BackingKind::Instance
                        && !has_create_capable_action_tx(tx, object_type_id, org_uuid).await?
                    {
                        insert_generic_create_action_tx(tx, object_type_id, org_uuid).await?;
                    }
                    // Supersede the prior published head (if any, and not self).
                    sqlx::query(
                        r#"
                        UPDATE ont_object_types
                        SET lifecycle_state = 'superseded', updated_at = $3
                        WHERE stable_key = $1 AND org_id = $4
                          AND lifecycle_state = 'published'
                          AND id <> $2
                        "#,
                    )
                    .bind(&stable_key)
                    .bind(*object_type_id.as_uuid())
                    .bind(occurred_at)
                    .bind(org_uuid)
                    .execute(tx.as_mut())
                    .await?;
                }

                let updated = sqlx::query(
                    "UPDATE ont_object_types SET lifecycle_state = $2, updated_at = $3 WHERE id = $1 AND org_id = $4 AND stable_key = $5 AND lifecycle_state = $6",
                )
                .bind(*object_type_id.as_uuid())
                .bind(to.as_db_str())
                .bind(occurred_at)
                .bind(org_uuid)
                .bind(&stable_key)
                .bind(from.as_db_str())
                .execute(tx.as_mut())
                .await?;
                if updated.rows_affected() != 1 {
                    return Err(KernelError::conflict(
                        "object type lifecycle changed while the transition was in flight",
                    )
                    .into());
                }

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
                    SELECT DISTINCT ON (o.stable_key)
                        o.id, o.stable_key, o.title, o.backing_kind, o.schema_version,
                        o.lifecycle_state, k.validator_id AS key_write_validator_id,
                        k.revision AS key_write_revision
                    FROM ont_object_types o
                    JOIN ont_object_type_key_revisions k USING (org_id, stable_key)
                    ORDER BY o.stable_key,
                             (o.lifecycle_state = 'published') DESC,
                             o.schema_version DESC
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
        let org_uuid = *org.as_uuid();
        let stable_key = stable_key.to_owned();
        with_org_conn::<_, ObjectTypeDetail, PgOntologyError>(&self.pool, org, |tx| {
            Box::pin(async move {
                let head = sqlx::query(
                    r#"
                    SELECT DISTINCT ON (o.stable_key)
                        o.id, o.stable_key, o.title, o.title_property_key, o.backing_kind,
                        o.backing_table, o.primary_key_property, o.schema_version,
                        o.lifecycle_state, k.validator_id AS key_write_validator_id,
                        k.revision AS key_write_revision
                    FROM ont_object_types o
                    JOIN ont_object_type_key_revisions k USING (org_id, stable_key)
                    WHERE o.stable_key = $1
                      AND ($2::BIGINT IS NULL OR o.schema_version = $2)
                      AND o.org_id = $3
                    ORDER BY o.stable_key,
                             (o.lifecycle_state = 'published') DESC,
                             o.schema_version DESC
                    "#,
                )
                .bind(&stable_key)
                .bind(version)
                .bind(org_uuid)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("object type was not found"))?;

                let object_type = object_type_summary_from_row(&head)?;
                let type_id = *object_type.id.as_uuid();

                let properties = sqlx::query(
                    r#"
                    SELECT id, key, title, type, config, backing_column, required, in_property_policy
                    FROM ont_property_defs
                    WHERE object_type_id = $1 AND org_id = $2
                    ORDER BY key
                    "#,
                )
                .bind(type_id)
                .bind(org_uuid)
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
                    WHERE object_type_id = $1 AND org_id = $2
                    ORDER BY stable_key
                    "#,
                )
                .bind(type_id)
                .bind(org_uuid)
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
                    WHERE object_type_id = $1 AND org_id = $2
                    ORDER BY stable_key
                    "#,
                )
                .bind(type_id)
                .bind(org_uuid)
                .fetch_all(tx.as_mut())
                .await?
                .iter()
                .map(action_type_from_row)
                .collect::<Result<Vec<_>, _>>()?;

                let analytics = sqlx::query(
                    r#"
                    SELECT id, key, title, formula, result_type
                    FROM ont_analytics
                    WHERE object_type_id = $1 AND org_id = $2
                    ORDER BY key
                    "#,
                )
                .bind(type_id)
                .bind(org_uuid)
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
        let org_uuid = *org.as_uuid();
        let action_key = action_key.to_owned();
        with_org_conn::<_, Option<ActionTypeSummary>, PgOntologyError>(&self.pool, org, |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    SELECT id, stable_key, title, params_schema, edits, submission_criteria,
                           side_effects, dispatch, dispatch_target, control_points
                    FROM ont_action_types
                    WHERE object_type_id = $1 AND stable_key = $2 AND org_id = $3
                    "#,
                )
                .bind(*object_type_id.as_uuid())
                .bind(&action_key)
                .bind(org_uuid)
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
        let org_uuid = *org.as_uuid();
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
                acting_rules_tx(tx, org_uuid, &stable_key, object_type_id).await
            })
        })
        .await
    }

    /// The same §2 "dynamics" read as `acting_on_instance`, keyed by the object
    /// type itself (the 자동화 subtab of the Ontology Manager, which is
    /// type-centric and may have no instances). RLS-scoped; an unknown key yields
    /// `NotFound`. Resolves the key to its head version so property-policy
    /// attachments (per-version `property_def_id`) line up with the shown schema.
    pub async fn acting_on_type(
        &self,
        stable_key: &str,
    ) -> Result<Vec<ActingRule>, PgOntologyError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let stable_key = stable_key.to_owned();
        with_org_conn::<_, Vec<ActingRule>, PgOntologyError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                // Head version (published preferred, else highest) — same
                // resolution as get_object_type, RLS-scoped.
                let object_type_id: uuid::Uuid = sqlx::query_scalar(
                    r#"
                    SELECT id FROM ont_object_types
                    WHERE stable_key = $1 AND org_id = $2
                    ORDER BY (lifecycle_state = 'published') DESC, schema_version DESC
                    LIMIT 1
                    "#,
                )
                .bind(&stable_key)
                .bind(org_uuid)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("object type was not found"))?;
                acting_rules_tx(tx, org_uuid, &stable_key, object_type_id).await
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

/// Whether this object-type version already has an action that can create an
/// instance (`instance_revision` dispatch). Scoped to this version's own
/// action rows — each schema version carries its own child snapshot.
async fn has_create_capable_action_tx(
    tx: &mut Transaction<'_, Postgres>,
    object_type_id: ObjectTypeId,
    org_uuid: uuid::Uuid,
) -> Result<bool, PgOntologyError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM ont_action_types WHERE object_type_id = $1 AND org_id = $2 AND dispatch = 'instance_revision')",
    )
    .bind(*object_type_id.as_uuid())
    .bind(org_uuid)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(exists)
}

/// Auto-attach the generic `create` action (no-code gap ①) built from this
/// version's own property defs — same builder `seed.rs` uses to provision the
/// default catalog, so both paths stay in lock-step.
async fn insert_generic_create_action_tx(
    tx: &mut Transaction<'_, Postgres>,
    object_type_id: ObjectTypeId,
    org_uuid: uuid::Uuid,
) -> Result<(), PgOntologyError> {
    let rows = sqlx::query(
        r#"
        SELECT key, title, type, config, backing_column, required, in_property_policy
        FROM ont_property_defs
        WHERE object_type_id = $1 AND org_id = $2
        ORDER BY key
        "#,
    )
    .bind(*object_type_id.as_uuid())
    .bind(org_uuid)
    .fetch_all(tx.as_mut())
    .await?;
    let properties = rows
        .iter()
        .map(|row| {
            Ok::<_, PgOntologyError>(PropertyDefInput {
                key: row.try_get("key")?,
                title: row.try_get("title")?,
                field_type: row.try_get("type")?,
                config: row.try_get("config")?,
                backing_column: row.try_get("backing_column")?,
                required: row.try_get("required")?,
                in_property_policy: row.try_get("in_property_policy")?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let action = seed::create_action(&properties);
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
    .bind(&action.params_schema)
    .bind(&action.edits)
    .bind(&action.submission_criteria)
    .bind(&action.side_effects)
    .bind(action.dispatch.as_db_str())
    .bind(action.dispatch_target.as_deref())
    .bind(&action.control_points)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

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

    insert_object_type_children_tx(tx, object_type_id, org_uuid, draft).await
}

/// Serialize every stage/lifecycle mutation for one tenant-scoped stable key.
///
/// The length-prefixed tenant/key encoding is unambiguous. PostgreSQL's 64-bit
/// hash can only make unrelated keys share a lock (safe over-serialization); it
/// cannot let equal keys acquire different locks. Transaction scope guarantees
/// release on commit or rollback, including every error path.
async fn lock_object_type_key_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    stable_key: &str,
) -> Result<(), PgOntologyError> {
    let key = format!(
        "{}:{}:{stable_key}",
        org_uuid.as_hyphenated(),
        stable_key.len()
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(key)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

async fn current_object_type_write_version_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    stable_key: &str,
) -> Result<(uuid::Uuid, ObjectTypeWriteVersion), PgOntologyError> {
    let row = sqlx::query(
        r#"
        SELECT validator_id, revision
        FROM ont_object_type_key_revisions
        WHERE org_id = $1 AND stable_key = $2
        "#,
    )
    .bind(org_uuid)
    .bind(stable_key)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("object type was not found"))?;
    let validator_id: uuid::Uuid = row.try_get("validator_id")?;
    let revision: i64 = row.try_get("revision")?;
    Ok((
        validator_id,
        ObjectTypeWriteVersion {
            etag: object_type_key_etag(validator_id, revision),
            revision,
        },
    ))
}

async fn advance_object_type_write_version_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    stable_key: &str,
    expected: ObjectTypeWritePrecondition,
    occurred_at: OffsetDateTime,
) -> Result<ObjectTypeWriteVersion, PgOntologyError> {
    let (current_validator_id, current) =
        current_object_type_write_version_tx(tx, org_uuid, stable_key).await?;
    if current_validator_id != expected.validator_id || current.revision != expected.revision {
        return Err(PgOntologyError::PreconditionFailed { current });
    }
    let revision: Option<i64> = sqlx::query_scalar(
        r#"
        UPDATE ont_object_type_key_revisions
        SET revision = revision + 1, updated_at = $5
        WHERE org_id = $1 AND stable_key = $2
          AND validator_id = $3 AND revision = $4
        RETURNING revision
        "#,
    )
    .bind(org_uuid)
    .bind(stable_key)
    .bind(expected.validator_id)
    .bind(expected.revision)
    .bind(occurred_at)
    .fetch_optional(tx.as_mut())
    .await?;
    match revision {
        Some(revision) => Ok(ObjectTypeWriteVersion {
            etag: object_type_key_etag(expected.validator_id, revision),
            revision,
        }),
        None => {
            let (_, current) =
                current_object_type_write_version_tx(tx, org_uuid, stable_key).await?;
            Err(PgOntologyError::PreconditionFailed { current })
        }
    }
}

/// Resolve the single mutable draft only after the tenant/key serialization lock
/// is held. A submitted review head is row-locked and rejected: only the explicit
/// reviewer send-back transition may make its content editable again.
async fn draft_head_id_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    stable_key: &str,
) -> Result<Option<ObjectTypeId>, PgOntologyError> {
    let row = sqlx::query(
        r#"
        SELECT id, lifecycle_state FROM ont_object_types
        WHERE org_id = $1 AND stable_key = $2
          AND lifecycle_state IN ('draft', 'review_pending')
        FOR UPDATE
        "#,
    )
    .bind(org_uuid)
    .bind(stable_key)
    .fetch_optional(tx.as_mut())
    .await?;
    match row {
        None => Ok(None),
        Some(row) => {
            let lifecycle_state: String = row.try_get("lifecycle_state")?;
            if lifecycle_state == SchemaLifecycleState::ReviewPending.as_db_str() {
                return Err(KernelError::conflict(
                    "review-pending object type must be returned to draft before editing",
                )
                .into());
            }
            let id: uuid::Uuid = row.try_get("id")?;
            Ok(Some(ObjectTypeId::from_uuid(id)))
        }
    }
}

/// §2 dynamics for one object type: live workflow definitions bound to its key
/// (automations) plus object-/property-policy attachments (policies), labelled by
/// the authored catalog title. Shared by the instance- and type-keyed reads.
async fn acting_rules_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    stable_key: &str,
    object_type_id: uuid::Uuid,
) -> Result<Vec<ActingRule>, PgOntologyError> {
    let mut acting = Vec::new();

    let automations = sqlx::query(
        r#"
        SELECT id, display_name
        FROM workflow_definitions
        WHERE object_type = $1 AND org_id = $2 AND status <> 'RETIRED'
        ORDER BY updated_at DESC
        "#,
    )
    .bind(stable_key)
    .bind(org_uuid)
    .fetch_all(tx.as_mut())
    .await?;
    for row in &automations {
        acting.push(ActingRule {
            id: row.try_get("id")?,
            label: row.try_get("display_name")?,
            kind: ActingKind::Automation,
        });
    }

    let policies = sqlx::query(
        r#"
        SELECT c.id AS id, c.title AS title
        FROM ont_object_policies a
        JOIN cedar_policy_catalog_entries c
          ON c.id = a.cedar_policy_id AND c.org_id = a.org_id
        WHERE a.object_type_id = $1 AND a.org_id = $2
        UNION
        SELECT c.id AS id, c.title AS title
        FROM ont_property_policies a
        JOIN cedar_policy_catalog_entries c
          ON c.id = a.cedar_policy_id AND c.org_id = a.org_id
        WHERE a.org_id = $2
          AND a.property_def_id IN (
            SELECT id FROM ont_property_defs WHERE object_type_id = $1 AND org_id = $2
        )
        "#,
    )
    .bind(object_type_id)
    .bind(org_uuid)
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
}

/// Rewrite an in-flight draft's head fields in place (schema_version,
/// lifecycle_state, stable_key and authorship are immutable and left untouched).
async fn update_draft_head_tx(
    tx: &mut Transaction<'_, Postgres>,
    object_type_id: ObjectTypeId,
    org_uuid: uuid::Uuid,
    stable_key: &str,
    draft: &CreateObjectTypeDraft,
    occurred_at: OffsetDateTime,
) -> Result<(), PgOntologyError> {
    let updated = sqlx::query(
        r#"
        UPDATE ont_object_types
        SET title = $2, title_property_key = $3, backing_kind = $4,
            backing_table = $5, primary_key_property = $6, updated_at = $7
        WHERE id = $1
          AND org_id = $8
          AND stable_key = $9
          AND lifecycle_state = 'draft'
        "#,
    )
    .bind(*object_type_id.as_uuid())
    .bind(draft.title.trim())
    .bind(draft.title_property_key.as_deref())
    .bind(draft.backing_kind.as_db_str())
    .bind(draft.backing_table.as_deref())
    .bind(draft.primary_key_property.as_deref())
    .bind(occurred_at)
    .bind(org_uuid)
    .bind(stable_key)
    .execute(tx.as_mut())
    .await?;
    if updated.rows_affected() != 1 {
        return Err(KernelError::conflict(
            "object type draft changed lifecycle while the revision was in flight",
        )
        .into());
    }
    Ok(())
}

/// Append only genuinely new child identities to a mutable draft.
///
/// Existing equal key/payload pairs are idempotent replays. Reusing an identity
/// for a different canonical payload is a typed conflict; silently retaining
/// either definition would make the final schema depend on transport order.
async fn append_new_draft_children_tx(
    tx: &mut Transaction<'_, Postgres>,
    object_type_id: ObjectTypeId,
    org_uuid: uuid::Uuid,
    draft: &CreateObjectTypeDraft,
) -> Result<(), PgOntologyError> {
    let id = *object_type_id.as_uuid();

    let properties = sqlx::query(
        r#"
        SELECT key, title, type, config, backing_column, required, in_property_policy
        FROM ont_property_defs
        WHERE object_type_id = $1 AND org_id = $2
        "#,
    )
    .bind(id)
    .bind(org_uuid)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .map(|row| {
        Ok(PropertyDefInput {
            key: row.try_get("key")?,
            title: row.try_get("title")?,
            field_type: row.try_get("type")?,
            config: row.try_get("config")?,
            backing_column: row.try_get("backing_column")?,
            required: row.try_get("required")?,
            in_property_policy: row.try_get("in_property_policy")?,
        })
    })
    .collect::<Result<Vec<_>, PgOntologyError>>()?;

    let links = sqlx::query(
        r#"
        SELECT stable_key, title, reverse_title, to_object_type_id, cardinality, traversable
        FROM ont_link_types
        WHERE object_type_id = $1 AND org_id = $2
        "#,
    )
    .bind(id)
    .bind(org_uuid)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .map(|row| {
        let target = row
            .try_get::<Option<uuid::Uuid>, _>("to_object_type_id")?
            .map(ObjectTypeId::from_uuid);
        let cardinality = row.try_get::<String, _>("cardinality")?;
        Ok(LinkTypeInput {
            stable_key: row.try_get("stable_key")?,
            title: row.try_get("title")?,
            reverse_title: row.try_get("reverse_title")?,
            to_object_type_id: target,
            cardinality: LinkCardinality::from_db_str(&cardinality)?,
            traversable: row.try_get("traversable")?,
        })
    })
    .collect::<Result<Vec<_>, PgOntologyError>>()?;

    let actions = sqlx::query(
        r#"
        SELECT stable_key, title, params_schema, edits, submission_criteria,
               side_effects, dispatch, dispatch_target, control_points
        FROM ont_action_types
        WHERE object_type_id = $1 AND org_id = $2
        "#,
    )
    .bind(id)
    .bind(org_uuid)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .map(|row| {
        let dispatch = row.try_get::<String, _>("dispatch")?;
        Ok(ActionTypeInput {
            stable_key: row.try_get("stable_key")?,
            title: row.try_get("title")?,
            params_schema: row.try_get("params_schema")?,
            edits: row.try_get("edits")?,
            submission_criteria: row.try_get("submission_criteria")?,
            side_effects: row.try_get("side_effects")?,
            dispatch: ActionDispatch::from_db_str(&dispatch)?,
            dispatch_target: row.try_get("dispatch_target")?,
            control_points: row.try_get("control_points")?,
        })
    })
    .collect::<Result<Vec<_>, PgOntologyError>>()?;

    let analytics = sqlx::query(
        r#"
        SELECT key, title, formula, result_type
        FROM ont_analytics
        WHERE object_type_id = $1 AND org_id = $2
        "#,
    )
    .bind(id)
    .bind(org_uuid)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .map(|row| {
        Ok(AnalyticInput {
            key: row.try_get("key")?,
            title: row.try_get("title")?,
            formula: row.try_get("formula")?,
            result_type: row.try_get("result_type")?,
        })
    })
    .collect::<Result<Vec<_>, PgOntologyError>>()?;

    let appended = CreateObjectTypeDraft {
        properties: reconcile_child_inputs(
            "property",
            properties
                .into_iter()
                .map(|value| canonical_property_input(&value)),
            draft.properties.iter().map(canonical_property_input),
            |value| &value.key,
        )?,
        links: reconcile_child_inputs(
            "link",
            links.into_iter().map(|value| canonical_link_input(&value)),
            draft.links.iter().map(canonical_link_input),
            |value| &value.stable_key,
        )?,
        actions: reconcile_child_inputs(
            "action",
            actions
                .into_iter()
                .map(|value| canonical_action_input(&value)),
            draft.actions.iter().map(canonical_action_input),
            |value| &value.stable_key,
        )?,
        analytics: reconcile_child_inputs(
            "analytic",
            analytics
                .into_iter()
                .map(|value| canonical_analytic_input(&value)),
            draft.analytics.iter().map(canonical_analytic_input),
            |value| &value.key,
        )?,
        ..draft.clone()
    };
    insert_object_type_children_tx(tx, object_type_id, org_uuid, &appended).await
}

fn reconcile_child_inputs<T>(
    kind: &str,
    existing: impl IntoIterator<Item = T>,
    incoming: impl IntoIterator<Item = T>,
    key_of: impl Fn(&T) -> &str,
) -> Result<Vec<T>, PgOntologyError>
where
    T: Clone + PartialEq,
{
    let mut known = HashMap::<String, T>::new();
    for value in existing {
        known.insert(key_of(&value).to_owned(), value);
    }

    let mut appended = Vec::new();
    for value in incoming {
        let key = key_of(&value).to_owned();
        match known.get(&key) {
            Some(current) if current == &value => {}
            Some(_) => {
                return Err(KernelError::conflict(format!(
                    "{kind} child key {key:?} is already bound to a different definition"
                ))
                .into());
            }
            None => {
                known.insert(key, value.clone());
                appended.push(value);
            }
        }
    }
    Ok(appended)
}

fn canonical_property_input(value: &PropertyDefInput) -> PropertyDefInput {
    PropertyDefInput {
        key: value.key.trim().to_owned(),
        title: value.title.trim().to_owned(),
        field_type: value.field_type.trim().to_owned(),
        config: value.config.clone(),
        backing_column: value.backing_column.clone(),
        required: value.required,
        in_property_policy: value.in_property_policy,
    }
}

fn canonical_link_input(value: &LinkTypeInput) -> LinkTypeInput {
    LinkTypeInput {
        stable_key: value.stable_key.trim().to_owned(),
        title: value.title.trim().to_owned(),
        reverse_title: value
            .reverse_title
            .as_deref()
            .map(str::trim)
            .map(str::to_owned),
        to_object_type_id: value.to_object_type_id,
        cardinality: value.cardinality,
        traversable: value.traversable,
    }
}

fn canonical_action_input(value: &ActionTypeInput) -> ActionTypeInput {
    ActionTypeInput {
        stable_key: value.stable_key.trim().to_owned(),
        title: value.title.trim().to_owned(),
        params_schema: value.params_schema.clone(),
        edits: value.edits.clone(),
        submission_criteria: value.submission_criteria.clone(),
        side_effects: value.side_effects.clone(),
        dispatch: value.dispatch,
        dispatch_target: value.dispatch_target.clone(),
        control_points: value.control_points.clone(),
    }
}

fn canonical_analytic_input(value: &AnalyticInput) -> AnalyticInput {
    AnalyticInput {
        key: value.key.trim().to_owned(),
        title: value.title.trim().to_owned(),
        formula: value.formula.clone(),
        result_type: value.result_type.clone(),
    }
}

/// Insert child definitions for a new version or the reconciled additions to a
/// mutable draft. Payload-preserving canonicalization and identity reconciliation
/// make duplicate identities inside one request deterministic without changing JSON shape.
async fn insert_object_type_children_tx(
    tx: &mut Transaction<'_, Postgres>,
    object_type_id: ObjectTypeId,
    org_uuid: uuid::Uuid,
    draft: &CreateObjectTypeDraft,
) -> Result<(), PgOntologyError> {
    let properties = reconcile_child_inputs(
        "property",
        Vec::new(),
        draft.properties.iter().map(canonical_property_input),
        |value| &value.key,
    )?;
    let links = reconcile_child_inputs(
        "link",
        Vec::new(),
        draft.links.iter().map(canonical_link_input),
        |value| &value.stable_key,
    )?;
    let actions = reconcile_child_inputs(
        "action",
        Vec::new(),
        draft.actions.iter().map(canonical_action_input),
        |value| &value.stable_key,
    )?;
    let analytics = reconcile_child_inputs(
        "analytic",
        Vec::new(),
        draft.analytics.iter().map(canonical_analytic_input),
        |value| &value.key,
    )?;

    for property in &properties {
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
        .bind(&property.key)
        .bind(&property.title)
        .bind(&property.field_type)
        .bind(&property.config)
        .bind(property.backing_column.as_deref())
        .bind(property.required)
        .bind(property.in_property_policy)
        .execute(tx.as_mut())
        .await?;
    }

    for link in &links {
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
        .bind(&link.stable_key)
        .bind(&link.title)
        .bind(link.reverse_title.as_deref())
        .bind(link.to_object_type_id.map(|id| *id.as_uuid()))
        .bind(link.cardinality.as_db_str())
        .bind(link.traversable)
        .execute(tx.as_mut())
        .await?;
    }

    for action in &actions {
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
        .bind(&action.stable_key)
        .bind(&action.title)
        .bind(&action.params_schema)
        .bind(&action.edits)
        .bind(&action.submission_criteria)
        .bind(&action.side_effects)
        .bind(action.dispatch.as_db_str())
        .bind(action.dispatch_target.as_deref())
        .bind(&action.control_points)
        .execute(tx.as_mut())
        .await?;
    }

    for analytic in &analytics {
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
        .bind(&analytic.key)
        .bind(&analytic.title)
        .bind(&analytic.formula)
        .bind(&analytic.result_type)
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
        SELECT o.id, o.stable_key, o.title, o.backing_kind, o.schema_version,
               o.lifecycle_state, k.validator_id AS key_write_validator_id,
               k.revision AS key_write_revision
        FROM ont_object_types o
        JOIN ont_object_type_key_revisions k USING (org_id, stable_key)
        WHERE o.id = $1
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
        key_write_revision: row.try_get("key_write_revision")?,
        key_write_etag: object_type_key_etag(
            row.try_get("key_write_validator_id")?,
            row.try_get("key_write_revision")?,
        ),
        key_write_validator_id: row.try_get("key_write_validator_id")?,
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

/// Default a missing JSON-object field at deserialization. Explicit JSON `null`
/// remains `Value::Null` so validation can reject it instead of silently
/// changing caller intent.
fn empty_json_object() -> serde_json::Value {
    serde_json::json!({})
}

/// Array counterpart to [`empty_json_object`].
fn empty_json_array() -> serde_json::Value {
    serde_json::json!([])
}

fn validate_draft(draft: &CreateObjectTypeDraft) -> Result<(), PgOntologyError> {
    let stable_key = draft.stable_key.trim();
    if stable_key.is_empty() {
        return Err(KernelError::validation("object type stable_key is required").into());
    }
    if stable_key != draft.stable_key {
        return Err(KernelError::validation(
            "object type stable_key must not have surrounding whitespace",
        )
        .into());
    }
    if draft.title.trim().is_empty() {
        return Err(KernelError::validation("object type title is required").into());
    }
    for property in &draft.properties {
        if !property.config.is_object() {
            return Err(KernelError::validation(format!(
                "property {:?} config must be a JSON object",
                property.key.trim()
            ))
            .into());
        }
    }
    for action in &draft.actions {
        if !action.params_schema.is_object() {
            return Err(KernelError::validation(format!(
                "action {:?} params_schema must be a JSON object",
                action.stable_key.trim()
            ))
            .into());
        }
        for (field, value) in [
            ("edits", &action.edits),
            ("submission_criteria", &action.submission_criteria),
            ("side_effects", &action.side_effects),
            ("control_points", &action.control_points),
        ] {
            if !value.is_array() {
                return Err(KernelError::validation(format!(
                    "action {:?} {field} must be a JSON array",
                    action.stable_key.trim()
                ))
                .into());
            }
        }
    }
    for analytic in &draft.analytics {
        if !analytic.formula.is_object() {
            return Err(KernelError::validation(format!(
                "analytic {:?} formula must be a JSON object",
                analytic.key.trim()
            ))
            .into());
        }
        if !analytic.result_type.is_object() {
            return Err(KernelError::validation(format!(
                "analytic {:?} result_type must be a JSON object",
                analytic.key.trim()
            ))
            .into());
        }
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
