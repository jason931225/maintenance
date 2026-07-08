//! Postgres adapter for the identity/org-setup domain.
//!
//! Every mutation routes through `with_audit`/`with_audits` so an `audit_events`
//! row lands in the SAME transaction as the state change (audit-coverage gate).
//! User reads are branch-scoped: `BranchScope::All` (SUPER_ADMIN/EXECUTIVE) sees
//! every user; a branch-scoped caller sees only users sharing an in-scope branch.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;

use mnt_identity_application::{
    BranchSummary, CreateBranchCommand, CreatePolicyAssignmentPreviewReceiptCommand,
    CreatePolicyRoleCommand, CreateRegionCommand, CreateUserCommand, DeactivateBranchCommand,
    DeactivateRegionCommand, DeactivateUserCommand, EmployeeLinkStatus,
    PolicyAssignmentPreviewReceiptSummary, PolicyAuditEventSummary, PolicyRoleAssignmentSummary,
    PolicyRoleCondition, PolicyRolePermission, PolicyRoleSummary, PolicyVersionSummary,
    RegionSummary, ReplacePolicyRoleAssignmentsCommand, UpdateBranchCommand,
    UpdatePolicyRoleCommand, UpdatePolicyRoleStatusCommand, UpdateRegionCommand,
    UpdateSelfProfileCommand, UpdateUserCommand, UserListQuery, UserPage, UserSummary,
    account_status_for, branch_audit_event, policy_role_assignment_audit_event,
    policy_role_audit_event, region_audit_event, user_audit_event,
};
use mnt_identity_domain::{
    Team, normalize_optional_phone, validate_display_name, validate_org_name,
};
use mnt_kernel_core::{
    BranchId, BranchScope, ErrorKind, KernelError, RegionId, TraceContext, UserId,
};
use mnt_platform_db::{DbError, insert_audit_event, with_audit, with_org_conn};
use mnt_platform_request_context::current_org;
use sqlx::{PgPool, Postgres, QueryBuilder, Row, Transaction};

const DEFAULT_USER_LIMIT: i64 = 50;
const MAX_USER_LIMIT: i64 = 200;

#[derive(Debug, thiserror::Error)]
pub enum PgOrgError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl PgOrgError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(error) => error.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(DbError::Sqlx(sqlx::Error::Database(error)))
                if error.code().is_some_and(|code| code == "23505") =>
            {
                ErrorKind::Conflict
            }
            // FK violation (e.g. unknown region/branch reference).
            Self::Db(DbError::Sqlx(sqlx::Error::Database(error)))
                if error.code().is_some_and(|code| code == "23503") =>
            {
                ErrorKind::Validation
            }
            Self::Db(_) => ErrorKind::Internal,
        }
    }
}

impl From<sqlx::Error> for PgOrgError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

#[derive(Debug, Clone)]
pub struct PgOrgStore {
    pool: PgPool,
}

