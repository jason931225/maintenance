//! Postgres persistence for the Cedar Policy Studio.
//!
//! Every mutation flows through `with_audit` (mutation + audit row in one tx) and
//! every read through `with_org_conn`, so `app.current_org` is armed before any
//! statement and RLS scopes it to the tenant. Draft writes respect the `0103`
//! CHECKs: a draft can never carry a `shadow`/`enforced` status or a
//! bundle/policy version — promotion is a separate, gated lane.
//!
//! `ponytail:` the store lives in the thin `authz-rest` crate (its only consumer)
//! rather than a separate 4-crate hexagon — one vertical slice, no speculative
//! ports. Split it out if a second consumer ever appears.

use mnt_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext, UserId};
use mnt_platform_authz::cedar_pbac::authoring::{
    self, AuthoredPolicy, DraftValidation, NoCodeBlocks, ReviewDecision, ReviewStatus, SimRequest,
    SimulationOutcome,
};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use mnt_platform_request_context::current_org;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Row};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum PgCedarError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl From<sqlx::Error> for PgCedarError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

#[derive(Debug, Clone)]
pub struct PgCedarPolicyStore {
    pool: PgPool,
}

// -- DTOs --------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct CatalogEntry {
    pub id: Uuid,
    pub stable_key: String,
    pub title: String,
    pub effect: String,
    pub status: String,
    pub source: String,
    pub validation_status: String,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: time::OffsetDateTime,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DraftRecord {
    pub id: Uuid,
    pub draft_key: String,
    pub title: String,
    pub normalized_row: serde_json::Value,
    pub generated_policy_text: String,
    pub validation_status: String,
    pub validation_errors: serde_json::Value,
    pub review_status: String,
    pub reviewer_id: Option<Uuid>,
    pub created_by: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: time::OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: time::OffsetDateTime,
}

pub struct CreateDraftCommand {
    pub actor: UserId,
    pub draft_key: String,
    pub title: String,
    pub author_note: Option<String>,
    pub blocks: NoCodeBlocks,
}

pub struct UpdateDraftCommand {
    pub actor: UserId,
    pub draft_id: Uuid,
    pub title: Option<String>,
    pub author_note: Option<String>,
    pub blocks: NoCodeBlocks,
}

pub struct ReviewDraftCommand {
    pub reviewer: UserId,
    pub draft_id: Uuid,
    pub decision: ReviewDecision,
    pub note: Option<String>,
}

fn digest(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn audit_event(
    action: &str,
    actor: UserId,
    target_id: impl ToString,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action)?,
        "cedar_policy_draft",
        target_id.to_string(),
        TraceContext::generate(),
        time::OffsetDateTime::now_utc(),
    ))
}

