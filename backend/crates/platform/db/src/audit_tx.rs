//! `with_audit` — the L1 transactional building block for every state mutation.
//!
//! Pattern (plan §2.2):
//!   `BEGIN → [caller mutation closure: SELECT FOR UPDATE → validate → UPDATE]
//!    → INSERT audit_events → COMMIT`
//!
//! If the closure returns `Err`, the transaction is rolled back and NEITHER
//! the mutation nor the audit row persists — atomicity is the hard contract.

use mnt_kernel_core::AuditEvent;
use sqlx::{PgPool, Postgres, Transaction};

use crate::error::DbError;

/// Execute a mutation closure inside a Postgres transaction, then append an
/// audit row in the **same** transaction before committing.
///
/// # Type parameters
/// - `F`: async closure that receives `&mut Transaction<'_, Postgres>` and
///   returns `Result<T, E>`. The closure is responsible for all domain
///   mutations (SELECT FOR UPDATE, validate transition, UPDATE target row).
/// - `T`: the value returned to the caller on success.
/// - `E`: the closure's error type; must be convertible from `DbError` so the
///   caller sees a single unified error surface.
///
/// # Atomicity guarantee
/// The closure error path rolls back the transaction before returning, so
/// neither the mutation nor the audit row ever lands in the database.
///
/// # Example
/// ```ignore
/// let updated = with_audit(&pool, audit_event, |tx| async move {
///     sqlx::query!("UPDATE users SET is_active = false WHERE id = $1", id)
///         .execute(tx.as_mut())
///         .await?;
///     Ok(())
/// }).await?;
/// ```
pub async fn with_audit<F, T, E>(
    pool: &PgPool,
    event: AuditEvent,
    f: F,
) -> Result<T, E>
where
    F: for<'tx> FnOnce(
        &'tx mut Transaction<'_, Postgres>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, E>> + Send + 'tx>>,
    E: From<DbError>,
{
    let mut tx = pool.begin().await.map_err(|e| E::from(DbError::Sqlx(e)))?;

    // Run the caller's mutation closure.
    let result = f(&mut tx).await;

    match result {
        Err(e) => {
            // Rollback is best-effort; the transaction is dropped on error
            // regardless, but explicit rollback surfaces the intent.
            let _ = tx.rollback().await;
            Err(e)
        }
        Ok(value) => {
            // Serialize optional snapshot fields.
            let before_json: Option<serde_json::Value> = event.before.clone();
            let after_json: Option<serde_json::Value> = event.after.clone();

            let actor_uuid: Option<uuid::Uuid> =
                event.actor.map(|uid| *uid.as_uuid());
            let event_id_uuid: uuid::Uuid = *event.id.as_uuid();
            let branch_uuid: Option<uuid::Uuid> =
                event.branch_id.map(|bid| *bid.as_uuid());
            let action_str = event.action.as_str();
            let occurred_at = event.occurred_at;
            let trace_id = event.trace.trace_id();
            let span_id = event.trace.span_id();

            sqlx::query!(
                r#"
                INSERT INTO audit_events (
                    id, actor, action, target_type, target_id,
                    branch_id, before_snap, after_snap,
                    trace_id, span_id, occurred_at
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8,
                    $9, $10, $11
                )
                "#,
                event_id_uuid,
                actor_uuid,
                action_str,
                event.target_type,
                event.target_id,
                branch_uuid,
                before_json,
                after_json,
                trace_id,
                span_id,
                occurred_at,
            )
            .execute(tx.as_mut())
            .await
            .map_err(|e| E::from(DbError::Sqlx(e)))?;

            tx.commit().await.map_err(|e| E::from(DbError::Sqlx(e)))?;
            Ok(value)
        }
    }
}

#[cfg(test)]
mod tests {
    use mnt_kernel_core::{AuditAction, AuditEvent, BranchId, TraceContext, UserId};
    use sqlx::PgPool;
    use time::OffsetDateTime;

    use super::with_audit;
    use crate::error::DbError;