impl PgOrgStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    // -----------------------------------------------------------------------
    // Users
    // -----------------------------------------------------------------------

    /// Create a user with role assignments and branch memberships. Roles are
    /// already validated against the authz matrix at the REST boundary; the DB
    /// CHECK constraint is the final backstop.
    pub async fn create_user(&self, command: CreateUserCommand) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let display_name = validate_display_name(&command.display_name)?;
        let phone = normalize_optional_phone(command.phone.as_deref())?;
        let team_db = command.team.map(Team::as_db_str);
        let employee_id = command.employee_id;
        let user_id = UserId::new();
        let branch_ids: Vec<uuid::Uuid> = command.branch_ids.iter().map(|b| *b.as_uuid()).collect();

        let event = user_audit_event(
            "user.create",
            Some(command.actor),
            user_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "display_name": display_name,
                "employee_id": employee_id,
                "roles": command.roles,
                "team": team_db,
                "branch_ids": command.branch_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
                "is_active": true,
            })),
        )
        .with_org(org);

        let roles = command.roles.clone();
        with_audit::<_, UserSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO users (id, display_name, employee_id, phone, roles, team, is_active, created_at, org_id)
                    VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
                    "#,
                )
                .bind(*user_id.as_uuid())
                .bind(&display_name)
                .bind(employee_id)
                .bind(phone.as_deref())
                .bind(&roles)
                .bind(team_db)
                .bind(command.occurred_at)
                .bind(org_uuid)
                .execute(tx.as_mut())
                .await?;

                replace_user_branches(tx, user_id, &branch_ids, org_uuid).await?;
                fetch_user_tx(tx, user_id).await
            })
        })
        .await
    }

    /// Partial update of a user's profile, roles, and/or memberships.
    pub async fn update_user(&self, command: UpdateUserCommand) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let display_name = command
            .display_name
            .as_deref()
            .map(validate_display_name)
            .transpose()?;
        let employee_id = command.employee_id;
        let phone = match &command.phone {
            None => None,
            Some(value) => Some(normalize_optional_phone(value.as_deref())?),
        };
        let team_db: Option<Option<&'static str>> = command
            .team
            .as_ref()
            .map(|inner| inner.map(Team::as_db_str));
        let roles = command.roles.clone();
        let branch_ids: Option<Vec<uuid::Uuid>> = command
            .branch_ids
            .as_ref()
            .map(|ids| ids.iter().map(|b| *b.as_uuid()).collect());
        let user_id = command.user_id;
        let occurred_at = command.occurred_at;

        let event = user_audit_event(
            "user.update",
            Some(command.actor),
            user_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, UserSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                // Ensure the target exists (and lock it) before mutating.
                let exists: Option<uuid::Uuid> =
                    sqlx::query_scalar("SELECT id FROM users WHERE id = $1 FOR UPDATE")
                        .bind(*user_id.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?;
                if exists.is_none() {
                    return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                }

                if let Some(display_name) = &display_name {
                    sqlx::query("UPDATE users SET display_name = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(display_name)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(employee_id) = employee_id {
                    sqlx::query("UPDATE users SET employee_id = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(employee_id)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(phone) = &phone {
                    sqlx::query("UPDATE users SET phone = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(phone.as_deref())
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(team_db) = team_db {
                    sqlx::query("UPDATE users SET team = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(team_db)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(roles) = &roles {
                    sqlx::query("UPDATE users SET roles = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(roles)
                        .execute(tx.as_mut())
                        .await?;
                    // A system-role change is authorization-relevant: bump the
                    // subject freshness version so a later Cedar slice can deny a
                    // token minted before the change. Only bumps when roles were
                    // actually part of this update (branch/profile-only edits do
                    // not touch authorization material).
                    bump_subject_version_tx(tx, org_uuid, *user_id.as_uuid(), occurred_at).await?;
                }
                if let Some(branch_ids) = &branch_ids {
                    replace_user_branches(tx, user_id, branch_ids, org_uuid).await?;
                }

                fetch_user_tx(tx, user_id).await
            })
        })
        .await
    }

    /// Self-service profile edit (display name and/or phone only).
    pub async fn update_self_profile(
        &self,
        command: UpdateSelfProfileCommand,
    ) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let display_name = command
            .display_name
            .as_deref()
            .map(validate_display_name)
            .transpose()?;
        let phone = match &command.phone {
            None => None,
            Some(value) => Some(normalize_optional_phone(value.as_deref())?),
        };
        let user_id = command.user_id;

        // Org-bind the audit row so it is tenant-attributable and the FORCE-RLS
        // `audit_events` write is armed via the same `with_audit` GUC.
        let event = user_audit_event(
            "user.update_self",
            Some(user_id),
            user_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, UserSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let exists: Option<uuid::Uuid> =
                    sqlx::query_scalar("SELECT id FROM users WHERE id = $1 FOR UPDATE")
                        .bind(*user_id.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?;
                if exists.is_none() {
                    return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                }
                if let Some(display_name) = &display_name {
                    sqlx::query("UPDATE users SET display_name = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(display_name)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(phone) = &phone {
                    sqlx::query("UPDATE users SET phone = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(phone.as_deref())
                        .execute(tx.as_mut())
                        .await?;
                }
                fetch_user_tx(tx, user_id).await
            })
        })
        .await
    }

    /// Read the caller's console workspace layout (Oyatie window engine, UI-M1b).
    ///
    /// The `layout` jsonb is OPAQUE to the backend — the frontend owns its shape
    /// and it is stored/returned verbatim. An absent row is the empty-default
    /// `{}` (a fresh user with no saved layout). Read under RLS so the caller can
    /// only ever see their own tenant's row (`app.current_org` armed by
    /// `with_org_conn`; the PK's `user_id` scopes to the person).
    pub async fn get_workspace_layout(
        &self,
        user_id: UserId,
    ) -> Result<serde_json::Value, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let user_uuid = *user_id.as_uuid();
        let layout =
            with_org_conn::<_, Option<serde_json::Value>, PgOrgError>(&self.pool, org, move |tx| {
                Box::pin(async move {
                    Ok(sqlx::query_scalar(
                        "SELECT layout FROM me_workspace_layouts WHERE user_id = $1",
                    )
                    .bind(user_uuid)
                    .fetch_optional(tx.as_mut())
                    .await?)
                })
            })
            .await?;
        Ok(layout.unwrap_or_else(|| serde_json::json!({})))
    }

    /// Upsert the caller's console workspace layout. The write is audited (a
    /// `user.workspace_update` event lands in the SAME transaction, which also
    /// arms `app.current_org` for the FORCE-RLS `me_workspace_layouts` write).
    /// The stored `layout` is opaque and returned verbatim. The DB CHECKs
    /// (`jsonb_typeof = 'object'`, 64KiB size cap) are the final backstop for the
    /// user-writable blob.
    pub async fn put_workspace_layout(
        &self,
        user_id: UserId,
        layout: serde_json::Value,
        trace: TraceContext,
        occurred_at: mnt_kernel_core::Timestamp,
    ) -> Result<serde_json::Value, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let user_uuid = *user_id.as_uuid();

        let event = user_audit_event(
            "user.workspace_update",
            Some(user_id),
            user_id,
            trace,
            occurred_at,
        )?
        .with_org(org);

        with_audit::<_, serde_json::Value, PgOrgError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let stored: serde_json::Value = sqlx::query_scalar(
                    r#"
                    INSERT INTO me_workspace_layouts (org_id, user_id, layout)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (org_id, user_id)
                        DO UPDATE SET layout = EXCLUDED.layout
                    RETURNING layout
                    "#,
                )
                .bind(org_uuid)
                .bind(user_uuid)
                .bind(&layout)
                .fetch_one(tx.as_mut())
                .await?;
                Ok(stored)
            })
        })
        .await
    }

    /// Soft-deactivate a user AND revoke every active credential + session.
    ///
    /// Offboarding must close all access in one atomic, audited transaction:
    /// flipping `is_active = false` only blocks NEW sign-ins, but a deactivated
    /// user keeps an enrolled passkey and any live refresh-token family until each
    /// naturally expires. So this also DELETEs every WebAuthn credential the user
    /// owns (their passkeys can no longer authenticate) and revokes every one of
    /// the user's refresh-token families + tokens (any live session dies on its
    /// next rotation, and refresh fails).
    ///
    /// The credential/session tables are FORCE-RLS, so the org GUC is armed for
    /// this transaction (via `with_audit` from `event.with_org(org)`) before the
    /// closure touches them. Each sub-action is independently audited.
    pub async fn deactivate_user(
        &self,
        command: DeactivateUserCommand,
    ) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let user_id = command.user_id;
        let actor = command.actor;
        let trace = command.trace.clone();
        let occurred_at = command.occurred_at;
        let event = user_audit_event(
            "user.deactivate",
            Some(actor),
            user_id,
            trace.clone(),
            occurred_at,
        )?
        .with_org(org)
        .with_snapshots(
            Some(serde_json::json!({ "is_active": true })),
            Some(serde_json::json!({ "is_active": false })),
        );

        with_audit::<_, UserSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let affected = sqlx::query(
                    "UPDATE users SET is_active = false WHERE id = $1 AND is_active = true",
                )
                .bind(*user_id.as_uuid())
                .execute(tx.as_mut())
                .await?
                .rows_affected();
                if affected == 0 {
                    // Either the user is missing or already inactive.
                    let exists: Option<uuid::Uuid> =
                        sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
                            .bind(*user_id.as_uuid())
                            .fetch_optional(tx.as_mut())
                            .await?;
                    if exists.is_none() {
                        return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                    }
                }

                // Revoke passkeys: the org GUC is armed, so this RLS-gated DELETE
                // only ever touches THIS tenant's credentials.
                let revoked_credentials =
                    sqlx::query("DELETE FROM auth_webauthn_credentials WHERE user_id = $1")
                        .bind(*user_id.as_uuid())
                        .execute(tx.as_mut())
                        .await?
                        .rows_affected();
                let credential_event = user_audit_event(
                    "auth.passkey.revoke_all",
                    Some(actor),
                    user_id,
                    trace.clone(),
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(serde_json::json!({
                        "reason": "user_deactivated",
                        "revoked_credential_count": revoked_credentials,
                    })),
                );
                insert_audit_event(tx, &credential_event).await?;

                // Revoke every refresh-token family + token for the user, so any
                // live session dies on its next rotation and refresh fails closed.
                let revoked_families = sqlx::query(
                    r#"
                    UPDATE auth_refresh_token_families
                    SET revoked_at = $2, revoked_reason = 'user_deactivated'
                    WHERE user_id = $1 AND revoked_at IS NULL
                    "#,
                )
                .bind(*user_id.as_uuid())
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?
                .rows_affected();
                sqlx::query(
                    r#"
                    UPDATE auth_refresh_tokens
                    SET revoked_at = COALESCE(revoked_at, $2)
                    WHERE user_id = $1
                    "#,
                )
                .bind(*user_id.as_uuid())
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;
                let session_event = user_audit_event(
                    "auth.refresh.revoke_all",
                    Some(actor),
                    user_id,
                    trace.clone(),
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(serde_json::json!({
                        "reason": "user_deactivated",
                        "revoked_family_count": revoked_families,
                    })),
                );
                insert_audit_event(tx, &session_event).await?;

                // Offboarding revokes every credential + session; bump the
                // subject session_generation so any access token minted before
                // this point is recognizably stale to a later Cedar slice.
                bump_subject_session_generation_tx(
                    tx,
                    *org.as_uuid(),
                    *user_id.as_uuid(),
                    occurred_at,
                )
                .await?;

                fetch_user_tx(tx, user_id).await
            })
        })
        .await
    }

    /// Fetch a single user by id, restricted to the caller's branch scope.
    pub async fn get_user(
        &self,
        user_id: UserId,
        scope: &BranchScope,
    ) -> Result<UserSummary, PgOrgError> {
        if !user_in_scope(&self.pool, user_id, scope).await? {
            return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
        }
        fetch_user(&self.pool, user_id).await
    }

    /// List users visible within the caller's branch scope, as one page plus the
    /// unpaged `total` for that scope so the console can page beyond the cap and
    /// show an honest count.
    pub async fn list_users(
        &self,
        scope: &BranchScope,
        query: UserListQuery,
    ) -> Result<UserPage, PgOrgError> {
        let limit = query
            .limit
            .unwrap_or(DEFAULT_USER_LIMIT)
            .clamp(1, MAX_USER_LIMIT);
        let offset = query.offset.unwrap_or(0).max(0);

        // The branch-scope + active filter is shared by the id page and the
        // COUNT, so build it once into a closure that appends to any builder.
        let scope = scope.clone();
        let include_inactive = query.include_inactive;
        let push_filter = move |builder: &mut QueryBuilder<Postgres>| {
            match &scope {
                BranchScope::All => {
                    builder.push("TRUE");
                }
                BranchScope::Branches(branches) if branches.is_empty() => {
                    builder.push("FALSE");
                }
                BranchScope::Branches(branches) => {
                    let branch_ids: Vec<uuid::Uuid> =
                        branches.iter().map(|b| *b.as_uuid()).collect();
                    builder
                        .push(
                            "EXISTS (SELECT 1 FROM user_branches ub \
                             WHERE ub.user_id = u.id AND ub.branch_id = ANY(",
                        )
                        .push_bind(branch_ids)
                        .push("))");
                }
            }
            if !include_inactive {
                builder.push(" AND u.is_active = true");
            }
        };

        let mut count_builder =
            QueryBuilder::<Postgres>::new("SELECT COUNT(*) FROM users u WHERE ");
        push_filter(&mut count_builder);

        let mut builder = QueryBuilder::<Postgres>::new("SELECT id FROM users u WHERE ");
        push_filter(&mut builder);
        builder
            .push(" ORDER BY u.created_at DESC, u.id DESC LIMIT ")
            .push_bind(limit)
            .push(" OFFSET ")
            .push_bind(offset);

        let org = current_org().map_err(KernelError::from)?;
        let (total, ids) =
            with_org_conn::<_, (i64, Vec<uuid::Uuid>), PgOrgError>(&self.pool, org, move |tx| {
                Box::pin(async move {
                    let total: i64 = count_builder
                        .build_query_scalar::<i64>()
                        .fetch_one(tx.as_mut())
                        .await?;
                    let ids = builder
                        .build_query_scalar::<uuid::Uuid>()
                        .fetch_all(tx.as_mut())
                        .await?;
                    Ok((total, ids))
                })
            })
            .await?;

        let mut items = Vec::with_capacity(ids.len());
        for id in ids {
            items.push(fetch_user(&self.pool, UserId::from_uuid(id)).await?);
        }
        Ok(UserPage {
            items,
            limit,
            offset,
            total,
        })
    }

    // -----------------------------------------------------------------------
    // Policy Studio custom roles (G016-P0)
    // -----------------------------------------------------------------------

    /// List tenant-owned custom role definitions. Built-in system role templates
    /// are synthesized by the REST layer from the authz matrix; this adapter only
    /// reads tenant data under RLS.
    pub async fn list_policy_roles(&self) -> Result<Vec<PolicyRoleSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let ids: Vec<uuid::Uuid> = with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT id FROM policy_roles ORDER BY is_system DESC, role_key ASC",
                )
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;

        let mut roles = Vec::with_capacity(ids.len());
        for id in ids {
            roles.push(fetch_policy_role(&self.pool, id).await?);
        }
        Ok(roles)
    }

    /// Read the current per-org policy revision under RLS. Version 0 is a
    /// read-only projection for "no custom policy write yet" because
    /// `policy_versions` itself only stores real write revisions starting at 1.
    pub async fn get_policy_version(&self) -> Result<PolicyVersionSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    SELECT version, updated_at
                    FROM policy_versions
                    WHERE org_id = $1
                    "#,
                )
                .bind(org_uuid)
                .fetch_optional(tx.as_mut())
                .await?;

                let Some(row) = row else {
                    return Ok(PolicyVersionSummary {
                        version: 0,
                        updated_at: None,
                    });
                };
                Ok(PolicyVersionSummary {
                    version: row.try_get("version")?,
                    updated_at: Some(row.try_get("updated_at")?),
                })
            })
        })
        .await
    }

    /// Read the current subject authorization freshness `(version,
    /// session_generation)` for a user under RLS. An absent row (no bump yet)
    /// reads as `(0, 0)`, matching the token mint-time baseline. This is the
    /// DB-current side a later Cedar slice compares a token's carried snapshot
    /// against; SLICE-2 only sources it and no decision consults it yet.
    pub async fn get_subject_authz_versions(
        &self,
        user_id: UserId,
    ) -> Result<(i64, i64), PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let user_uuid = *user_id.as_uuid();
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move { fetch_subject_authz_versions_tx(tx, user_uuid).await })
        })
        .await
    }

    /// Resolve a per-tenant runtime feature flag via the `org_runtime_flag_enabled`
    /// SQL resolver (migration 0095) under the armed `mnt_rt` GUC. An absent row
    /// resolves to `false` (the dark default). Used by the Cedar/PBAC role_manage
    /// shadow lane's dark switch; a `false` result keeps the tenant fully on the
    /// legacy path (no shadow observation runs).
    pub async fn org_runtime_flag_enabled(&self, flag_key: &str) -> Result<bool, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let flag_key = flag_key.to_owned();
        with_org_conn::<_, bool, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let enabled: bool = sqlx::query_scalar("SELECT org_runtime_flag_enabled($1)")
                    .bind(flag_key)
                    .fetch_one(tx.as_mut())
                    .await?;
                Ok(enabled)
            })
        })
        .await
    }

    /// Return append-only policy audit evidence for the current tenant. This is
    /// read-only console evidence: it does not mutate policy and it never reads
    /// non-policy audit rows.
    pub async fn list_policy_audit_events(
        &self,
        limit: i64,
    ) -> Result<Vec<PolicyAuditEventSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    r#"
                    SELECT
                        id,
                        actor,
                        action,
                        target_type,
                        target_id,
                        before_snap,
                        after_snap,
                        trace_id::text AS trace_id,
                        span_id::text AS span_id,
                        occurred_at
                    FROM audit_events
                    WHERE org_id = $1
                      AND action LIKE 'policy.%'
                      AND target_type IN ('policy_role', 'policy_role_assignment')
                    ORDER BY occurred_at DESC, created_at DESC
                    LIMIT $2
                    "#,
                )
                .bind(org_uuid)
                .bind(limit)
                .fetch_all(tx.as_mut())
                .await?;

                rows.into_iter()
                    .map(|row| {
                        Ok(PolicyAuditEventSummary {
                            id: row.try_get("id")?,
                            actor: row
                                .try_get::<Option<uuid::Uuid>, _>("actor")?
                                .map(UserId::from_uuid),
                            action: row.try_get("action")?,
                            target_type: row.try_get("target_type")?,
                            target_id: row.try_get("target_id")?,
                            before_snapshot: row.try_get("before_snap")?,
                            after_snapshot: row.try_get("after_snap")?,
                            trace_id: row.try_get("trace_id")?,
                            span_id: row.try_get("span_id")?,
                            occurred_at: row.try_get("occurred_at")?,
                        })
                    })
                    .collect::<Result<Vec<_>, sqlx::Error>>()
                    .map_err(PgOrgError::from)
            })
        })
        .await
    }

    /// Create a tenant-owned custom role definition and bump the tenant policy
    /// version in the same audited transaction. G016-P0 definitions do not yet
    /// become effective login grants; they are durable policy catalog rows.
    pub async fn create_policy_role(
        &self,
        command: CreatePolicyRoleCommand,
    ) -> Result<PolicyRoleSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let role_id = uuid::Uuid::new_v4();
        let role_key = command.role_key;
        let display_name = command.display_name;
        let description = command.description;
        let permissions = command.permissions;
        let conditions = command.conditions;
        let occurred_at = command.occurred_at;
        let actor = command.actor;

        let event = policy_role_audit_event(
            "policy.role.create",
            Some(actor),
            role_id,
            command.trace,
            occurred_at,
        )?
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "role_key": &role_key,
                "display_name": &display_name,
                "description": &description,
                "status": "DRAFT",
                "permissions": &permissions,
                "conditions": &conditions,
            })),
        );

        with_audit::<_, PolicyRoleSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO policy_roles (
                        id, org_id, role_key, display_name, description, status,
                        is_system, created_by, updated_by, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, 'DRAFT', false, $6, $6, $7, $7)
                    "#,
                )
                .bind(role_id)
                .bind(org_uuid)
                .bind(&role_key)
                .bind(&display_name)
                .bind(description.as_deref())
                .bind(*actor.as_uuid())
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;

                for permission in &permissions {
                    sqlx::query(
                        r#"
                        INSERT INTO policy_role_permissions (
                            org_id, role_id, feature_key, permission_level
                        ) VALUES ($1, $2, $3, $4)
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(role_id)
                    .bind(&permission.feature_key)
                    .bind(&permission.permission_level)
                    .execute(tx.as_mut())
                    .await?;
                }

                for condition in &conditions {
                    sqlx::query(
                        r#"
                        INSERT INTO policy_role_conditions (
                            org_id, role_id, condition_key, attribute, operator, condition_values
                        ) VALUES ($1, $2, $3, $4, $5, $6)
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(role_id)
                    .bind(&condition.condition_key)
                    .bind(&condition.attribute)
                    .bind(&condition.operator)
                    .bind(&condition.values)
                    .execute(tx.as_mut())
                    .await?;
                }

                bump_policy_version_tx(tx, org_uuid, occurred_at).await?;
                fetch_policy_role_tx(tx, role_id).await
            })
        })
        .await
    }

    /// Update a tenant-owned custom role definition. Runtime authorization is
    /// still unchanged in G016; this edits versioned policy-definition data and
    /// records before/after audit evidence.
    pub async fn update_policy_role(
        &self,
        command: UpdatePolicyRoleCommand,
    ) -> Result<PolicyRoleSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let role_id = command.role_id;
        let display_name = command.display_name;
        let description = command.description;
        let permissions = command.permissions;
        let conditions = command.conditions;
        let actor = command.actor;
        let occurred_at = command.occurred_at;

        let event = policy_role_audit_event(
            "policy.role.update",
            Some(actor),
            role_id,
            command.trace,
            occurred_at,
        )?
        .with_org(org);

        with_audit::<_, PolicyRoleSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    SELECT is_system
                    FROM policy_roles
                    WHERE id = $1
                    FOR UPDATE
                    "#,
                )
                .bind(role_id)
                .fetch_optional(tx.as_mut())
                .await?;

                let Some(row) = row else {
                    return Err(PgOrgError::Domain(KernelError::not_found(
                        "policy role not found",
                    )));
                };
                if row.try_get::<bool, _>("is_system")? {
                    return Err(PgOrgError::Domain(KernelError::validation(
                        "system policy roles cannot be changed",
                    )));
                }

                let previous = fetch_policy_role_tx(tx, role_id).await?;

                sqlx::query(
                    r#"
                    UPDATE policy_roles
                    SET display_name = $2,
                        description = $3,
                        updated_by = $4,
                        updated_at = $5
                    WHERE id = $1 AND is_system = false
                    "#,
                )
                .bind(role_id)
                .bind(&display_name)
                .bind(description.as_deref())
                .bind(*actor.as_uuid())
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;

                sqlx::query(
                    r#"
                    DELETE FROM policy_role_permissions
                    WHERE org_id = $1 AND role_id = $2
                    "#,
                )
                .bind(org_uuid)
                .bind(role_id)
                .execute(tx.as_mut())
                .await?;
                for permission in &permissions {
                    sqlx::query(
                        r#"
                        INSERT INTO policy_role_permissions (
                            org_id, role_id, feature_key, permission_level
                        ) VALUES ($1, $2, $3, $4)
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(role_id)
                    .bind(&permission.feature_key)
                    .bind(&permission.permission_level)
                    .execute(tx.as_mut())
                    .await?;
                }

                sqlx::query(
                    r#"
                    DELETE FROM policy_role_conditions
                    WHERE org_id = $1 AND role_id = $2
                    "#,
                )
                .bind(org_uuid)
                .bind(role_id)
                .execute(tx.as_mut())
                .await?;
                for condition in &conditions {
                    sqlx::query(
                        r#"
                        INSERT INTO policy_role_conditions (
                            org_id, role_id, condition_key, attribute, operator, condition_values
                        ) VALUES ($1, $2, $3, $4, $5, $6)
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(role_id)
                    .bind(&condition.condition_key)
                    .bind(&condition.attribute)
                    .bind(&condition.operator)
                    .bind(&condition.values)
                    .execute(tx.as_mut())
                    .await?;
                }

                bump_policy_version_tx(tx, org_uuid, occurred_at).await?;
                let next = fetch_policy_role_tx(tx, role_id).await?;
                let snapshot_event = policy_role_audit_event(
                    "policy.role.update.snapshot",
                    Some(actor),
                    role_id,
                    TraceContext::generate(),
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({ "role": &previous })),
                    Some(serde_json::json!({ "role": &next })),
                );
                insert_audit_event(tx, &snapshot_event).await?;
                Ok(next)
            })
        })
        .await
    }

    /// Change a custom role lifecycle state. The REST layer owns the passkey
    /// step-up; this adapter owns the RLS-scoped mutation, audit snapshot, and
    /// policy-version bump.
    pub async fn update_policy_role_status(
        &self,
        command: UpdatePolicyRoleStatusCommand,
    ) -> Result<PolicyRoleSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let role_id = command.role_id;
        let status = command.status;
        let actor = command.actor;
        let occurred_at = command.occurred_at;

        let event = policy_role_audit_event(
            "policy.role.status_update",
            Some(actor),
            role_id,
            command.trace,
            occurred_at,
        )?
        .with_org(org);

        with_audit::<_, PolicyRoleSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    SELECT is_system
                    FROM policy_roles
                    WHERE id = $1
                    FOR UPDATE
                    "#,
                )
                .bind(role_id)
                .fetch_optional(tx.as_mut())
                .await?;

                let Some(row) = row else {
                    return Err(PgOrgError::Domain(KernelError::not_found(
                        "policy role not found",
                    )));
                };
                if row.try_get::<bool, _>("is_system")? {
                    return Err(PgOrgError::Domain(KernelError::validation(
                        "system policy roles cannot be changed",
                    )));
                }

                let previous = fetch_policy_role_tx(tx, role_id).await?;
                validate_policy_role_status_transition(&previous.status, &status)?;
                if previous.status != status {
                    sqlx::query(
                        r#"
                        UPDATE policy_roles
                        SET status = $2, updated_by = $3, updated_at = $4
                        WHERE id = $1 AND is_system = false
                        "#,
                    )
                    .bind(role_id)
                    .bind(&status)
                    .bind(*actor.as_uuid())
                    .bind(occurred_at)
                    .execute(tx.as_mut())
                    .await?;
                    bump_policy_version_tx(tx, org_uuid, occurred_at).await?;
                }

                let next = fetch_policy_role_tx(tx, role_id).await?;
                let snapshot_event = policy_role_audit_event(
                    "policy.role.status_update.snapshot",
                    Some(actor),
                    role_id,
                    TraceContext::generate(),
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({ "role": &previous })),
                    Some(serde_json::json!({ "role": &next })),
                );
                insert_audit_event(tx, &snapshot_event).await?;
                Ok(next)
            })
        })
        .await
    }

    /// List a user's custom-role assignments. ACTIVE assigned roles are
    /// resolved into runtime grants by mnt-platform-authz; DRAFT/RETIRED roles
    /// remain inert governance data.
    pub async fn list_policy_role_assignments(
        &self,
        user_id: UserId,
    ) -> Result<Vec<PolicyRoleAssignmentSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move { fetch_policy_role_assignments_tx(tx, user_id).await })
        })
        .await
    }

    /// Count assignments for one custom policy role. This is a read-only
    /// impact preview helper used to flag status changes that may alter
    /// runtime grants for already-assigned users.
    pub async fn count_policy_role_assignments(
        &self,
        role_id: uuid::Uuid,
    ) -> Result<i64, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    r#"
                    SELECT count(*)::bigint
                    FROM user_role_assignments
                    WHERE org_id = $1 AND role_id = $2
                    "#,
                )
                .bind(org_uuid)
                .bind(role_id)
                .fetch_one(tx.as_mut())
                .await?)
            })
        })
        .await
    }

    /// Persist a short-lived receipt for an assignment impact preview. The
    /// mutating assignment replacement consumes this receipt inside the write
    /// transaction so a client cannot skip preview by sending only a boolean.
    pub async fn create_policy_assignment_preview_receipt(
        &self,
        command: CreatePolicyAssignmentPreviewReceiptCommand,
    ) -> Result<PolicyAssignmentPreviewReceiptSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let actor = command.actor;
        let user_id = command.user_id;
        let current_branch_ids = normalize_policy_role_ids(command.current_branch_ids);
        let current_role_ids = normalize_policy_role_ids(command.current_role_ids);
        let role_ids = normalize_policy_role_ids(command.role_ids);
        let policy_version = command.policy_version;
        let expires_at = command.expires_at;
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let exists: Option<uuid::Uuid> =
                    sqlx::query_scalar("SELECT id FROM users WHERE id = $1 FOR UPDATE")
                        .bind(*user_id.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?;
                if exists.is_none() {
                    return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                }
                let locked_branch_ids = fetch_user_branch_uuid_ids_tx(tx, user_id).await?;
                if locked_branch_ids != current_branch_ids {
                    return Err(stale_policy_assignment_preview_error());
                }
                let locked_current_role_ids = normalize_policy_role_ids(
                    fetch_policy_role_assignments_tx(tx, user_id)
                        .await?
                        .into_iter()
                        .map(|assignment| assignment.role_id)
                        .collect(),
                );
                if locked_current_role_ids != current_role_ids {
                    return Err(stale_policy_assignment_preview_error());
                }
                let locked_policy_version = lock_policy_version_tx(tx, org_uuid).await?;
                if locked_policy_version != policy_version {
                    return Err(stale_policy_assignment_preview_error());
                }
                validate_custom_policy_roles_tx(tx, &role_ids).await?;
                let row: (uuid::Uuid, time::OffsetDateTime) = sqlx::query_as(
                    r#"
                    INSERT INTO policy_assignment_preview_receipts (
                        org_id, actor_id, user_id, current_branch_ids,
                        current_role_ids, role_ids, policy_version, expires_at
                    ) VALUES ($1, $2, $3, $4::uuid[], $5::uuid[], $6::uuid[], $7, $8)
                    RETURNING id, expires_at
                    "#,
                )
                .bind(org_uuid)
                .bind(*actor.as_uuid())
                .bind(*user_id.as_uuid())
                .bind(&current_branch_ids)
                .bind(&current_role_ids)
                .bind(&role_ids)
                .bind(policy_version)
                .bind(expires_at)
                .fetch_one(tx.as_mut())
                .await?;
                Ok(PolicyAssignmentPreviewReceiptSummary {
                    id: row.0,
                    expires_at: row.1,
                })
            })
        })
        .await
    }

    /// Replace a user's custom-role assignments atomically. This bumps
    /// policy_version for resolver/cache invalidation readiness while leaving
    /// `users.roles` system-role-only.
    pub async fn replace_policy_role_assignments(
        &self,
        command: ReplacePolicyRoleAssignmentsCommand,
    ) -> Result<Vec<PolicyRoleAssignmentSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let user_id = command.user_id;
        let actor = command.actor;
        let occurred_at = command.occurred_at;
        let preview_receipt_id = command.preview_receipt_id;
        let role_ids = normalize_policy_role_ids(command.role_ids);

        let event = policy_role_assignment_audit_event(
            "policy.role_assignment.replace",
            Some(actor),
            user_id,
            command.trace,
            occurred_at,
        )?
        .with_org(org);

        with_audit::<_, Vec<PolicyRoleAssignmentSummary>, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let exists: Option<uuid::Uuid> =
                    sqlx::query_scalar("SELECT id FROM users WHERE id = $1 FOR UPDATE")
                        .bind(*user_id.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?;
                if exists.is_none() {
                    return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                }

                let previous = fetch_policy_role_assignments_tx(tx, user_id).await?;
                let current_branch_ids = fetch_user_branch_uuid_ids_tx(tx, user_id).await?;
                let current_role_ids = normalize_policy_role_ids(
                    previous
                        .iter()
                        .map(|assignment| assignment.role_id)
                        .collect(),
                );
                let policy_version = lock_policy_version_tx(tx, org_uuid).await?;
                validate_custom_policy_roles_tx(tx, &role_ids).await?;
                consume_policy_assignment_preview_receipt_tx(
                    tx,
                    AssignmentPreviewReceiptConsumption {
                        actor,
                        user_id,
                        current_branch_ids: &current_branch_ids,
                        current_role_ids: &current_role_ids,
                        role_ids: &role_ids,
                        policy_version,
                        receipt_id: preview_receipt_id,
                        occurred_at,
                        org_uuid,
                    },
                )
                .await?;

                sqlx::query("DELETE FROM user_role_assignments WHERE user_id = $1")
                    .bind(*user_id.as_uuid())
                    .execute(tx.as_mut())
                    .await?;

                for role_id in &role_ids {
                    sqlx::query(
                        r#"
                        INSERT INTO user_role_assignments (
                            org_id, user_id, role_id, assigned_by, created_at
                        ) VALUES ($1, $2, $3, $4, $5)
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(*user_id.as_uuid())
                    .bind(role_id)
                    .bind(*actor.as_uuid())
                    .bind(occurred_at)
                    .execute(tx.as_mut())
                    .await?;
                }

                bump_policy_version_tx(tx, org_uuid, occurred_at).await?;
                // Custom-role assignments are authorization-relevant subject
                // material, so bump this subject's freshness version alongside the
                // per-org policy version.
                bump_subject_version_tx(tx, org_uuid, *user_id.as_uuid(), occurred_at).await?;
                let next = fetch_policy_role_assignments_tx(tx, user_id).await?;

                let snapshot_event = policy_role_assignment_audit_event(
                    "policy.role_assignment.replace.snapshot",
                    Some(actor),
                    user_id,
                    TraceContext::generate(),
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({ "assignments": &previous })),
                    Some(serde_json::json!({ "assignments": &next })),
                );
                insert_audit_event(tx, &snapshot_event).await?;

                Ok(next)
            })
        })
        .await
    }

    // -----------------------------------------------------------------------
    // Regions
    // -----------------------------------------------------------------------

    pub async fn create_region(
        &self,
        command: CreateRegionCommand,
    ) -> Result<RegionSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let name = validate_org_name(&command.name)?;
        let region_id = RegionId::new();
        let event = region_audit_event(
            "region.create",
            Some(command.actor),
            region_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_snapshots(None, Some(serde_json::json!({ "name": name })))
        .with_org(org);

        with_audit::<_, RegionSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO regions (id, name, created_at, org_id) VALUES ($1, $2, $3, $4)",
                )
                .bind(*region_id.as_uuid())
                .bind(&name)
                .bind(command.occurred_at)
                .bind(org_uuid)
                .execute(tx.as_mut())
                .await?;
                fetch_region_tx(tx, region_id).await
            })
        })
        .await
    }

    /// Rename a region. Mirrors `update_branch`: org-armed + audited, 404 on an
    /// unknown id, bounded-text validation via `validate_org_name`.
    pub async fn update_region(
        &self,
        command: UpdateRegionCommand,
    ) -> Result<RegionSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let name = command.name.as_deref().map(validate_org_name).transpose()?;
        let region_id = command.region_id;
        let event = region_audit_event(
            "region.update",
            Some(command.actor),
            region_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_snapshots(
            None,
            name.as_ref()
                .map(|name| serde_json::json!({ "name": name })),
        )
        .with_org(org);

        with_audit::<_, RegionSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                // Lock the row and confirm it exists (and is not already gone) in
                // the same tenant-armed tx before mutating.
                let exists: Option<uuid::Uuid> =
                    sqlx::query_scalar("SELECT id FROM regions WHERE id = $1 FOR UPDATE")
                        .bind(*region_id.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?;
                if exists.is_none() {
                    return Err(PgOrgError::Domain(KernelError::not_found(
                        "region not found",
                    )));
                }
                if let Some(name) = &name {
                    sqlx::query("UPDATE regions SET name = $2 WHERE id = $1")
                        .bind(*region_id.as_uuid())
                        .bind(name)
                        .execute(tx.as_mut())
                        .await?;
                }
                fetch_region_tx(tx, region_id).await
            })
        })
        .await
    }

    /// Soft-delete (deactivate) a region. Refuses with a `Conflict` while the
    /// region still owns ACTIVE branches — deactivating it would strand them and
    /// the pickers, so the operator must deactivate/move the branches first. The
    /// count, the guard, the UPDATE and the audit row all run in ONE tenant-armed
    /// transaction so the check can never race a concurrent branch insert.
    pub async fn deactivate_region(
        &self,
        command: DeactivateRegionCommand,
    ) -> Result<RegionSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let region_id = command.region_id;
        let occurred_at = command.occurred_at;
        let event = region_audit_event(
            "region.deactivate",
            Some(command.actor),
            region_id,
            command.trace.clone(),
            occurred_at,
        )?
        .with_snapshots(
            Some(serde_json::json!({ "deactivated_at": null })),
            Some(serde_json::json!({ "deactivated_at": occurred_at })),
        )
        .with_org(org);

        with_audit::<_, RegionSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row: Option<(uuid::Uuid, Option<time::OffsetDateTime>)> = sqlx::query_as(
                    "SELECT id, deactivated_at FROM regions WHERE id = $1 FOR UPDATE",
                )
                .bind(*region_id.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?;
                let Some((_, deactivated_at)) = row else {
                    return Err(PgOrgError::Domain(KernelError::not_found(
                        "region not found",
                    )));
                };
                if deactivated_at.is_some() {
                    return Err(PgOrgError::Domain(KernelError::conflict(
                        "이미 비활성화된 지역입니다.",
                    )));
                }

                // Referential guard: refuse while ACTIVE branches remain.
                let active_branches: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM branches WHERE region_id = $1 AND deactivated_at IS NULL",
                )
                .bind(*region_id.as_uuid())
                .fetch_one(tx.as_mut())
                .await?;
                if active_branches > 0 {
                    return Err(PgOrgError::Domain(KernelError::conflict(
                        "활성 지점이 남아 있어 지역을 삭제할 수 없습니다. 먼저 지점을 비활성화하거나 이동하세요.",
                    )));
                }

                sqlx::query("UPDATE regions SET deactivated_at = $2 WHERE id = $1")
                    .bind(*region_id.as_uuid())
                    .bind(occurred_at)
                    .execute(tx.as_mut())
                    .await?;
                fetch_region_tx(tx, region_id).await
            })
        })
        .await
    }

    /// List ACTIVE regions (deactivated rows are hidden from the org tree and the
    /// pickers). Ordered by name for a stable console listing.
    pub async fn list_regions(&self) -> Result<Vec<RegionSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(
                    "SELECT id, name, deactivated_at, created_at FROM regions \
                     WHERE deactivated_at IS NULL ORDER BY name",
                )
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;
        rows.iter().map(region_from_row).collect()
    }

    // -----------------------------------------------------------------------
    // Branches
    // -----------------------------------------------------------------------

    pub async fn create_branch(
        &self,
        command: CreateBranchCommand,
    ) -> Result<BranchSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let name = validate_org_name(&command.name)?;
        let branch_id = BranchId::new();
        let region_id = command.region_id;
        let event = branch_audit_event(
            "branch.create",
            Some(command.actor),
            branch_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "region_id": region_id.to_string(),
                "name": name,
            })),
        )
        .with_org(org);

        with_audit::<_, BranchSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO branches (id, region_id, name, created_at, org_id) VALUES ($1, $2, $3, $4, $5)",
                )
                .bind(*branch_id.as_uuid())
                .bind(*region_id.as_uuid())
                .bind(&name)
                .bind(command.occurred_at)
                .bind(org_uuid)
                .execute(tx.as_mut())
                .await?;
                fetch_branch_tx(tx, branch_id).await
            })
        })
        .await
    }

    pub async fn update_branch(
        &self,
        command: UpdateBranchCommand,
    ) -> Result<BranchSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let name = command.name.as_deref().map(validate_org_name).transpose()?;
        let region_id = command.region_id;
        let branch_id = command.branch_id;
        // Org-bind the audit row so it is tenant-attributable and the FORCE-RLS
        // `audit_events` write is armed via the same `with_audit` GUC.
        let event = branch_audit_event(
            "branch.update",
            Some(command.actor),
            branch_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, BranchSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let exists: Option<uuid::Uuid> =
                    sqlx::query_scalar("SELECT id FROM branches WHERE id = $1 FOR UPDATE")
                        .bind(*branch_id.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?;
                if exists.is_none() {
                    return Err(PgOrgError::Domain(KernelError::not_found(
                        "branch not found",
                    )));
                }
                if let Some(region_id) = region_id {
                    sqlx::query("UPDATE branches SET region_id = $2 WHERE id = $1")
                        .bind(*branch_id.as_uuid())
                        .bind(*region_id.as_uuid())
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(name) = &name {
                    sqlx::query("UPDATE branches SET name = $2 WHERE id = $1")
                        .bind(*branch_id.as_uuid())
                        .bind(name)
                        .execute(tx.as_mut())
                        .await?;
                }
                fetch_branch_tx(tx, branch_id).await
            })
        })
        .await
    }

    /// Soft-delete (deactivate) a branch. Refuses with a `Conflict` while the
    /// branch still has ACTIVE users (via `user_branches` → `users.is_active`) or
    /// NON-TERMINAL equipment (status not in the disposed set '폐기'/'매각') —
    /// deactivating it would strand live operational data. The guards, the UPDATE
    /// and the audit row run in ONE tenant-armed transaction.
    pub async fn deactivate_branch(
        &self,
        command: DeactivateBranchCommand,
    ) -> Result<BranchSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let branch_id = command.branch_id;
        let occurred_at = command.occurred_at;
        let event = branch_audit_event(
            "branch.deactivate",
            Some(command.actor),
            branch_id,
            command.trace.clone(),
            occurred_at,
        )?
        .with_snapshots(
            Some(serde_json::json!({ "deactivated_at": null })),
            Some(serde_json::json!({ "deactivated_at": occurred_at })),
        )
        .with_org(org);

        with_audit::<_, BranchSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row: Option<(uuid::Uuid, Option<time::OffsetDateTime>)> = sqlx::query_as(
                    "SELECT id, deactivated_at FROM branches WHERE id = $1 FOR UPDATE",
                )
                .bind(*branch_id.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?;
                let Some((_, deactivated_at)) = row else {
                    return Err(PgOrgError::Domain(KernelError::not_found(
                        "branch not found",
                    )));
                };
                if deactivated_at.is_some() {
                    return Err(PgOrgError::Domain(KernelError::conflict(
                        "이미 비활성화된 지점입니다.",
                    )));
                }

                // Referential guard 1: ACTIVE users assigned to this branch.
                let active_users: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM user_branches ub \
                     JOIN users u ON u.id = ub.user_id \
                     WHERE ub.branch_id = $1 AND u.is_active = true",
                )
                .bind(*branch_id.as_uuid())
                .fetch_one(tx.as_mut())
                .await?;
                if active_users > 0 {
                    return Err(PgOrgError::Domain(KernelError::conflict(
                        "이 지점에 배정된 활성 사용자가 있어 삭제할 수 없습니다. 먼저 사용자를 재배정하거나 비활성화하세요.",
                    )));
                }

                // Referential guard 2: NON-TERMINAL equipment in this branch
                // ('폐기' 폐기/scrapped and '매각' 매각/sold are terminal states).
                let active_equipment: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM registry_equipment \
                     WHERE branch_id = $1 AND status NOT IN ('폐기', '매각')",
                )
                .bind(*branch_id.as_uuid())
                .fetch_one(tx.as_mut())
                .await?;
                if active_equipment > 0 {
                    return Err(PgOrgError::Domain(KernelError::conflict(
                        "이 지점에 등록된 장비가 있어 삭제할 수 없습니다. 먼저 장비를 다른 지점으로 이동하거나 폐기·매각 처리하세요.",
                    )));
                }

                sqlx::query("UPDATE branches SET deactivated_at = $2 WHERE id = $1")
                    .bind(*branch_id.as_uuid())
                    .bind(occurred_at)
                    .execute(tx.as_mut())
                    .await?;
                fetch_branch_tx(tx, branch_id).await
            })
        })
        .await
    }

    /// List ACTIVE branches (deactivated rows are hidden). Used both for org setup
    /// and support-ticket triage.
    pub async fn list_branches(&self) -> Result<Vec<BranchSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(
                    "SELECT id, region_id, name, deactivated_at, created_at FROM branches \
                     WHERE deactivated_at IS NULL ORDER BY name",
                )
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;
        rows.iter().map(branch_from_row).collect()
    }
}

