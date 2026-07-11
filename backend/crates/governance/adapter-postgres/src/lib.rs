//! Postgres governance adapter.
//!
//! Every mutation flows through `with_audit` (mutation + audit row in one tx),
//! every read through `with_org_conn`, so `app.current_org` is armed before any
//! statement and RLS scopes it to the tenant. All three tables run FORCE RLS;
//! the two record tables are append-only (REVOKE UPDATE/DELETE).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_governance_application::{
    ApprovalDecision, ApprovalRequestSummary, ApprovalSummary, ConfigureTransitionCommand,
    CreateApprovalCommand, DecideApprovalCommand, LifecycleTransitionConfig, OpenOverrideCommand,
    OverrideSummary, governance_audit_event,
};
use mnt_governance_domain::{
    AuthorityEffect, LifecycleState, TransitionRequirements, validate_lifecycle_transition,
};
use mnt_kernel_core::{KernelError, UserId};
use mnt_platform_authz::cedar_pbac::DecisionEffect;
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use mnt_platform_request_context::current_org;
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

/// Map the Cedar evaluator's decision effect onto the domain's Authority-gate
/// input. This is the seam where the guardrail Authority gate "calls the Cedar
/// evaluator": the ontology action lane runs `engine::evaluate(...)`, converts
/// its `DecisionEffect` here, and feeds it to `evaluate_gate_chain`.
#[must_use]
pub fn authority_effect_from_cedar(effect: DecisionEffect) -> AuthorityEffect {
    match effect {
        DecisionEffect::Allow => AuthorityEffect::Allow,
        DecisionEffect::Deny => AuthorityEffect::Deny,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PgGovernanceError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl From<sqlx::Error> for PgGovernanceError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

#[derive(Debug, Clone)]
pub struct PgGovernanceStore {
    pool: PgPool,
}

impl PgGovernanceStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    // -- §3b post-draft override --------------------------------------------

    pub async fn open_override(
        &self,
        command: OpenOverrideCommand,
    ) -> Result<OverrideSummary, PgGovernanceError> {
        if command.reason.trim().is_empty() {
            return Err(KernelError::validation("override reason is required").into());
        }
        if !command.before_snapshot.is_object() {
            return Err(
                KernelError::validation("override before-snapshot must be a JSON object").into(),
            );
        }
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let override_id = Uuid::new_v4();
        let event = governance_audit_event(
            "governance.override.open",
            command.actor,
            "gov_override",
            override_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org)
        .with_snapshots(Some(command.before_snapshot.clone()), None);

        with_audit::<_, OverrideSummary, PgGovernanceError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO gov_overrides
                        (id, org_id, target_type, target_id, actor, reason, before_snapshot, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    "#,
                )
                .bind(override_id)
                .bind(org_uuid)
                .bind(command.target_type.trim())
                .bind(command.target_id)
                .bind(*command.actor.as_uuid())
                .bind(command.reason.trim())
                .bind(&command.before_snapshot)
                .bind(command.occurred_at)
                .execute(tx.as_mut())
                .await?;
                override_row_conn(tx.as_mut(), override_id).await
            })
        })
        .await
    }

    // -- approvals-create (open a pending request) --------------------------

    /// Open a pending four-eyes request (arch §19). Records who is asking and a
    /// payload summary; a *distinct* approver decides it later via
    /// [`Self::decide_approval`] keyed by the same `request_ref`. One open request
    /// per `(org, request_ref)` — a second open for the same ref conflicts.
    pub async fn create_approval(
        &self,
        command: CreateApprovalCommand,
    ) -> Result<ApprovalRequestSummary, PgGovernanceError> {
        if command.kind.trim().is_empty() {
            return Err(KernelError::validation("approval kind is required").into());
        }
        if !command.payload_summary.is_object() {
            return Err(
                KernelError::validation("approval payload_summary must be a JSON object").into(),
            );
        }
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let request_id = Uuid::new_v4();
        let event = governance_audit_event(
            "governance.approval.request",
            command.requester,
            "gov_approval_request",
            request_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "request_ref": command.request_ref,
                "kind": command.kind,
            })),
        );

        with_audit::<_, ApprovalRequestSummary, PgGovernanceError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO gov_approval_requests
                        (id, org_id, request_ref, kind, requested_by, target_ref, payload_summary, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    "#,
                )
                .bind(request_id)
                .bind(org_uuid)
                .bind(command.request_ref)
                .bind(command.kind.trim())
                .bind(*command.requester.as_uuid())
                .bind(command.target_ref)
                .bind(&command.payload_summary)
                .bind(command.occurred_at)
                .execute(tx.as_mut())
                .await?;
                approval_request_row_conn(tx.as_mut(), request_id).await
            })
        })
        .await
    }

    // -- four-eyes decision --------------------------------------------------

    pub async fn decide_approval(
        &self,
        command: DecideApprovalCommand,
    ) -> Result<ApprovalSummary, PgGovernanceError> {
        if !matches!(
            command.decision,
            ApprovalDecision::Approved | ApprovalDecision::Rejected
        ) {
            return Err(KernelError::validation(
                "a four-eyes decision must be 'approved' or 'rejected'",
            )
            .into());
        }
        if command.kind.trim().is_empty() {
            return Err(KernelError::validation("approval kind is required").into());
        }
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let approval_id = Uuid::new_v4();
        let event = governance_audit_event(
            "governance.approval.decide",
            command.approver,
            "gov_approval",
            approval_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "request_ref": command.request_ref,
                "kind": command.kind,
                "decision": command.decision.as_db_str(),
            })),
        );

        with_audit::<_, ApprovalSummary, PgGovernanceError>(&self.pool, event, |tx| {
            Box::pin(async move {
                // If a pending request exists for this ref, its recorded requester
                // AND target are authoritative (never the client-supplied values),
                // so an approver can neither spoof the requester to dodge the
                // self-approval bar nor redirect the binding target. Read it in THIS
                // tx (RLS-armed, TOCTOU-safe).
                let pending =
                    pending_request_binding_conn(tx.as_mut(), command.request_ref).await?;
                let requested_by = pending
                    .as_ref()
                    .map_or(command.requested_by, |p| p.requested_by);
                let target_ref = pending
                    .as_ref()
                    .and_then(|p| p.target_ref)
                    .or(command.target_ref);
                // Self-approval is blocked here (fast, clear error) and at the DB
                // CHECK (`approver_id <> requested_by`). Defense in depth.
                if command.approver == requested_by {
                    return Err(KernelError::forbidden(
                        "self-approval is not allowed: approver must differ from requester",
                    )
                    .into());
                }
                sqlx::query(
                    r#"
                    INSERT INTO gov_approvals
                        (id, org_id, request_ref, kind, requested_by, approver_id, target_ref, decision, decided_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    "#,
                )
                .bind(approval_id)
                .bind(org_uuid)
                .bind(command.request_ref)
                .bind(command.kind.trim())
                .bind(*requested_by.as_uuid())
                .bind(*command.approver.as_uuid())
                .bind(target_ref)
                .bind(command.decision.as_db_str())
                .bind(command.occurred_at)
                .execute(tx.as_mut())
                .await?;
                approval_row_conn(tx.as_mut(), approval_id).await
            })
        })
        .await
    }

    // -- §15 lifecycle FSM config -------------------------------------------

    pub async fn configure_transition(
        &self,
        command: ConfigureTransitionCommand,
    ) -> Result<LifecycleTransitionConfig, PgGovernanceError> {
        // The configured edge can only be a subset of the base FSM.
        validate_lifecycle_transition(command.from_state, command.to_state)?;
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = governance_audit_event(
            "governance.lifecycle.configure",
            command.actor,
            "gov_lifecycle_transition",
            format!(
                "{}:{}->{}",
                command.object_type_id,
                command.from_state.as_db_str(),
                command.to_state.as_db_str()
            ),
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);
        let requirements = command.requirements;

        with_audit::<_, LifecycleTransitionConfig, PgGovernanceError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO gov_lifecycle_transitions
                        (org_id, object_type_id, from_state, to_state,
                         requires_reason, requires_four_eyes, requires_checklist, created_by)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (org_id, object_type_id, from_state, to_state) DO UPDATE
                    SET requires_reason    = EXCLUDED.requires_reason,
                        requires_four_eyes = EXCLUDED.requires_four_eyes,
                        requires_checklist = EXCLUDED.requires_checklist,
                        updated_at         = now()
                    "#,
                )
                .bind(org_uuid)
                .bind(command.object_type_id)
                .bind(command.from_state.as_db_str())
                .bind(command.to_state.as_db_str())
                .bind(requirements.requires_reason)
                .bind(requirements.requires_four_eyes)
                .bind(requirements.requires_checklist)
                .bind(*command.actor.as_uuid())
                .execute(tx.as_mut())
                .await?;
                Ok(LifecycleTransitionConfig {
                    object_type_id: command.object_type_id,
                    from_state: command.from_state,
                    to_state: command.to_state,
                    requirements,
                })
            })
        })
        .await
    }

    /// Read the configured requirements for one edge. `None` means the edge is
    /// not configured for this object type — callers must treat an unconfigured
    /// edge as **not permitted** (fail-closed), even if the base FSM allows it.
    pub async fn transition_requirements(
        &self,
        object_type_id: Uuid,
        from_state: LifecycleState,
        to_state: LifecycleState,
    ) -> Result<Option<TransitionRequirements>, PgGovernanceError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgGovernanceError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                transition_requirements_conn(tx.as_mut(), object_type_id, from_state, to_state)
                    .await
            })
        })
        .await
    }

    /// Four-eyes evidence for a request, read under the armed org — a NON-consuming
    /// peek for preview/preflight only (the committing gate uses
    /// [`four_eyes_consume_conn`]). Binds to the action: the approval must match the
    /// server-derived `expected_kind` and `expected_target` and be unconsumed.
    ///
    /// `Some(true)`  — a matching `approved`, unconsumed decision by a distinct
    ///                 principal exists.
    /// `Some(false)` — no matching unconsumed approval (wrong kind/target, not yet
    ///                 approved, or already consumed) — the gate fails closed.
    pub async fn four_eyes_approved(
        &self,
        request_ref: Uuid,
        expected_kind: &str,
        expected_target: Option<Uuid>,
    ) -> Result<Option<bool>, PgGovernanceError> {
        let org = current_org().map_err(KernelError::from)?;
        let expected_kind = expected_kind.to_owned();
        with_org_conn::<_, _, PgGovernanceError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                four_eyes_check_conn(tx.as_mut(), request_ref, &expected_kind, expected_target)
                    .await
            })
        })
        .await
    }

    /// Bind-match AND consume a four-eyes approval in one committed step — for
    /// gated actions whose mutation runs in a tx this crate does not own (docs hold
    /// release, projected dispatch). Returns `Some(true)` iff a matching approval
    /// was newly consumed; `Some(false)` if none matched or it was already consumed
    /// (replay). Callers with their own write tx MUST use [`four_eyes_consume_conn`]
    /// so the consumption is atomic with the mutation.
    pub async fn four_eyes_consume(
        &self,
        request_ref: Uuid,
        expected_kind: &str,
        expected_target: Option<Uuid>,
        consumed_by: UserId,
    ) -> Result<Option<bool>, PgGovernanceError> {
        let org = current_org().map_err(KernelError::from)?;
        let expected_kind = expected_kind.to_owned();
        with_org_conn::<_, _, PgGovernanceError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                four_eyes_consume_conn(
                    tx.as_mut(),
                    request_ref,
                    &expected_kind,
                    expected_target,
                    consumed_by,
                )
                .await
            })
        })
        .await
    }
}

