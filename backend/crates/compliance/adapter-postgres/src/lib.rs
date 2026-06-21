//! Postgres compliance adapter.
//!
//! Location pings are deliberately destructible and are not written through
//! `with_audit`; consent lifecycle transitions are audited in the same
//! transaction as the state mutation.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_compliance_application::{
    ConsentTransitionCommand, ConsentTransitionKind, LocationConsentLedgerEntry,
    LocationConsentLedgerPage, LocationConsentLedgerQuery, consent_audit_event,
};
use mnt_compliance_domain::{
    LocationConsent, LocationConsentState, LocationPing, PersistedLocationConsent,
    evaluate_geofence,
};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, ConsentId, DEFAULT_GEOFENCE_RADIUS_M,
    ErrorKind, KernelError, OrgId, Timestamp, TraceContext, UserId,
};
use mnt_platform_db::{DbError, insert_audit_event, with_audit, with_org_conn};
use mnt_platform_request_context::current_org;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

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

impl PgComplianceError {
    #[must_use]
    pub const fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(error) => error.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(DbError::Sqlx(_)) | Self::Db(DbError::Serialize(_)) => ErrorKind::Internal,
        }
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

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn transition_consent(
        &self,
        command: ConsentTransitionCommand,
    ) -> Result<LocationConsent, PgComplianceError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let before = self
            .current_or_unrecorded(command.user_id, command.branch_id)
            .await?;
        let mut after = before.clone();
        let transition = command.kind.apply(&mut after, command.occurred_at)?;
        let event = consent_audit_event(&command, &before, &after)?.with_org(org);

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
                                granted_at, suspended_at, resumed_at, withdrawn_at, updated_at,
                                org_id
                            )
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
                            org_uuid,
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
                        from_status, to_status, occurred_at, org_id
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    "#,
                    consent_id,
                    user_uuid,
                    branch_uuid,
                    actor_uuid,
                    action,
                    from_status,
                    to_status,
                    occurred_at,
                    org_uuid,
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

                    // The geofence presence state is location-derived, so it is
                    // erased with the raw pings on consent withdrawal. The durable,
                    // coordinate-free site_attendance_events (work facts) are NOT
                    // deleted here — they survive withdrawal like a timesheet (#13).
                    sqlx::query!(
                        "DELETE FROM site_geofence_presence WHERE user_id = $1",
                        user_uuid,
                    )
                    .execute(tx.as_mut())
                    .await?;
                }

                Ok(returned)
            })
        })
        .await
    }

    pub async fn current_consent(
        &self,
        user_id: UserId,
        branch_id: BranchId,
    ) -> Result<LocationConsent, PgComplianceError> {
        self.current_or_unrecorded(user_id, branch_id).await
    }

    // mnt-gate: state-changing-handler
    // mnt-gate: audit-exempt location_ping_ingestion
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
        // Consent is per-user (UNIQUE (user_id)); a multi-branch user who granted
        // consent in one branch may ping while on duty in any branch in scope.
        // The ping's own branch_id is still recorded below for audit/retention.
        let latitude = ping.latitude();
        let longitude = ping.longitude();
        let accuracy_m = ping.accuracy_m();
        let recorded_at = ping.recorded_at();

        let on_duty = ping.on_duty();
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_org_conn::<_, _, PgComplianceError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                sqlx::query_scalar!("SELECT location_pings_ensure_partition($1)", recorded_at,)
                    .fetch_one(tx.as_mut())
                    .await?;

                let consent = sqlx::query!(
                    r#"
            SELECT status
            FROM location_consents
            WHERE user_id = $1
            FOR SHARE
            "#,
                    user_uuid,
                )
                .fetch_optional(tx.as_mut())
                .await?;

                match consent.as_ref().map(|row| row.status.as_str()) {
                    Some("GRANTED") => {}
                    Some("SUSPENDED" | "WITHDRAWN") | None => {
                        return Err(KernelError::forbidden(
                            "location consent is not granted for ping collection",
                        )
                        .into());
                    }
                    Some(other) => {
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
                accuracy_m, recorded_at, on_duty, org_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
                    ping_uuid,
                    user_uuid,
                    branch_uuid,
                    latitude,
                    longitude,
                    accuracy_m,
                    recorded_at,
                    on_duty,
                    org_uuid,
                )
                .execute(tx.as_mut())
                .await?;

                sqlx::query!(
                    r#"
            INSERT INTO location_collection_logs (
                user_id, branch_id, ping_id, recorded_at, reason, org_id
            )
            VALUES ($1, $2, $3, $4, 'on_duty_location_ping', $5)
            "#,
                    user_uuid,
                    branch_uuid,
                    ping_uuid,
                    recorded_at,
                    org_uuid,
                )
                .execute(tx.as_mut())
                .await?;

                // Derive arrival/departure for this on-duty ping against the
                // mechanic's active work-order site geofences, in the same tx so
                // the ping and any crossing event commit atomically (#13).
                record_geofence_crossings(
                    tx,
                    org_uuid,
                    user_uuid,
                    branch_uuid,
                    latitude,
                    longitude,
                    recorded_at,
                )
                .await?;

                Ok(())
            })
        })
        .await
    }

    pub async fn purge_expired_location_data(
        &self,
        retain_after: Timestamp,
    ) -> Result<RetentionPurge, PgComplianceError> {
        let org = current_org().map_err(KernelError::from)?;
        let row = with_org_conn::<_, _, PgComplianceError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query!(
                    r#"
            SELECT dropped_ping_partitions, deleted_collection_logs
            FROM purge_expired_location_data($1)
            "#,
                    retain_after,
                )
                .fetch_one(tx.as_mut())
                .await?)
            })
        })
        .await?;

        Ok(RetentionPurge {
            dropped_ping_partitions: row.dropped_ping_partitions.unwrap_or_default(),
            deleted_collection_logs: row.deleted_collection_logs.unwrap_or_default(),
        })
    }

    pub async fn list_location_consent_ledger(
        &self,
        branch_scope: &BranchScope,
        query: LocationConsentLedgerQuery,
    ) -> Result<LocationConsentLedgerPage, PgComplianceError> {
        let total = self
            .count_location_consent_ledger(branch_scope, &query)
            .await?;
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            SELECT id, consent_id, user_id, branch_id, actor, action,
                   from_status, to_status, occurred_at, created_at
            FROM location_consent_ledger l
            WHERE
            "#,
        );
        push_location_consent_ledger_filters(&mut builder, branch_scope, &query);
        builder.push(" ORDER BY l.occurred_at DESC, l.id DESC LIMIT ");
        builder.push_bind(query.limit);
        builder.push(" OFFSET ");
        builder.push_bind(query.offset);

        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgComplianceError>(&self.pool, org, move |tx| {
            Box::pin(async move { Ok(builder.build().fetch_all(tx.as_mut()).await?) })
        })
        .await?;
        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            let id: uuid::Uuid = row.try_get("id")?;
            let consent_id: uuid::Uuid = row.try_get("consent_id")?;
            let user_id: uuid::Uuid = row.try_get("user_id")?;
            let branch_id: uuid::Uuid = row.try_get("branch_id")?;
            let actor: Option<uuid::Uuid> = row.try_get("actor")?;
            let from_status: String = row.try_get("from_status")?;
            let to_status: String = row.try_get("to_status")?;

            items.push(LocationConsentLedgerEntry {
                id: id.to_string(),
                consent_id: consent_id.to_string(),
                user_id: UserId::from_uuid(user_id),
                branch_id: BranchId::from_uuid(branch_id),
                actor: actor.map(UserId::from_uuid),
                action: row.try_get("action")?,
                from_status: LocationConsentState::from_db_str(&from_status)?,
                to_status: LocationConsentState::from_db_str(&to_status)?,
                occurred_at: row.try_get("occurred_at")?,
                created_at: row.try_get("created_at")?,
            });
        }

        Ok(LocationConsentLedgerPage {
            items,
            limit: query.limit,
            offset: query.offset,
            total,
        })
    }

    async fn count_location_consent_ledger(
        &self,
        branch_scope: &BranchScope,
        query: &LocationConsentLedgerQuery,
    ) -> Result<i64, PgComplianceError> {
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            SELECT COUNT(*)
            FROM location_consent_ledger l
            WHERE
            "#,
        );
        push_location_consent_ledger_filters(&mut builder, branch_scope, query);
        let org = current_org().map_err(KernelError::from)?;
        let total: i64 = with_org_conn::<_, _, PgComplianceError>(&self.pool, org, move |tx| {
            Box::pin(async move { Ok(builder.build_query_scalar().fetch_one(tx.as_mut()).await?) })
        })
        .await?;
        Ok(total)
    }

    async fn current_or_unrecorded(
        &self,
        user_id: UserId,
        branch_id: BranchId,
    ) -> Result<LocationConsent, PgComplianceError> {
        let user_uuid = *user_id.as_uuid();
        let org = current_org().map_err(KernelError::from)?;
        let row = with_org_conn::<_, _, PgComplianceError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query!(
                    r#"
            SELECT id, user_id, branch_id, status,
                   granted_at, suspended_at, resumed_at, withdrawn_at, updated_at
            FROM location_consents
            WHERE user_id = $1
            "#,
                    user_uuid,
                )
                .fetch_optional(tx.as_mut())
                .await?)
            })
        })
        .await?;

        let Some(row) = row else {
            return Ok(LocationConsent::unrecorded(user_id, branch_id));
        };

        // Consent is per-user (UNIQUE (user_id)); the stored branch is the branch
        // the user consented in and is preserved as-is. A multi-branch user is not
        // rejected when the queried branch differs from the consent's branch.
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