// ---------------------------------------------------------------------------
// Branch-membership helper (replace-set semantics inside a transaction)
// ---------------------------------------------------------------------------

async fn replace_user_branches(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    branch_ids: &[uuid::Uuid],
    org_uuid: uuid::Uuid,
) -> Result<(), PgOrgError> {
    sqlx::query("DELETE FROM user_branches WHERE user_id = $1")
        .bind(*user_id.as_uuid())
        .execute(tx.as_mut())
        .await?;
    for branch_id in branch_ids {
        sqlx::query(
            "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3) \
             ON CONFLICT (user_id, branch_id) DO NOTHING",
        )
        .bind(*user_id.as_uuid())
        .bind(branch_id)
        .bind(org_uuid)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Scope check + row fetchers
// ---------------------------------------------------------------------------

async fn user_in_scope(
    pool: &PgPool,
    user_id: UserId,
    scope: &BranchScope,
) -> Result<bool, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    match scope {
        BranchScope::All => {
            let exists: Option<uuid::Uuid> =
                with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
                    Box::pin(async move {
                        Ok(sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
                            .bind(*user_id.as_uuid())
                            .fetch_optional(tx.as_mut())
                            .await?)
                    })
                })
                .await?;
            Ok(exists.is_some())
        }
        BranchScope::Branches(branches) if branches.is_empty() => Ok(false),
        BranchScope::Branches(branches) => {
            let branch_ids: Vec<uuid::Uuid> = branches.iter().map(|b| *b.as_uuid()).collect();
            let found: Option<uuid::Uuid> =
                with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
                    Box::pin(async move {
                        Ok(sqlx::query_scalar(
                            "SELECT user_id FROM user_branches WHERE user_id = $1 AND branch_id = ANY($2) LIMIT 1",
                        )
                        .bind(*user_id.as_uuid())
                        .bind(&branch_ids)
                        .fetch_optional(tx.as_mut())
                        .await?)
                    })
                })
                .await?;
            Ok(found.is_some())
        }
    }
}