// The `&mut PgConnection` readers below are shared by the `with_audit` /
// `with_org_conn` closures (pass `tx.as_mut()`). The gated-action lanes call
// `four_eyes_consume_conn` inside their OWN writeback transaction to bind-match AND
// consume the four-eyes approval in the same tx as the mutation (TOCTOU-safe,
// single-use); `four_eyes_check_conn` is the non-consuming peek for previews.

async fn override_row_conn(
    conn: &mut PgConnection,
    id: Uuid,
) -> Result<OverrideSummary, PgGovernanceError> {
    let row = sqlx::query(
        r#"
        SELECT id, target_type, target_id, actor, reason, before_snapshot, created_at
        FROM gov_overrides WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_one(conn)
    .await?;
    Ok(OverrideSummary {
        id: row.try_get("id")?,
        target_type: row.try_get("target_type")?,
        target_id: row.try_get("target_id")?,
        actor: UserId::from_uuid(row.try_get("actor")?),
        reason: row.try_get("reason")?,
        before_snapshot: row.try_get("before_snapshot")?,
        created_at: row.try_get("created_at")?,
    })
}

async fn approval_request_row_conn(
    conn: &mut PgConnection,
    id: Uuid,
) -> Result<ApprovalRequestSummary, PgGovernanceError> {
    let row = sqlx::query(
        r#"
        SELECT id, request_ref, kind, requested_by, payload_summary, created_at
        FROM gov_approval_requests WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_one(conn)
    .await?;
    Ok(ApprovalRequestSummary {
        id: row.try_get("id")?,
        request_ref: row.try_get("request_ref")?,
        kind: row.try_get("kind")?,
        requested_by: UserId::from_uuid(row.try_get("requested_by")?),
        payload_summary: row.try_get("payload_summary")?,
        created_at: row.try_get("created_at")?,
    })
}

/// The authoritative (requester, target) binding of a pending approval request, if
/// one is open for `request_ref`. `None` = no pending request (decide falls back to
/// the client-supplied values). RLS-scoped by the caller's armed org.
struct PendingRequestBinding {
    requested_by: UserId,
    target_ref: Option<Uuid>,
}

async fn pending_request_binding_conn(
    conn: &mut PgConnection,
    request_ref: Uuid,
) -> Result<Option<PendingRequestBinding>, PgGovernanceError> {
    let row = sqlx::query(
        "SELECT requested_by, target_ref FROM gov_approval_requests WHERE request_ref = $1",
    )
    .bind(request_ref)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|row| PendingRequestBinding {
        requested_by: UserId::from_uuid(row.get("requested_by")),
        target_ref: row.get("target_ref"),
    }))
}