impl PgCedarPolicyStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    // -- §5a catalog -------------------------------------------------------

    /// List catalog entries, optionally filtered by `status`. Read-only; the
    /// runtime role has SELECT on the catalog but never INSERT/UPDATE/DELETE.
    pub async fn list_catalog(
        &self,
        status: Option<String>,
    ) -> Result<Vec<CatalogEntry>, PgCedarError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgCedarError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    r#"
                    SELECT id, stable_key, title, effect, status, source,
                           validation_status, updated_at
                    FROM cedar_policy_catalog_entries
                    WHERE ($1::text IS NULL OR status = $1)
                    ORDER BY updated_at DESC
                    "#,
                )
                .bind(status)
                .fetch_all(tx.as_mut())
                .await?;
                Ok(rows.iter().map(catalog_from_row).collect())
            })
        })
        .await
    }

    // -- §5a drafts --------------------------------------------------------

    /// Create a no-code draft. `review_status` is forced to `draft` and the
    /// normalized row carries no status/version — the `0103` CHECKs make a
    /// shadow/enforced draft impossible; this is the app-side belt.
    pub async fn create_draft(
        &self,
        command: CreateDraftCommand,
    ) -> Result<DraftRecord, PgCedarError> {
        let org = current_org().map_err(KernelError::from)?;
        let validation = authoring::validate_blocks(org, &command.blocks);
        let draft_id = Uuid::new_v4();
        let event = audit_event("cedar.draft.create", command.actor, draft_id)?
            .with_org(org)
            .with_snapshots(None, Some(validation.normalized_row.clone()));
        let actor = *command.actor.as_uuid();
        let org_uuid = *org.as_uuid();

        with_audit::<_, DraftRecord, PgCedarError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO cedar_policy_drafts
                        (id, org_id, draft_key, title, author_note, blocks, normalized_row,
                         generated_policy_text, generated_policy_digest,
                         validation_status, validation_errors, review_status,
                         created_by, updated_by)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft', $12, $12)
                    "#,
                )
                .bind(draft_id)
                .bind(org_uuid)
                .bind(command.draft_key.trim())
                .bind(command.title.trim())
                .bind(command.author_note.as_deref())
                .bind(serde_json::to_value(&command.blocks).map_err(DbError::Serialize)?)
                .bind(&validation.normalized_row)
                .bind(&validation.generated_policy_text)
                .bind(digest(&validation.generated_policy_text))
                .bind(validation_status_str(&validation))
                .bind(errors_json(&validation))
                .bind(actor)
                .execute(tx.as_mut())
                .await?;
                draft_row_conn(tx.as_mut(), draft_id).await
            })
        })
        .await
    }

    /// Edit a draft (per-user invisible draft, benchmark §3e). Re-validates the
    /// new blocks and RESETS `review_status` to `draft` — an edit invalidates any
    /// prior submission so a changed policy is re-reviewed from scratch.
    pub async fn update_draft(
        &self,
        command: UpdateDraftCommand,
    ) -> Result<DraftRecord, PgCedarError> {
        let org = current_org().map_err(KernelError::from)?;
        let validation = authoring::validate_blocks(org, &command.blocks);
        let event = audit_event("cedar.draft.update", command.actor, command.draft_id)?
            .with_org(org)
            .with_snapshots(None, Some(validation.normalized_row.clone()));
        let actor = *command.actor.as_uuid();
        let draft_id = command.draft_id;

        with_audit::<_, DraftRecord, PgCedarError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let updated = sqlx::query(
                    r#"
                    UPDATE cedar_policy_drafts
                    SET title                   = COALESCE($2, title),
                        author_note             = $3,
                        blocks                  = $4,
                        normalized_row          = $5,
                        generated_policy_text   = $6,
                        generated_policy_digest = $7,
                        validation_status       = $8,
                        validation_errors       = $9,
                        review_status           = 'draft',
                        reviewer_id             = NULL,
                        review_note             = NULL,
                        updated_by              = $10,
                        updated_at              = now()
                    WHERE id = $1
                    "#,
                )
                .bind(draft_id)
                .bind(command.title.as_deref().map(str::trim))
                .bind(command.author_note.as_deref())
                .bind(serde_json::to_value(&command.blocks).map_err(DbError::Serialize)?)
                .bind(&validation.normalized_row)
                .bind(&validation.generated_policy_text)
                .bind(digest(&validation.generated_policy_text))
                .bind(validation_status_str(&validation))
                .bind(errors_json(&validation))
                .bind(actor)
                .execute(tx.as_mut())
                .await?;
                if updated.rows_affected() == 0 {
                    return Err(KernelError::not_found("draft was not found").into());
                }
                draft_row_conn(tx.as_mut(), draft_id).await
            })
        })
        .await
    }

    pub async fn get_draft(&self, draft_id: Uuid) -> Result<DraftRecord, PgCedarError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgCedarError>(&self.pool, org, move |tx| {
            Box::pin(async move { draft_row_conn(tx.as_mut(), draft_id).await })
        })
        .await
    }

    pub async fn list_drafts(&self) -> Result<Vec<DraftRecord>, PgCedarError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgCedarError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(DRAFT_SELECT_ALL).fetch_all(tx.as_mut()).await?;
                rows.iter().map(draft_from_row).collect()
            })
        })
        .await
    }

    /// Re-run strict validation on the stored blocks and persist the result.
    /// Returns errors without activating anything.
    pub async fn validate_draft(
        &self,
        actor: UserId,
        draft_id: Uuid,
    ) -> Result<DraftRecord, PgCedarError> {
        let org = current_org().map_err(KernelError::from)?;
        let event = audit_event("cedar.draft.validate", actor, draft_id)?.with_org(org);
        with_audit::<_, DraftRecord, PgCedarError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let blocks: NoCodeBlocks =
                    serde_json::from_value(blocks_json(tx.as_mut(), draft_id).await?)
                        .map_err(DbError::Serialize)?;
                let validation = authoring::validate_blocks(org, &blocks);
                sqlx::query(
                    r#"
                    UPDATE cedar_policy_drafts
                    SET generated_policy_text   = $2,
                        generated_policy_digest = $3,
                        validation_status       = $4,
                        validation_errors       = $5,
                        updated_at              = now()
                    WHERE id = $1
                    "#,
                )
                .bind(draft_id)
                .bind(&validation.generated_policy_text)
                .bind(digest(&validation.generated_policy_text))
                .bind(validation_status_str(&validation))
                .bind(errors_json(&validation))
                .execute(tx.as_mut())
                .await?;
                draft_row_conn(tx.as_mut(), draft_id).await
            })
        })
        .await
    }

    /// Submit a draft for review. Guarded by [`authoring::submit_draft`]
    /// (validation must be `valid`, current status must allow submit); the DB
    /// CHECK `review_status <> 'review_pending' OR validation = 'valid'` is the
    /// backstop.
    pub async fn submit_draft(
        &self,
        actor: UserId,
        draft_id: Uuid,
    ) -> Result<DraftRecord, PgCedarError> {
        let org = current_org().map_err(KernelError::from)?;
        let event = audit_event("cedar.draft.submit", actor, draft_id)?.with_org(org);
        with_audit::<_, DraftRecord, PgCedarError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let current = draft_row_conn(tx.as_mut(), draft_id).await?;
                let status = ReviewStatus::from_db_str(&current.review_status)?;
                let valid = current.validation_status == "valid";
                let next = authoring::submit_draft(status, valid)?;
                sqlx::query(
                    "UPDATE cedar_policy_drafts SET review_status = $2, updated_at = now() WHERE id = $1",
                )
                .bind(draft_id)
                .bind(next.as_db_str())
                .execute(tx.as_mut())
                .await?;
                draft_row_conn(tx.as_mut(), draft_id).await
            })
        })
        .await
    }

    /// Four-eyes review. Guarded by [`authoring::review_draft`] — the reviewer
    /// MUST differ from the draft author, and the draft must be `review_pending`.
    /// Approval yields `approved_for_promotion`, never a live/shadow row.
    pub async fn review_draft(
        &self,
        command: ReviewDraftCommand,
    ) -> Result<DraftRecord, PgCedarError> {
        let org = current_org().map_err(KernelError::from)?;
        let event =
            audit_event("cedar.draft.review", command.reviewer, command.draft_id)?.with_org(org);
        let reviewer = command.reviewer;
        let draft_id = command.draft_id;
        let decision = command.decision;
        let note = command.note;

        with_audit::<_, DraftRecord, PgCedarError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let current = draft_row_conn(tx.as_mut(), draft_id).await?;
                let status = ReviewStatus::from_db_str(&current.review_status)?;
                let author = UserId::from_uuid(current.created_by);
                let next = authoring::review_draft(status, decision, author, reviewer)?;
                sqlx::query(
                    r#"
                    UPDATE cedar_policy_drafts
                    SET review_status = $2, reviewer_id = $3, review_note = $4, updated_at = now()
                    WHERE id = $1
                    "#,
                )
                .bind(draft_id)
                .bind(next.as_db_str())
                .bind(*reviewer.as_uuid())
                .bind(note.as_deref())
                .execute(tx.as_mut())
                .await?;
                draft_row_conn(tx.as_mut(), draft_id).await
            })
        })
        .await
    }

    // -- §5c live authorize (object / property policy) ---------------------

    /// Live object-policy decision: load the catalog policies attached to
    /// `object_type_id` and evaluate row visibility for `request` — the SAME
    /// [`authoring::simulate`] evaluator the `/policy/simulate` what-if uses.
    pub async fn authorize_object_row(
        &self,
        object_type_id: Uuid,
        request: &SimRequest,
    ) -> Result<SimulationOutcome, PgCedarError> {
        let policies = self
            .load_attached_policies(OBJECT_POLICY_SELECT, object_type_id)
            .await?;
        Ok(authoring::simulate(&policies, request))
    }

    /// Live property-policy decision for `property_def_id`.
    pub async fn authorize_property_field(
        &self,
        property_def_id: Uuid,
        request: &SimRequest,
    ) -> Result<SimulationOutcome, PgCedarError> {
        let policies = self
            .load_attached_policies(PROPERTY_POLICY_SELECT, property_def_id)
            .await?;
        Ok(authoring::simulate(&policies, request))
    }

    /// Load the enforced catalog policy set (those carrying generated Cedar text)
    /// for the org — the live set behind `/policy/authorize`.
    pub async fn load_enforced_policies(&self) -> Result<Vec<AuthoredPolicy>, PgCedarError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgCedarError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    r#"
                    SELECT id, generated_policy_text
                    FROM cedar_policy_catalog_entries
                    WHERE status = 'enforced' AND generated_policy_text IS NOT NULL
                    "#,
                )
                .fetch_all(tx.as_mut())
                .await?;
                Ok(rows.iter().map(authored_from_row).collect())
            })
        })
        .await
    }

    async fn load_attached_policies(
        &self,
        sql: &'static str,
        fk_value: Uuid,
    ) -> Result<Vec<AuthoredPolicy>, PgCedarError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgCedarError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(sql)
                    .bind(fk_value)
                    .fetch_all(tx.as_mut())
                    .await?;
                Ok(rows.iter().map(authored_from_row).collect())
            })
        })
        .await
    }

    /// Append the point-decisions an authorize call just computed to the tenant's
    /// append-only `cedar_decision_log` (the Integrity feed source). One tx, all
    /// rows or none. The log IS the audit record here (append-only + FORCE-RLS),
    /// so no second `audit_events` row is emitted per decision.
    // ponytail: one INSERT per decision under one conn; batch into a single
    // multi-row INSERT if the bulk feed ever gets hot.
    pub async fn record_decisions(
        &self,
        actor: Uuid,
        entries: Vec<DecisionLogEntry>,
    ) -> Result<(), PgCedarError> {
        if entries.is_empty() {
            return Ok(());
        }
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_org_conn::<_, (), PgCedarError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                for entry in &entries {
                    let determining = serde_json::Value::Array(
                        entry
                            .determining_policies
                            .iter()
                            .map(|p| serde_json::Value::String(p.clone()))
                            .collect(),
                    );
                    sqlx::query(
                        r#"
                        INSERT INTO cedar_decision_log (
                            org_id, actor, subject_ref, action, resource_type,
                            resource_id, effect, determining_policies, reason
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(actor)
                    .bind(&entry.subject_ref)
                    .bind(&entry.action)
                    .bind(&entry.resource_type)
                    .bind(entry.resource_id.as_deref())
                    .bind(&entry.effect)
                    .bind(determining)
                    .bind(&entry.reason)
                    .execute(tx.as_mut())
                    .await?;
                }
                Ok(())
            })
        })
        .await
    }

    /// Recent decisions for the tenant, newest first, optionally since a cursor
    /// instant. RLS-scoped; `limit` is capped by the caller.
    pub async fn recent_decisions(
        &self,
        since: Option<OffsetDateTime>,
        limit: i64,
    ) -> Result<Vec<DecisionLogRow>, PgCedarError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, Vec<DecisionLogRow>, PgCedarError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    r#"
                    SELECT id, decided_at, subject_ref, action, resource_type,
                           resource_id, effect, determining_policies, reason
                    FROM cedar_decision_log
                    WHERE ($1::timestamptz IS NULL OR decided_at > $1)
                    ORDER BY decided_at DESC
                    LIMIT $2
                    "#,
                )
                .bind(since)
                .bind(limit)
                .fetch_all(tx.as_mut())
                .await?;
                rows.iter().map(decision_row_from_row).collect()
            })
        })
        .await
    }
}