/// The `users` projection shared by every fetch path. The `has_passkey` flag is
/// computed inline via an EXISTS over the FORCE-RLS `auth_webauthn_credentials`
/// table; both call sites run inside an org-armed scope (`with_org_conn` or the
/// audited tx), so the subquery only ever sees THIS tenant's credentials and the
/// account-setup state (활성 vs 설정 대기) is derived correctly.
const USER_SELECT_WITH_PASSKEY: &str = r#"
    SELECT
           u.id,
           u.display_name,
           u.employee_id,
           e.name AS employee_name,
           e.employee_number AS employee_number,
           e.company AS employee_company,
           e.org_unit AS employee_org_unit,
           e.position AS employee_position,
           e.identity_review_required AS employee_identity_review_required,
           e.identity_resolution_confidence AS employee_identity_resolution_confidence,
           u.phone,
           u.roles,
           u.team,
           u.is_active,
           u.created_at,
           EXISTS (
               SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id = u.id
           ) AS has_passkey
    FROM users u
    LEFT JOIN employees e
      ON e.id = u.employee_id
     AND e.org_id = u.org_id
    WHERE u.id = $1
"#;

async fn fetch_policy_role(
    pool: &PgPool,
    role_id: uuid::Uuid,
) -> Result<PolicyRoleSummary, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
                SELECT id, role_key, display_name, description, status, is_system, created_at, updated_at
                FROM policy_roles
                WHERE id = $1
                "#,
            )
            .bind(role_id)
            .fetch_one(tx.as_mut())
            .await?)
        })
    })
    .await?;
    let permissions = fetch_policy_role_permissions(pool, role_id).await?;
    let conditions = fetch_policy_role_conditions(pool, role_id).await?;
    policy_role_from_row(&row, permissions, conditions)
}

