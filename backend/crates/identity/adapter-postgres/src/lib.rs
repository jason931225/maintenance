//! Postgres adapter for the identity/org-setup domain.
//!
//! Every mutation routes through `with_audit`/`with_audits` so an `audit_events`
//! row lands in the SAME transaction as the state change (audit-coverage gate).
//! User reads are branch-scoped: `BranchScope::All` (SUPER_ADMIN/EXECUTIVE) sees
//! every user; a branch-scoped caller sees only users sharing an in-scope branch.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_identity_application::{
    BranchSummary, CreateBranchCommand, CreateRegionCommand, CreateUserCommand,
    DeactivateUserCommand, RegionSummary, UpdateBranchCommand, UpdateSelfProfileCommand,
    UpdateUserCommand, UserListQuery, UserSummary, branch_audit_event, region_audit_event,
    user_audit_event,
};
use mnt_identity_domain::{
    Team, normalize_optional_phone, validate_display_name, validate_org_name,
};
use mnt_kernel_core::{BranchId, BranchScope, ErrorKind, KernelError, RegionId, UserId};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
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
                    INSERT INTO users (id, display_name, phone, roles, team, is_active, created_at, org_id)
                    VALUES ($1, $2, $3, $4, $5, true, $6, $7)
                    "#,
                )
                .bind(*user_id.as_uuid())
                .bind(&display_name)
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

        let event = user_audit_event(
            "user.update_self",
            Some(user_id),
            user_id,
            command.trace.clone(),
            command.occurred_at,
        )?;

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

    /// Soft-deactivate a user.
    pub async fn deactivate_user(
        &self,
        command: DeactivateUserCommand,
    ) -> Result<UserSummary, PgOrgError> {
        let user_id = command.user_id;
        let event = user_audit_event(
            "user.deactivate",
            Some(command.actor),
            user_id,
            command.trace.clone(),
            command.occurred_at,
        )?
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

    /// List users visible within the caller's branch scope.
    pub async fn list_users(
        &self,
        scope: &BranchScope,
        query: UserListQuery,
    ) -> Result<Vec<UserSummary>, PgOrgError> {
        let limit = query
            .limit
            .unwrap_or(DEFAULT_USER_LIMIT)
            .clamp(1, MAX_USER_LIMIT);

        let mut builder = QueryBuilder::<Postgres>::new("SELECT id FROM users u WHERE ");
        match scope {
            BranchScope::All => {
                builder.push("TRUE");
            }
            BranchScope::Branches(branches) if branches.is_empty() => {
                builder.push("FALSE");
            }
            BranchScope::Branches(branches) => {
                let branch_ids: Vec<uuid::Uuid> = branches.iter().map(|b| *b.as_uuid()).collect();
                builder
                    .push(
                        "EXISTS (SELECT 1 FROM user_branches ub \
                         WHERE ub.user_id = u.id AND ub.branch_id = ANY(",
                    )
                    .push_bind(branch_ids)
                    .push("))");
            }
        }
        if !query.include_inactive {
            builder.push(" AND u.is_active = true");
        }
        builder
            .push(" ORDER BY u.created_at DESC, u.id DESC LIMIT ")
            .push_bind(limit);

        let org = current_org().map_err(KernelError::from)?;
        let ids: Vec<uuid::Uuid> = with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(builder
                    .build_query_scalar::<uuid::Uuid>()
                    .fetch_all(tx.as_mut())
                    .await?)
            })
        })
        .await?;

        let mut summaries = Vec::with_capacity(ids.len());
        for id in ids {
            summaries.push(fetch_user(&self.pool, UserId::from_uuid(id)).await?);
        }
        Ok(summaries)
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

    pub async fn list_regions(&self) -> Result<Vec<RegionSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(
                    sqlx::query("SELECT id, name, created_at FROM regions ORDER BY name")
                        .fetch_all(tx.as_mut())
                        .await?,
                )
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
        let name = command.name.as_deref().map(validate_org_name).transpose()?;
        let region_id = command.region_id;
        let branch_id = command.branch_id;
        let event = branch_audit_event(
            "branch.update",
            Some(command.actor),
            branch_id,
            command.trace.clone(),
            command.occurred_at,
        )?;

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

    /// List all branches. Used both for org setup and support-ticket triage.
    pub async fn list_branches(&self) -> Result<Vec<BranchSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(
                    "SELECT id, region_id, name, created_at FROM branches ORDER BY name",
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

async fn fetch_user(pool: &PgPool, user_id: UserId) -> Result<UserSummary, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
        SELECT id, display_name, phone, roles, team, is_active, created_at
        FROM users WHERE id = $1
        "#,
            )
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
    let row = sqlx::query(
        r#"
        SELECT id, display_name, phone, roles, team, is_active, created_at
        FROM users WHERE id = $1
        "#,
    )
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
    Ok(UserSummary {
        id: UserId::from_uuid(row.try_get("id")?),
        display_name: row.try_get("display_name")?,
        phone: row.try_get("phone")?,
        team,
        roles: row.try_get("roles")?,
        branch_ids,
        is_active: row.try_get("is_active")?,
        created_at: row.try_get("created_at")?,
    })
}

async fn fetch_region_tx(
    tx: &mut Transaction<'_, Postgres>,
    region_id: RegionId,
) -> Result<RegionSummary, PgOrgError> {
    let row = sqlx::query("SELECT id, name, created_at FROM regions WHERE id = $1")
        .bind(*region_id.as_uuid())
        .fetch_one(tx.as_mut())
        .await?;
    region_from_row(&row)
}

fn region_from_row(row: &sqlx::postgres::PgRow) -> Result<RegionSummary, PgOrgError> {
    Ok(RegionSummary {
        id: RegionId::from_uuid(row.try_get("id")?),
        name: row.try_get("name")?,
        created_at: row.try_get("created_at")?,
    })
}

async fn fetch_branch_tx(
    tx: &mut Transaction<'_, Postgres>,
    branch_id: BranchId,
) -> Result<BranchSummary, PgOrgError> {
    let row = sqlx::query("SELECT id, region_id, name, created_at FROM branches WHERE id = $1")
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
        created_at: row.try_get("created_at")?,
    })
}