/// One decision to append to `cedar_decision_log`.
#[derive(Debug, Clone)]
pub struct DecisionLogEntry {
    pub subject_ref: String,
    pub action: String,
    pub resource_type: String,
    pub resource_id: Option<String>,
    /// `"allow"` | `"deny"` (matches the table CHECK).
    pub effect: String,
    pub determining_policies: Vec<String>,
    pub reason: String,
}

/// A recorded decision, as read back for the Integrity feed.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DecisionLogRow {
    pub id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub decided_at: OffsetDateTime,
    pub subject_ref: String,
    pub action: String,
    pub resource_type: String,
    pub resource_id: Option<String>,
    pub effect: String,
    pub determining_policies: Vec<String>,
    pub reason: String,
}

fn decision_row_from_row(row: &sqlx::postgres::PgRow) -> Result<DecisionLogRow, PgCedarError> {
    let determining: serde_json::Value = row.try_get("determining_policies")?;
    let determining_policies = determining
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Ok(DecisionLogRow {
        id: row.try_get("id")?,
        decided_at: row.try_get("decided_at")?,
        subject_ref: row.try_get("subject_ref")?,
        action: row.try_get("action")?,
        resource_type: row.try_get("resource_type")?,
        resource_id: row.try_get("resource_id")?,
        effect: row.try_get("effect")?,
        determining_policies,
        reason: row.try_get("reason")?,
    })
}