async fn fetch_policy_role_tx(
    tx: &mut Transaction<'_, Postgres>,
    role_id: uuid::Uuid,
) -> Result<PolicyRoleSummary, PgOrgError> {
    let row = sqlx::query(
        r#"
        SELECT id, role_key, display_name, description, status, is_system, created_at, updated_at
        FROM policy_roles
        WHERE id = $1
        "#,
    )
    .bind(role_id)
    .fetch_one(tx.as_mut())
    .await?;
    let permissions = fetch_policy_role_permissions_tx(tx, role_id).await?;
    let conditions = fetch_policy_role_conditions_tx(tx, role_id).await?;
    policy_role_from_row(&row, permissions, conditions)
}

async fn fetch_policy_role_permissions(
    pool: &PgPool,
    role_id: uuid::Uuid,
) -> Result<Vec<PolicyRolePermission>, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move { fetch_policy_role_permissions_tx(tx, role_id).await })
    })
    .await
}

async fn fetch_policy_role_permissions_tx(
    tx: &mut Transaction<'_, Postgres>,
    role_id: uuid::Uuid,
) -> Result<Vec<PolicyRolePermission>, PgOrgError> {
    let rows = sqlx::query(
        r#"
        SELECT feature_key, permission_level
        FROM policy_role_permissions
        WHERE role_id = $1
        ORDER BY feature_key
        "#,
    )
    .bind(role_id)
    .fetch_all(tx.as_mut())
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(PolicyRolePermission {
                feature_key: row.try_get("feature_key")?,
                permission_level: row.try_get("permission_level")?,
            })
        })
        .collect()
}