    /// Convenience: build a minimal valid AuditEvent for test use.
    fn make_event(action: &str) -> AuditEvent {
        AuditEvent::new(
            Some(UserId::new()),
            AuditAction::new(action).unwrap(),
            "users",
            uuid::Uuid::new_v4().to_string(),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_branch(BranchId::new())
    }

    // -----------------------------------------------------------------------
    // (a) Happy path: mutation + audit both visible after commit.
    // -----------------------------------------------------------------------
    #[sqlx::test]
    async fn happy_path_mutation_and_audit_both_persist(pool: PgPool) {
        // Seed prerequisite rows (region → branch → user).
        let region_id: uuid::Uuid = sqlx::query_scalar!(
            "INSERT INTO regions (name) VALUES ($1) RETURNING id",
            "Test Region"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let branch_id: uuid::Uuid = sqlx::query_scalar!(
            "INSERT INTO branches (region_id, name) VALUES ($1, $2) RETURNING id",
            region_id,
            "Test Branch"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let user_id: uuid::Uuid = sqlx::query_scalar!(
            "INSERT INTO users (display_name, roles) VALUES ($1, $2) RETURNING id",
            "Alice",
            &["MECHANIC"] as &[&str],
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let before_snap = serde_json::json!({"is_active": true});
        let after_snap = serde_json::json!({"is_active": false});

        let event = AuditEvent::new(
            Some(mnt_kernel_core::UserId::from_uuid(user_id)),
            AuditAction::new("user.deactivate").unwrap(),
            "users",
            user_id.to_string(),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_branch(mnt_kernel_core::BranchId::from_uuid(branch_id))
        .with_snapshots(Some(before_snap.clone()), Some(after_snap.clone()));

        let event_id = *event.id.as_uuid();

        with_audit::<_, (), DbError>(&pool, event, |tx| {
            Box::pin(async move {
                sqlx::query!(
                    "UPDATE users SET is_active = false WHERE id = $1",
                    user_id,
                )
                .execute(tx.as_mut())
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();

        // Verify mutation persisted.
        let active: bool =
            sqlx::query_scalar!("SELECT is_active FROM users WHERE id = $1", user_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(!active, "user should be deactivated after commit");

        // Verify audit row persisted with correct fields.
        let row = sqlx::query!(
            r#"SELECT action, target_type, target_id, before_snap, after_snap,
                      trace_id, span_id
               FROM audit_events WHERE id = $1"#,
            event_id,
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(row.action, "user.deactivate");
        assert_eq!(row.target_type, "users");
        assert_eq!(row.target_id, user_id.to_string());
        assert_eq!(row.before_snap.unwrap(), before_snap);
        assert_eq!(row.after_snap.unwrap(), after_snap);
        assert_eq!(row.trace_id.len(), 32);
        assert_eq!(row.span_id.len(), 16);
    }

    // -----------------------------------------------------------------------
    // (b) Atomicity: closure error → neither mutation nor audit persists.
    // -----------------------------------------------------------------------
    #[sqlx::test]
    async fn atomicity_rollback_drops_both_mutation_and_audit(pool: PgPool) {
        let region_id: uuid::Uuid = sqlx::query_scalar!(
            "INSERT INTO regions (name) VALUES ($1) RETURNING id",
            "Rollback Region"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let _branch_id: uuid::Uuid = sqlx::query_scalar!(
            "INSERT INTO branches (region_id, name) VALUES ($1, $2) RETURNING id",
            region_id,
            "Rollback Branch"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let user_id: uuid::Uuid = sqlx::query_scalar!(
            "INSERT INTO users (display_name, roles) VALUES ($1, $2) RETURNING id",
            "Bob",
            &["MECHANIC"] as &[&str],
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let event = make_event("user.deactivate");
        let event_id = *event.id.as_uuid();

        let result = with_audit::<_, (), DbError>(&pool, event, |tx| {
            Box::pin(async move {
                // Perform a real mutation first...
                sqlx::query!(
                    "UPDATE users SET is_active = false WHERE id = $1",
                    user_id,
                )
                .execute(tx.as_mut())
                .await?;
                // ...then simulate a domain validation failure.
                Err(DbError::Sqlx(sqlx::Error::RowNotFound))
            })
        })
        .await;

        assert!(result.is_err(), "should propagate the closure error");

        // Mutation must NOT have persisted.
        let active: bool =
            sqlx::query_scalar!("SELECT is_active FROM users WHERE id = $1", user_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(active, "mutation should have been rolled back");

        // Audit row must NOT have persisted.
        let count: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM audit_events WHERE id = $1", event_id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .unwrap_or(0);
        assert_eq!(count, 0, "audit row should have been rolled back");
    }

    // -----------------------------------------------------------------------
    // (c) Append-only: UPDATE on audit_events must fail (trigger).
    // -----------------------------------------------------------------------
    #[sqlx::test]
    async fn append_only_update_on_audit_events_is_rejected(pool: PgPool) {
        // Insert a legitimate audit row directly (bypassing with_audit for
        // test setup simplicity — the trigger fires regardless of how the row
        // was inserted).
        let region_id: uuid::Uuid = sqlx::query_scalar!(
            "INSERT INTO regions (name) VALUES ($1) RETURNING id",
            "AO Region"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let branch_id: uuid::Uuid = sqlx::query_scalar!(
            "INSERT INTO branches (region_id, name) VALUES ($1, $2) RETURNING id",
            region_id,
            "AO Branch"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let event = make_event("test.action");
        let event_id = *event.id.as_uuid();

        // Insert a legitimate audit row via with_audit so the INSERT path works.
        let event_for_insert = AuditEvent::new(
            None,
            AuditAction::new("test.action").unwrap(),
            "test",
            "target-1",
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_branch(mnt_kernel_core::BranchId::from_uuid(branch_id));
        let insert_event_id = *event_for_insert.id.as_uuid();

        with_audit::<_, (), DbError>(&pool, event_for_insert, |_tx| {
            Box::pin(async move { Ok(()) })
        })
        .await
        .unwrap();

        // Now attempt UPDATE — the trigger must raise an exception.
        let update_result = sqlx::query!(
            "UPDATE audit_events SET action = 'tampered.action' WHERE id = $1",
            insert_event_id,
        )
        .execute(&pool)
        .await;

        assert!(
            update_result.is_err(),
            "UPDATE on audit_events must be rejected by trigger"
        );
        let err_msg = update_result.unwrap_err().to_string();
        assert!(
            err_msg.contains("append-only") || err_msg.contains("forbidden"),
            "error message should mention append-only: {err_msg}"
        );

        // Verify the row is unchanged.
        let action: String = sqlx::query_scalar!(
            "SELECT action FROM audit_events WHERE id = $1",
            insert_event_id,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(action, "test.action");

        // Suppress unused variable warning.
        let _ = (event_id, event);
    }

    // -----------------------------------------------------------------------
    // (c2) Append-only: DELETE on audit_events must fail (trigger).
    // -----------------------------------------------------------------------
    #[sqlx::test]
    async fn append_only_delete_on_audit_events_is_rejected(pool: PgPool) {
        let region_id: uuid::Uuid = sqlx::query_scalar!(
            "INSERT INTO regions (name) VALUES ($1) RETURNING id",
            "Del Region"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let branch_id: uuid::Uuid = sqlx::query_scalar!(
            "INSERT INTO branches (region_id, name) VALUES ($1, $2) RETURNING id",
            region_id,
            "Del Branch"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let event = AuditEvent::new(
            None,
            AuditAction::new("test.delete.target").unwrap(),
            "test",
            "target-2",
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_branch(mnt_kernel_core::BranchId::from_uuid(branch_id));
        let insert_event_id = *event.id.as_uuid();

        with_audit::<_, (), DbError>(&pool, event, |_tx| Box::pin(async move { Ok(()) }))
            .await
            .unwrap();

        let delete_result = sqlx::query!(
            "DELETE FROM audit_events WHERE id = $1",
            insert_event_id,
        )
        .execute(&pool)
        .await;

        assert!(
            delete_result.is_err(),
            "DELETE on audit_events must be rejected by trigger"
        );
        let err_msg = delete_result.unwrap_err().to_string();
        assert!(
            err_msg.contains("append-only") || err_msg.contains("forbidden"),
            "error message should mention append-only: {err_msg}"
        );

        // Row must still exist.
        let count: i64 =
            sqlx::query_scalar!(
                "SELECT COUNT(*) FROM audit_events WHERE id = $1",
                insert_event_id,
            )
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        assert_eq!(count, 1, "row should still exist after failed DELETE");
    }

    // -----------------------------------------------------------------------
    // (d) CHECK constraint: malformed action string rejected at the DB layer.
    // -----------------------------------------------------------------------
    #[sqlx::test]
    async fn action_check_constraint_rejects_malformed_actions(pool: PgPool) {
        // The kernel AuditAction type also validates, but we verify the DB
        // CHECK constraint fires independently (defense in depth).
        let bad_action = "NotValid"; // no dot separator, uppercase

        let result = sqlx::query!(
            r#"INSERT INTO audit_events
               (id, action, target_type, target_id, trace_id, span_id, occurred_at)
               VALUES (gen_random_uuid(), $1, 'test', 'x',
                       $2, $3, now())"#,
            bad_action,
            "a".repeat(32),
            "b".repeat(16),
        )
        .execute(&pool)
        .await;

        assert!(
            result.is_err(),
            "DB CHECK constraint must reject malformed action"
        );
    }
}