const OBJECT_POLICY_SELECT: &str = r#"
    SELECT c.id AS id, c.generated_policy_text AS generated_policy_text
    FROM ont_object_policies a
    JOIN cedar_policy_catalog_entries c
      ON c.id = a.cedar_policy_id AND c.org_id = a.org_id
    WHERE a.object_type_id = $1 AND c.generated_policy_text IS NOT NULL
"#;

const PROPERTY_POLICY_SELECT: &str = r#"
    SELECT c.id AS id, c.generated_policy_text AS generated_policy_text
    FROM ont_property_policies a
    JOIN cedar_policy_catalog_entries c
      ON c.id = a.cedar_policy_id AND c.org_id = a.org_id
    WHERE a.property_def_id = $1 AND c.generated_policy_text IS NOT NULL
"#;

const DRAFT_SELECT_BY_ID: &str = r#"
    SELECT id, draft_key, title, normalized_row, generated_policy_text,
           validation_status, validation_errors, review_status, reviewer_id,
           created_by, created_at, updated_at
    FROM cedar_policy_drafts WHERE id = $1
"#;

const DRAFT_SELECT_ALL: &str = r#"
    SELECT id, draft_key, title, normalized_row, generated_policy_text,
           validation_status, validation_errors, review_status, reviewer_id,
           created_by, created_at, updated_at
    FROM cedar_policy_drafts ORDER BY updated_at DESC