async fn fetch_policy_role_conditions(
    pool: &PgPool,
    role_id: uuid::Uuid,
) -> Result<Vec<PolicyRoleCondition>, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move { fetch_policy_role_conditions_tx(tx, role_id).await })
    })
    .await
}

async fn fetch_policy_role_conditions_tx(
    tx: &mut Transaction<'_, Postgres>,
    role_id: uuid::Uuid,
) -> Result<Vec<PolicyRoleCondition>, PgOrgError> {
    let rows = sqlx::query(
        r#"
        SELECT condition_key, attribute, operator, condition_values
        FROM policy_role_conditions
        WHERE role_id = $1
        ORDER BY condition_key
        "#,
    )
    .bind(role_id)
    .fetch_all(tx.as_mut())
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(PolicyRoleCondition {
                condition_key: row.try_get("condition_key")?,
                attribute: row.try_get("attribute")?,
                operator: row.try_get("operator")?,
                values: row.try_get("condition_values")?,
            })
        })
        .collect()
}

async fn bump_policy_version_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    occurred_at: time::OffsetDateTime,
) -> Result<(), PgOrgError> {
    sqlx::query(
        r#"
        INSERT INTO policy_versions (org_id, version, updated_at)
        VALUES ($1, 1, $2)
        ON CONFLICT (org_id) DO UPDATE
        SET version = policy_versions.version + 1,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(org_uuid)
    .bind(occurred_at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Bump a subject's authorization `version` (+1) inside the caller's audited,
/// org-armed transaction. Called from authorization-relevant subject mutations
/// (system-role and custom-role assignment writes) so a later Cedar slice can
/// detect a token minted before the change and deny the stale subject. The first
/// bump upserts the (org,user) row at version 1; every later bump increments it.
///
/// SLICE-2: this only SOURCES freshness. No authorization decision consults it
/// yet, so bumping here changes no live outcome.
async fn bump_subject_version_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    user_uuid: uuid::Uuid,
    occurred_at: time::OffsetDateTime,
) -> Result<(), PgOrgError> {
    sqlx::query(
        r#"
        INSERT INTO subject_authz_versions (org_id, user_id, version, session_generation, updated_at)
        VALUES ($1, $2, 1, 1, $3)
        ON CONFLICT (org_id, user_id) DO UPDATE
        SET version = subject_authz_versions.version + 1,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(org_uuid)
    .bind(user_uuid)
    .bind(occurred_at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Bump a subject's `session_generation` (+1) inside the caller's audited,
/// org-armed transaction. Called from credential/session events that must
/// invalidate previously minted sessions (e.g. offboarding credential + session
/// revocation). Mirrors [`bump_subject_version_tx`]; the first bump upserts the
/// row at session_generation 1.
async fn bump_subject_session_generation_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    user_uuid: uuid::Uuid,
    occurred_at: time::OffsetDateTime,
) -> Result<(), PgOrgError> {
    sqlx::query(
        r#"
        INSERT INTO subject_authz_versions (org_id, user_id, version, session_generation, updated_at)
        VALUES ($1, $2, 1, 1, $3)
        ON CONFLICT (org_id, user_id) DO UPDATE
        SET session_generation = subject_authz_versions.session_generation + 1,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(org_uuid)
    .bind(user_uuid)
    .bind(occurred_at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Read a subject's current `(version, session_generation)` under RLS. An absent
/// row means "no bump yet" and reads as `(0, 0)`, matching the mint-time default
/// (`get_policy_version`'s version-0 convention) so a token predating any bump
/// carries the safe baseline.
async fn fetch_subject_authz_versions_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_uuid: uuid::Uuid,
) -> Result<(i64, i64), PgOrgError> {
    let row = sqlx::query(
        r#"
        SELECT version, session_generation
        FROM subject_authz_versions
        WHERE user_id = $1
        "#,
    )
    .bind(user_uuid)
    .fetch_optional(tx.as_mut())
    .await?;
    match row {
        Some(row) => Ok((row.try_get("version")?, row.try_get("session_generation")?)),
        None => Ok((0, 0)),
    }
}

async fn lock_policy_version_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
) -> Result<i64, PgOrgError> {
    let version = sqlx::query_scalar(
        r#"
        SELECT version
        FROM policy_versions
        WHERE org_id = $1
        FOR UPDATE
        "#,
    )
    .bind(org_uuid)
    .fetch_optional(tx.as_mut())
    .await?
    .unwrap_or(0);
    Ok(version)
}

async fn validate_custom_policy_roles_tx(
    tx: &mut Transaction<'_, Postgres>,
    role_ids: &[uuid::Uuid],
) -> Result<(), PgOrgError> {
    if role_ids.is_empty() {
        return Ok(());
    }
    let rows: Vec<uuid::Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM policy_roles
        WHERE id = ANY($1) AND is_system = false AND status <> 'RETIRED'
        "#,
    )
    .bind(role_ids.to_vec())
    .fetch_all(tx.as_mut())
    .await?;
    if rows.len() != role_ids.len() {
        return Err(PgOrgError::Domain(KernelError::validation(
            "assignment references an unknown or retired custom role",
        )));
    }
    Ok(())
}

fn normalize_policy_role_ids(role_ids: Vec<uuid::Uuid>) -> Vec<uuid::Uuid> {
    role_ids
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn stale_policy_assignment_preview_error() -> PgOrgError {
    PgOrgError::Domain(KernelError::validation(
        "assignment preview receipt is missing, expired, consumed, or no longer matches",
    ))
}

struct AssignmentPreviewReceiptConsumption<'a> {
    actor: UserId,
    user_id: UserId,
    current_branch_ids: &'a [uuid::Uuid],
    current_role_ids: &'a [uuid::Uuid],
    role_ids: &'a [uuid::Uuid],
    policy_version: i64,
    receipt_id: uuid::Uuid,
    occurred_at: time::OffsetDateTime,
    org_uuid: uuid::Uuid,
}

async fn consume_policy_assignment_preview_receipt_tx(
    tx: &mut Transaction<'_, Postgres>,
    expected: AssignmentPreviewReceiptConsumption<'_>,
) -> Result<(), PgOrgError> {
    let consumed: Option<uuid::Uuid> = sqlx::query_scalar(
        r#"
        UPDATE policy_assignment_preview_receipts
        SET consumed_at = $6
        WHERE id = $1
          AND org_id = $2
          AND actor_id = $3
          AND user_id = $4
          AND consumed_at IS NULL
          AND expires_at > $5
          AND role_ids = $7::uuid[]
          AND current_role_ids = $8::uuid[]
          AND current_branch_ids = $9::uuid[]
          AND policy_version = $10
        RETURNING id
        "#,
    )
    .bind(expected.receipt_id)
    .bind(expected.org_uuid)
    .bind(*expected.actor.as_uuid())
    .bind(*expected.user_id.as_uuid())
    .bind(expected.occurred_at)
    .bind(expected.occurred_at)
    .bind(expected.role_ids)
    .bind(expected.current_role_ids)
    .bind(expected.current_branch_ids)
    .bind(expected.policy_version)
    .fetch_optional(tx.as_mut())
    .await?;
    if consumed.is_none() {
        return Err(stale_policy_assignment_preview_error());
    }
    Ok(())
}

async fn fetch_policy_role_assignments_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<Vec<PolicyRoleAssignmentSummary>, PgOrgError> {
    let rows = sqlx::query(
        r#"
        SELECT
            ura.user_id,
            ura.role_id,
            pr.role_key,
            pr.display_name,
            pr.status,
            ura.assigned_by,
            ura.created_at
        FROM user_role_assignments ura
        JOIN policy_roles pr
          ON pr.id = ura.role_id
         AND pr.org_id = ura.org_id
        WHERE ura.user_id = $1
        ORDER BY pr.role_key
        "#,
    )
    .bind(*user_id.as_uuid())
    .fetch_all(tx.as_mut())
    .await?;
    rows.into_iter()
        .map(|row| {
            let assigned_by: Option<uuid::Uuid> = row.try_get("assigned_by")?;
            Ok(PolicyRoleAssignmentSummary {
                user_id: UserId::from_uuid(row.try_get("user_id")?),
                role_id: row.try_get("role_id")?,
                role_key: row.try_get("role_key")?,
                display_name: row.try_get("display_name")?,
                status: row.try_get("status")?,
                assigned_by: assigned_by.map(UserId::from_uuid),
                created_at: row.try_get("created_at")?,
            })
        })
        .collect()
}

fn policy_role_from_row(
    row: &sqlx::postgres::PgRow,
    permissions: Vec<PolicyRolePermission>,
    conditions: Vec<PolicyRoleCondition>,
) -> Result<PolicyRoleSummary, PgOrgError> {
    Ok(PolicyRoleSummary {
        id: row.try_get("id")?,
        role_key: row.try_get("role_key")?,
        display_name: row.try_get("display_name")?,
        description: row.try_get("description")?,
        status: row.try_get("status")?,
        is_system: row.try_get("is_system")?,
        permissions,
        conditions,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn validate_policy_role_status_transition(
    current_status: &str,
    requested_status: &str,
) -> Result<(), PgOrgError> {
    if current_status == requested_status {
        return Ok(());
    }
    match (current_status, requested_status) {
        ("DRAFT", "ACTIVE") | ("ACTIVE", "DRAFT") | ("ACTIVE", "RETIRED") => Ok(()),
        _ => Err(PgOrgError::Domain(KernelError::validation(
            "policy role status transition is not allowed",
        ))),
    }
}

async fn fetch_user(pool: &PgPool, user_id: UserId) -> Result<UserSummary, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(USER_SELECT_WITH_PASSKEY)
                .bind(*user_id.as_uuid())
                .fetch_one(tx.as_mut())
                .await?)
        })
    })
    .await?;
    let branch_ids = fetch_user_branch_ids(pool, user_id).await?;
    user_from_row(&row, branch_ids)
}

async fn fetch_user_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<UserSummary, PgOrgError> {
    let row = sqlx::query(USER_SELECT_WITH_PASSKEY)
        .bind(*user_id.as_uuid())
        .fetch_one(tx.as_mut())
        .await?;
    let branch_rows: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT branch_id FROM user_branches WHERE user_id = $1 ORDER BY branch_id",
    )
    .bind(*user_id.as_uuid())
    .fetch_all(tx.as_mut())
    .await?;
    let branch_ids = branch_rows.into_iter().map(BranchId::from_uuid).collect();
    user_from_row(&row, branch_ids)
}