async fn approval_row_conn(
    conn: &mut PgConnection,
    id: Uuid,
) -> Result<ApprovalSummary, PgGovernanceError> {
    let row = sqlx::query(
        r#"
        SELECT id, request_ref, kind, requested_by, approver_id, decision, decided_at
        FROM gov_approvals WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_one(conn)
    .await?;
    let decision: String = row.try_get("decision")?;
    Ok(ApprovalSummary {
        id: row.try_get("id")?,
        request_ref: row.try_get("request_ref")?,
        kind: row.try_get("kind")?,
        requested_by: UserId::from_uuid(row.try_get("requested_by")?),
        approver_id: UserId::from_uuid(row.try_get("approver_id")?),
        decision: ApprovalDecision::from_db_str(&decision)?,
        decided_at: row.try_get("decided_at")?,
    })
}

async fn transition_requirements_conn(
    conn: &mut PgConnection,
    object_type_id: Uuid,
    from_state: LifecycleState,
    to_state: LifecycleState,
) -> Result<Option<TransitionRequirements>, PgGovernanceError> {
    let row = sqlx::query(
        r#"
        SELECT requires_reason, requires_four_eyes, requires_checklist
        FROM gov_lifecycle_transitions
        WHERE object_type_id = $1 AND from_state = $2 AND to_state = $3
        "#,
    )
    .bind(object_type_id)
    .bind(from_state.as_db_str())
    .bind(to_state.as_db_str())
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|row| TransitionRequirements {
        requires_reason: row.get("requires_reason"),
        requires_four_eyes: row.get("requires_four_eyes"),
        requires_checklist: row.get("requires_checklist"),
    }))
}