"#;

async fn draft_row_conn(conn: &mut PgConnection, id: Uuid) -> Result<DraftRecord, PgCedarError> {
    let row = sqlx::query(DRAFT_SELECT_BY_ID)
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| KernelError::not_found("draft was not found"))?;
    draft_from_row(&row)
}

async fn blocks_json(conn: &mut PgConnection, id: Uuid) -> Result<serde_json::Value, PgCedarError> {
    let row = sqlx::query("SELECT blocks FROM cedar_policy_drafts WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| KernelError::not_found("draft was not found"))?;
    Ok(row.try_get("blocks")?)
}

fn draft_from_row(row: &sqlx::postgres::PgRow) -> Result<DraftRecord, PgCedarError> {
    Ok(DraftRecord {
        id: row.try_get("id")?,
        draft_key: row.try_get("draft_key")?,
        title: row.try_get("title")?,
        normalized_row: row.try_get("normalized_row")?,
        generated_policy_text: row.try_get("generated_policy_text")?,
        validation_status: row.try_get("validation_status")?,
        validation_errors: row.try_get("validation_errors")?,
        review_status: row.try_get("review_status")?,
        reviewer_id: row.try_get("reviewer_id")?,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn catalog_from_row(row: &sqlx::postgres::PgRow) -> CatalogEntry {
    CatalogEntry {
        id: row.get("id"),
        stable_key: row.get("stable_key"),
        title: row.get("title"),
        effect: row.get("effect"),
        status: row.get("status"),
        source: row.get("source"),
        validation_status: row.get("validation_status"),
        updated_at: row.get("updated_at"),
    }
}

fn authored_from_row(row: &sqlx::postgres::PgRow) -> AuthoredPolicy {
    let id: Uuid = row.get("id");
    let text: String = row.get("generated_policy_text");
    AuthoredPolicy::new(id.to_string(), text)
}

fn validation_status_str(validation: &DraftValidation) -> &'static str {
    if validation.valid { "valid" } else { "invalid" }
}

fn errors_json(validation: &DraftValidation) -> serde_json::Value {
    serde_json::Value::Array(
        validation
            .errors
            .iter()
            .map(|e| serde_json::Value::String(e.clone()))
            .collect(),
    )
}

#[cfg(test)]
mod serde_tests {
    use super::*;

    // Regression guard (R9 policy HARD FAIL): `time::OffsetDateTime` with serde's
    // default impl serializes as a numeric `[year, ordinal, hour, …]` array, which
    // the web client's `str(row, "updated_at")` parser rejects → the whole 권한·정책
    // surface collapsed to its error banner. Every timestamp the policy REST reads
    // back MUST serialize as an RFC3339 string (the openapi/client contract).
    #[test]
    fn policy_timestamps_serialize_as_rfc3339_strings() {
        let now = OffsetDateTime::now_utc();

        let catalog = CatalogEntry {
            id: Uuid::nil(),
            stable_key: "policy.wo_view".into(),
            title: "Work order view".into(),
            effect: "permit".into(),
            status: "enforced".into(),
            source: "seed".into(),
            validation_status: "valid".into(),
            updated_at: now,
        };
        let value = serde_json::to_value(&catalog).expect("catalog serializes");
        assert!(
            value["updated_at"].is_string(),
            "catalog updated_at must be a string, got {}",
            value["updated_at"]
        );

        let draft = DraftRecord {
            id: Uuid::nil(),
            draft_key: "policy.x".into(),
            title: "Draft".into(),
            normalized_row: serde_json::json!({}),
            generated_policy_text: "permit(principal, action, resource);".into(),
            validation_status: "valid".into(),
            validation_errors: serde_json::json!([]),
            review_status: "draft".into(),
            reviewer_id: None,
            created_by: Uuid::nil(),
            created_at: now,
            updated_at: now,
        };
        let value = serde_json::to_value(&draft).expect("draft serializes");
        assert!(
            value["created_at"].is_string(),
            "draft created_at must be a string"
        );
        assert!(
            value["updated_at"].is_string(),
            "draft updated_at must be a string"
        );
    }
}