async fn fetch_user_branch_uuid_ids_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<Vec<uuid::Uuid>, PgOrgError> {
    let branch_ids: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT branch_id FROM user_branches WHERE user_id = $1 ORDER BY branch_id",
    )
    .bind(*user_id.as_uuid())
    .fetch_all(tx.as_mut())
    .await?;
    Ok(normalize_policy_role_ids(branch_ids))
}

async fn fetch_user_branch_ids(
    pool: &PgPool,
    user_id: UserId,
) -> Result<Vec<BranchId>, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    let rows: Vec<uuid::Uuid> = with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query_scalar(
                "SELECT branch_id FROM user_branches WHERE user_id = $1 ORDER BY branch_id",
            )
            .bind(*user_id.as_uuid())
            .fetch_all(tx.as_mut())
            .await?)
        })
    })
    .await?;
    Ok(rows.into_iter().map(BranchId::from_uuid).collect())
}

fn user_from_row(
    row: &sqlx::postgres::PgRow,
    branch_ids: Vec<BranchId>,
) -> Result<UserSummary, PgOrgError> {
    let team: Option<String> = row.try_get("team")?;
    let team = team.as_deref().map(Team::from_db_str).transpose()?;
    let is_active: bool = row.try_get("is_active")?;
    let has_passkey: bool = row.try_get("has_passkey")?;
    let employee_id: Option<uuid::Uuid> = row.try_get("employee_id")?;
    Ok(UserSummary {
        id: UserId::from_uuid(row.try_get("id")?),
        display_name: row.try_get("display_name")?,
        employee_id,
        employee_name: row.try_get("employee_name")?,
        employee_number: row.try_get("employee_number")?,
        employee_company: row.try_get("employee_company")?,
        employee_org_unit: row.try_get("employee_org_unit")?,
        employee_position: row.try_get("employee_position")?,
        employee_identity_review_required: row.try_get("employee_identity_review_required")?,
        employee_identity_resolution_confidence: row
            .try_get("employee_identity_resolution_confidence")?,
        employee_link_status: if employee_id.is_some() {
            EmployeeLinkStatus::Linked
        } else {
            EmployeeLinkStatus::Unlinked
        },
        phone: row.try_get("phone")?,
        team,
        roles: row.try_get("roles")?,
        branch_ids,
        is_active,
        has_passkey,
        account_status: account_status_for(is_active, has_passkey),
        created_at: row.try_get("created_at")?,
    })
}