// The bound-approval predicate below is shared, word-for-word, by the peek and the
// consume: an `approved` decision for THIS `request_ref` whose recorded (kind,
// target) match the action's server-derived `expected_kind` / `expected_target`,
// and which has not already been consumed. `target_ref IS NOT DISTINCT FROM $3`
// matches a NULL expected target against a NULL bound target and nothing else — a
// legacy/unbound row never satisfies a target-bound gate. RLS scopes every row to
// the caller's org. It is inlined as a literal in each query (not a `const` +
// `format!`) because sqlx only accepts `&'static str` SQL.

/// Non-consuming peek: does a matching, unconsumed, approved decision exist? For
/// preview/preflight only. `Some(true)` = the gate would pass now; `Some(false)` =
/// it would fail closed (wrong kind/target, unapproved, or already consumed).
pub async fn four_eyes_check_conn(
    conn: &mut PgConnection,
    request_ref: Uuid,
    expected_kind: &str,
    expected_target: Option<Uuid>,
) -> Result<Option<bool>, PgGovernanceError> {
    let exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM gov_approvals a
            WHERE a.request_ref = $1
              AND a.kind = $2
              AND a.target_ref IS NOT DISTINCT FROM $3
              AND a.decision = 'approved'
              AND NOT EXISTS (SELECT 1 FROM gov_approval_consumptions c WHERE c.approval_id = a.id)
        )
        "#,
    )
    .bind(request_ref)
    .bind(expected_kind)
    .bind(expected_target)
    .fetch_one(conn)
    .await?;
    Ok(Some(exists))
}