/// Derive arrival/departure events for one on-duty ping against the mechanic's
/// active work-order site geofences, inside the already-armed ping transaction.
///
/// For each active (non-terminal) work order assigned to the user whose site is
/// geocoded: load the prior inside/outside state (FOR UPDATE), evaluate the
/// haversine distance vs the site's effective radius (per-site override or the
/// 150 m default), and on an inside/outside EDGE upsert the presence row + append
/// a coordinate-free `site_attendance_events` row + an audit event. Edge-
/// triggered, so a steady stream of pings emits nothing.
///
/// The ping itself is audit-exempt, but these derived attendance writes ARE
/// audited (site.arrival / site.departure) — hence the marker + insert_audit_event.
// mnt-gate: state-changing-handler
async fn record_geofence_crossings(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    user_uuid: uuid::Uuid,
    branch_uuid: uuid::Uuid,
    ping_latitude: f64,
    ping_longitude: f64,
    recorded_at: Timestamp,
) -> Result<(), PgComplianceError> {
    let candidates = sqlx::query!(
        r#"
        SELECT a.work_order_id     AS "work_order_id!",
               w.site_id           AS "site_id!",
               s.latitude          AS "latitude!",
               s.longitude         AS "longitude!",
               s.geofence_radius_m AS "geofence_radius_m"
        FROM work_order_assignments a
        JOIN work_orders w    ON w.id = a.work_order_id
        JOIN registry_sites s ON s.id = w.site_id
        WHERE a.mechanic_id = $1
          AND w.status NOT IN ('FINAL_COMPLETED', 'CANCELLED', 'ARCHIVED')
          AND s.latitude IS NOT NULL
          AND s.longitude IS NOT NULL
        "#,
        user_uuid,
    )
    .fetch_all(tx.as_mut())
    .await?;

    for candidate in candidates {
        let work_order_id = candidate.work_order_id;
        let site_id = candidate.site_id;
        let radius = candidate
            .geofence_radius_m
            .unwrap_or(DEFAULT_GEOFENCE_RADIUS_M);

        let prior_inside = sqlx::query_scalar!(
            r#"
            SELECT inside FROM site_geofence_presence
            WHERE org_id = $1 AND user_id = $2 AND work_order_id = $3 AND site_id = $4
            FOR UPDATE
            "#,
            org_uuid,
            user_uuid,
            work_order_id,
            site_id,
        )
        .fetch_optional(tx.as_mut())
        .await?;

        let (now_inside, crossing) = evaluate_geofence(
            ping_latitude,
            ping_longitude,
            candidate.latitude,
            candidate.longitude,
            radius,
            prior_inside,
        );

        if prior_inside.is_none() {
            sqlx::query!(
                r#"
                INSERT INTO site_geofence_presence
                    (org_id, user_id, work_order_id, site_id, inside, since)
                VALUES ($1, $2, $3, $4, $5, $6)
                "#,
                org_uuid,
                user_uuid,
                work_order_id,
                site_id,
                now_inside,
                recorded_at,
            )
            .execute(tx.as_mut())
            .await?;
        } else if crossing.is_some() {
            sqlx::query!(
                r#"
                UPDATE site_geofence_presence
                SET inside = $5, since = $6, updated_at = now()
                WHERE org_id = $1 AND user_id = $2 AND work_order_id = $3 AND site_id = $4
                "#,
                org_uuid,
                user_uuid,
                work_order_id,
                site_id,
                now_inside,
                recorded_at,
            )
            .execute(tx.as_mut())
            .await?;
        }

        if let Some(crossing) = crossing {
            let event_id = sqlx::query_scalar!(
                r#"
                INSERT INTO site_attendance_events
                    (org_id, user_id, branch_id, work_order_id, site_id, kind, occurred_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id
                "#,
                org_uuid,
                user_uuid,
                branch_uuid,
                work_order_id,
                site_id,
                crossing.kind(),
                recorded_at,
            )
            .fetch_one(tx.as_mut())
            .await?;

            // Coordinate-free work fact (no lat/lon) so the durable record is not
            // location data subject to the consent-withdrawal erasure carve-out.
            let after = serde_json::json!({
                "work_order_id": work_order_id,
                "site_id": site_id,
                "kind": crossing.kind(),
                "occurred_at": recorded_at,
            });
            let event = AuditEvent::new(
                Some(UserId::from_uuid(user_uuid)),
                AuditAction::new(crossing.audit_action())?,
                "site_attendance_events",
                event_id.to_string(),
                TraceContext::generate(),
                recorded_at,
            )
            .with_branch(BranchId::from_uuid(branch_uuid))
            .with_snapshots(None, Some(after))
            .with_org(OrgId::from_uuid(org_uuid));
            insert_audit_event(tx, &event).await?;
        }
    }

    Ok(())
}

fn push_location_consent_ledger_filters(
    builder: &mut QueryBuilder<Postgres>,
    branch_scope: &BranchScope,
    query: &LocationConsentLedgerQuery,
) {
    push_branch_scope_filter(builder, branch_scope);
    if let Some(branch_id) = query.branch_id {
        builder.push(" AND l.branch_id = ");
        builder.push_bind(*branch_id.as_uuid());
    }
    if let Some(user_id) = query.user_id {
        builder.push(" AND l.user_id = ");
        builder.push_bind(*user_id.as_uuid());
    }
}

fn push_branch_scope_filter(builder: &mut QueryBuilder<Postgres>, branch_scope: &BranchScope) {
    match branch_scope {
        BranchScope::All => {
            builder.push(" TRUE ");
        }
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push(" FALSE ");
        }
        BranchScope::Branches(branches) => {
            let branch_ids: Vec<uuid::Uuid> =
                branches.iter().map(|branch| *branch.as_uuid()).collect();
            builder.push(" l.branch_id = ANY(");
            builder.push_bind(branch_ids);
            builder.push(") ");
        }
    }
}
