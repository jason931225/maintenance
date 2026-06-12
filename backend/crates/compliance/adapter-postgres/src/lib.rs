//! Postgres compliance adapter.
//!
//! Location pings are deliberately destructible and are not written through
//! `with_audit`; consent lifecycle transitions are audited in the same
//! transaction as the state mutation.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_compliance_application::{
    ConsentTransitionCommand, ConsentTransitionKind, consent_audit_event,
};
use mnt_compliance_domain::{
    LocationConsent, LocationConsentState, LocationPing, PersistedLocationConsent,
};
use mnt_kernel_core::{BranchId, ConsentId, KernelError, Timestamp, UserId};
use mnt_platform_db::{DbError, with_audit};
use sqlx::PgPool;

#[derive(Debug, thiserror::Error)]
pub enum PgComplianceError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl From<sqlx::Error> for PgComplianceError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

#[derive(Debug, Clone)]
pub struct PgComplianceStore {
    pool: PgPool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetentionPurge {
    pub dropped_ping_partitions: i32,
    pub deleted_collection_logs: i64,
}

impl PgComplianceStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn transition_consent(
        &self,
        command: ConsentTransitionCommand,
    ) -> Result<LocationConsent, PgComplianceError> {
        let before = self
            .current_or_unrecorded(command.user_id, command.branch_id)
            .await?;
        let mut after = before.clone();
        let transition = command.kind.apply(&mut after, command.occurred_at)?;
        let event = consent_audit_event(&command, &before, &after)?;

        let user_uuid = *command.user_id.as_uuid();
        let branch_uuid = *command.branch_id.as_uuid();
        let actor_uuid = command.actor.map(|actor| *actor.as_uuid());
        let action = command.kind.audit_action().to_string();
        let expected_id = if before.state() == LocationConsentState::NoRecord {
            None
        } else {
            Some(*before.id().as_uuid())
        };
        let expected_status = if before.state() == LocationConsentState::NoRecord {
            None
        } else {
            Some(before.state().as_db_str().to_string())
        };
        let consent_id = *after.id().as_uuid();
        let status = after.state().as_db_str().to_string();
        let granted_at = after.granted_at();
        let suspended_at = after.suspended_at();
        let resumed_at = after.resumed_at();
        let withdrawn_at = after.withdrawn_at();
        let updated_at = after.updated_at().unwrap_or(command.occurred_at);
        let from_status = transition.from.as_db_str().to_string();
        let to_status = transition.to.as_db_str().to_string();
        let occurred_at = command.occurred_at;
        let destroy_location_data = command.kind == ConsentTransitionKind::Withdraw;
        let returned = after.clone();

        with_audit::<_, LocationConsent, PgComplianceError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let current = sqlx::query!(
                    r#"
                    SELECT id, status
                    FROM location_consents
                    WHERE user_id = $1
                    FOR UPDATE
                    "#,
                    user_uuid,
                )
                .fetch_optional(tx.as_mut())
                .await?;

                match (current, expected_id, expected_status.as_deref()) {
                    (None, None, None) => {
                        sqlx::query!(
                            r#"
                            INSERT INTO location_consents (
                                id, user_id, branch_id, status,
                                granted_at, suspended_at, resumed_at, withdrawn_at, updated_at
                            )
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                            "#,
                            consent_id,
                            user_uuid,
                            branch_uuid,
                            status,
                            granted_at,
                            suspended_at,
                            resumed_at,
                            withdrawn_at,
                            updated_at,
                        )
                        .execute(tx.as_mut())
                        .await?;
                    }
                    (Some(row), Some(expected_id), Some(expected_status)) => {
                        if row.id != expected_id || row.status != expected_status {
                            return Err(KernelError::conflict(
                                "location consent changed during transition",
                            )
                            .into());
                        }

                        sqlx::query!(
                            r#"
                            UPDATE location_consents
                            SET status = $2,
                                granted_at = $3,
                                suspended_at = $4,
                                resumed_at = $5,
                                withdrawn_at = $6,
                                updated_at = $7
                            WHERE id = $1
                            "#,
                            consent_id,
                            status,
                            granted_at,
                            suspended_at,
                            resumed_at,
                            withdrawn_at,
                            updated_at,
                        )
                        .execute(tx.as_mut())
                        .await?;
                    }
                    _ => {
                        return Err(KernelError::conflict(
                            "location consent changed before transition lock",
                        )
                        .into());
                    }
                }

                sqlx::query!(
                    r#"
                    INSERT INTO location_consent_ledger (
                        consent_id, user_id, branch_id, actor, action,
                        from_status, to_status, occurred_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    "#,
                    consent_id,
                    user_uuid,
                    branch_uuid,
                    actor_uuid,
                    action,
                    from_status,
                    to_status,
                    occurred_at,
                )
                .execute(tx.as_mut())
                .await?;

                if destroy_location_data {
                    sqlx::query!(
                        "DELETE FROM location_collection_logs WHERE user_id = $1",
                        user_uuid,
                    )
                    .execute(tx.as_mut())
                    .await?;

                    sqlx::query!("DELETE FROM location_pings WHERE user_id = $1", user_uuid,)
                        .execute(tx.as_mut())
                        .await?;
                }

                Ok(returned)
            })
        })
        .await
    }

    pub async fn record_location_ping(&self, ping: LocationPing) -> Result<(), PgComplianceError> {
        if !ping.on_duty() {
            return Err(KernelError::forbidden(
                "location pings may only be collected while on duty",
            )
            .into());
        }

        let user_uuid = *ping.user_id().as_uuid();
        let branch_uuid = *ping.branch_id().as_uuid();
        let ping_uuid = *ping.id().as_uuid();
        let latitude = ping.latitude();
        let longitude = ping.longitude();
        let accuracy_m = ping.accuracy_m();
        let recorded_at = ping.recorded_at();

        let mut tx = self.pool.begin().await?;

        sqlx::query_scalar!("SELECT location_pings_ensure_partition($1)", recorded_at,)
            .fetch_one(tx.as_mut())
            .await?;

        let consent = sqlx::query!(
            r#"
            SELECT status
            FROM location_consents
            WHERE user_id = $1 AND branch_id = $2
            FOR SHARE
            "#,
            user_uuid,
            branch_uuid,
        )
        .fetch_optional(tx.as_mut())
        .await?;

        match consent.as_ref().map(|row| row.status.as_str()) {
            Some("GRANTED") => {}
            Some("SUSPENDED" | "WITHDRAWN") | None => {
                let _ = tx.rollback().await;
                return Err(KernelError::forbidden(
                    "location consent is not granted for ping collection",
                )
                .into());
            }
            Some(other) => {
                let _ = tx.rollback().await;
                return Err(KernelError::validation(format!(
                    "unknown location consent status {other:?}"
                ))
                .into());
            }
        }

        sqlx::query!(
            r#"
            INSERT INTO location_pings (
                id, user_id, branch_id, latitude, longitude,
                accuracy_m, recorded_at, on_duty
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
            ping_uuid,
            user_uuid,
            branch_uuid,
            latitude,
            longitude,
            accuracy_m,
            recorded_at,
            ping.on_duty(),
        )
        .execute(tx.as_mut())
        .await?;

        sqlx::query!(
            r#"
            INSERT INTO location_collection_logs (
                user_id, branch_id, ping_id, recorded_at, reason
            )
            VALUES ($1, $2, $3, $4, 'on_duty_location_ping')
            "#,
            user_uuid,
            branch_uuid,
            ping_uuid,
            recorded_at,
        )
        .execute(tx.as_mut())
        .await?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn purge_expired_location_data(
        &self,
        retain_after: Timestamp,
    ) -> Result<RetentionPurge, PgComplianceError> {
        let row = sqlx::query!(
            r#"
            SELECT dropped_ping_partitions, deleted_collection_logs
            FROM purge_expired_location_data($1)
            "#,
            retain_after,
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(RetentionPurge {
            dropped_ping_partitions: row.dropped_ping_partitions.unwrap_or_default(),
            deleted_collection_logs: row.deleted_collection_logs.unwrap_or_default(),
        })
    }

    async fn current_or_unrecorded(
        &self,
        user_id: UserId,
        branch_id: BranchId,
    ) -> Result<LocationConsent, PgComplianceError> {
        let user_uuid = *user_id.as_uuid();
        let row = sqlx::query!(
            r#"
            SELECT id, user_id, branch_id, status,
                   granted_at, suspended_at, resumed_at, withdrawn_at, updated_at
            FROM location_consents
            WHERE user_id = $1
            "#,
            user_uuid,
        )
        .fetch_optional(&self.pool)
        .await?;

        let Some(row) = row else {
            return Ok(LocationConsent::unrecorded(user_id, branch_id));
        };

        if row.branch_id != *branch_id.as_uuid() {
            return Err(
                KernelError::forbidden("location consent belongs to a different branch").into(),
            );
        }

        Ok(LocationConsent::from_persisted(PersistedLocationConsent {
            id: ConsentId::from_uuid(row.id),
            user_id: UserId::from_uuid(row.user_id),
            branch_id: BranchId::from_uuid(row.branch_id),
            state: LocationConsentState::from_db_str(&row.status)?,
            granted_at: row.granted_at,
            suspended_at: row.suspended_at,
            resumed_at: row.resumed_at,
            withdrawn_at: row.withdrawn_at,
            updated_at: row.updated_at,
        }))
    }
}