/// Bind-match AND consume in ONE statement, inside the caller's write tx so the
/// consumption is atomic with the gated mutation (a rolled-back action un-consumes
/// the approval). The `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING` both
/// enforces the binding predicate and makes the single-use atomic: two concurrent
/// consumers of the same approval serialize on the `(org_id, approval_id)` unique
/// index and exactly one gets a returned row — the other sees `Some(false)` (replay
/// denied). `Some(true)` = newly consumed (gate passes); `Some(false)` = no match or
/// already consumed (gate fails closed).
pub async fn four_eyes_consume_conn(
    conn: &mut PgConnection,
    request_ref: Uuid,
    expected_kind: &str,
    expected_target: Option<Uuid>,
    consumed_by: UserId,
) -> Result<Option<bool>, PgGovernanceError> {
    let consumed: Option<Uuid> = sqlx::query_scalar(
        r#"
        INSERT INTO gov_approval_consumptions (org_id, approval_id, consumed_by)
        SELECT a.org_id, a.id, $4
        FROM gov_approvals a
        WHERE a.request_ref = $1
          AND a.kind = $2
          AND a.target_ref IS NOT DISTINCT FROM $3
          AND a.decision = 'approved'
          AND NOT EXISTS (SELECT 1 FROM gov_approval_consumptions c WHERE c.approval_id = a.id)
        ON CONFLICT (org_id, approval_id) DO NOTHING
        RETURNING approval_id
        "#,
    )
    .bind(request_ref)
    .bind(expected_kind)
    .bind(expected_target)
    .bind(*consumed_by.as_uuid())
    .fetch_optional(conn)
    .await?;
    Ok(Some(consumed.is_some()))
}