async fn fetch_region_tx(
    tx: &mut Transaction<'_, Postgres>,
    region_id: RegionId,
) -> Result<RegionSummary, PgOrgError> {
    let row = sqlx::query("SELECT id, name, deactivated_at, created_at FROM regions WHERE id = $1")
        .bind(*region_id.as_uuid())
        .fetch_one(tx.as_mut())
        .await?;
    region_from_row(&row)
}

fn region_from_row(row: &sqlx::postgres::PgRow) -> Result<RegionSummary, PgOrgError> {
    Ok(RegionSummary {
        id: RegionId::from_uuid(row.try_get("id")?),
        name: row.try_get("name")?,
        deactivated_at: row.try_get("deactivated_at")?,
        created_at: row.try_get("created_at")?,
    })
}

async fn fetch_branch_tx(
    tx: &mut Transaction<'_, Postgres>,
    branch_id: BranchId,
) -> Result<BranchSummary, PgOrgError> {
    let row = sqlx::query(
        "SELECT id, region_id, name, deactivated_at, created_at FROM branches WHERE id = $1",
    )
    .bind(*branch_id.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;
    branch_from_row(&row)
}

fn branch_from_row(row: &sqlx::postgres::PgRow) -> Result<BranchSummary, PgOrgError> {
    Ok(BranchSummary {
        id: BranchId::from_uuid(row.try_get("id")?),
        region_id: RegionId::from_uuid(row.try_get("region_id")?),
        name: row.try_get("name")?,
        deactivated_at: row.try_get("deactivated_at")?,
        created_at: row.try_get("created_at")?,
    })
}
