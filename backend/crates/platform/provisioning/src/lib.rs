//! Bulk roster provisioning and passkey cold-start.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::{BTreeMap, BTreeSet};

use mnt_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext, UserId};
use mnt_platform_auth::{
    PasskeyRegistrationCredential, PasskeyRegistrationStart, PasskeyService, RegistrationCeremony,
    StoredPasskey,
};
use mnt_platform_db::{insert_audit_event, with_audit};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

const VALID_ROLES: &[&str] = &[
    "SUPER_ADMIN",
    "ADMIN",
    "MECHANIC",
    "RECEPTIONIST",
    "EXECUTIVE",
];
const VALID_TEAMS: &[&str] = &["정비", "예방", "관리", "접수"];

#[derive(Debug, thiserror::Error)]
pub enum ProvisioningError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("database helper error: {0}")]
    Db(#[from] mnt_platform_db::DbError),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("auth error: {0}")]
    Auth(#[from] mnt_platform_auth::AuthError),

    #[error("kernel error: {0}")]
    Kernel(#[from] KernelError),

    #[error("invalid roster: {0}")]
    InvalidRoster(String),

    #[error("unknown branch {region}/{branch} for roster phone {phone}")]
    UnknownBranch {
        phone: String,
        region: String,
        branch: String,
    },

    #[error("invalid bootstrap credential")]
    InvalidBootstrapCredential,

    #[error("bootstrap credential expired")]
    BootstrapCredentialExpired,

    #[error("bootstrap credential has already been used")]
    BootstrapCredentialUsed,

    #[error("bootstrap credential was revoked")]
    BootstrapCredentialRevoked,

    #[error("bootstrap registration already started")]
    BootstrapRegistrationAlreadyStarted,

    #[error("user already has a registered passkey")]
    UserAlreadyHasPasskey,

    #[error("user already has an active bootstrap credential")]
    ActiveBootstrapCredentialExists,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapToken(String);

impl BootstrapToken {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapCredentialIssue {
    pub credential_id: Uuid,
    pub user_id: Uuid,
    pub token: BootstrapToken,
    pub expires_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RosterImportReport {
    pub users_created: u32,
    pub users_updated: u32,
    pub users_unchanged: u32,
    pub branch_memberships_added: u32,
    pub branch_memberships_removed: u32,
    pub bootstrap_credentials_issued: Vec<BootstrapCredentialIssue>,
}

impl RosterImportReport {
    #[must_use]
    pub fn changed_count(&self) -> u32 {
        self.users_created
            + self.users_updated
            + self.branch_memberships_added
            + self.branch_memberships_removed
            + u32::try_from(self.bootstrap_credentials_issued.len()).unwrap_or(u32::MAX)
    }
}

#[derive(Debug, Clone)]
pub struct RosterProvisioner {
    bootstrap_ttl: Duration,
}

impl RosterProvisioner {
    #[must_use]
    pub const fn new(bootstrap_ttl: Duration) -> Self {
        Self { bootstrap_ttl }
    }

    pub async fn import_json(
        &self,
        pool: &PgPool,
        roster_json: &str,
        now: OffsetDateTime,
    ) -> Result<RosterImportReport, ProvisioningError> {
        let roster: RosterImport = serde_json::from_str(roster_json)?;
        let users = normalize_roster(roster)?;
        let user_count = users.len();
        let bootstrap_ttl = self.bootstrap_ttl;

        let audit = AuditEvent::new(
            None,
            AuditAction::new("roster.import")?,
            "roster_import",
            Uuid::new_v4().to_string(),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "user_rows": user_count,
                "format": "json.v1"
            })),
        );

        with_audit::<_, RosterImportReport, ProvisioningError>(pool, audit, |tx| {
            Box::pin(async move { apply_roster_tx(tx, users, now, bootstrap_ttl).await })
        })
        .await
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct BootstrapCredentialStore;

impl BootstrapCredentialStore {
    pub async fn issue_for_zero_credential_user(
        &self,
        pool: &PgPool,
        user_id: Uuid,
        now: OffsetDateTime,
        ttl: Duration,
    ) -> Result<BootstrapCredentialIssue, ProvisioningError> {
        let audit = AuditEvent::new(
            None,
            AuditAction::new("auth.bootstrap.issue")?,
            "auth_bootstrap_credential",
            user_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "user_id": user_id,
                "expires_at": now + ttl,
            })),
        );

        with_audit::<_, BootstrapCredentialIssue, ProvisioningError>(pool, audit, |tx| {
            Box::pin(async move {
                issue_bootstrap_if_needed_tx(tx, user_id, now, ttl, true)
                    .await?
                    .ok_or(ProvisioningError::ActiveBootstrapCredentialExists)
            })
        })
        .await
    }

    pub async fn start_passkey_registration(
        &self,
        pool: &PgPool,
        passkeys: &PasskeyService,
        token: &str,
        username: String,
        display_name: String,
    ) -> Result<RegistrationCeremony, ProvisioningError> {
        let token_hash = hash_token(token);
        let row = sqlx::query(
            r#"
            SELECT id, user_id, expires_at, consumed_at, revoked_at, registration_ceremony_id
            FROM auth_bootstrap_credentials
            WHERE token_hash = $1
            "#,
        )
        .bind(token_hash)
        .fetch_optional(pool)
        .await?
        .ok_or(ProvisioningError::InvalidBootstrapCredential)?;

        let credential_id: Uuid = row.try_get("id")?;
        let user_id: Uuid = row.try_get("user_id")?;
        let expires_at: OffsetDateTime = row.try_get("expires_at")?;
        let consumed_at: Option<OffsetDateTime> = row.try_get("consumed_at")?;
        let revoked_at: Option<OffsetDateTime> = row.try_get("revoked_at")?;
        let registration_ceremony_id: Option<Uuid> = row.try_get("registration_ceremony_id")?;

        validate_bootstrap_state(
            expires_at,
            consumed_at,
            revoked_at,
            OffsetDateTime::now_utc(),
        )?;
        if registration_ceremony_id.is_some() {
            return Err(ProvisioningError::BootstrapRegistrationAlreadyStarted);
        }

        let passkey_count = count_user_passkeys(pool, user_id).await?;
        if passkey_count > 0 {
            return Err(ProvisioningError::UserAlreadyHasPasskey);
        }

        let registration = passkeys
            .start_registration(
                pool,
                PasskeyRegistrationStart {
                    user_id,
                    username,
                    display_name,
                },
            )
            .await?;

        let now = OffsetDateTime::now_utc();
        let audit = AuditEvent::new(
            Some(UserId::from_uuid(user_id)),
            AuditAction::new("auth.bootstrap.start_registration")?,
            "auth_bootstrap_credential",
            credential_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "user_id": user_id,
                "ceremony_id": registration.ceremony_id,
            })),
        );

        with_audit::<_, (), ProvisioningError>(pool, audit, |tx| {
            Box::pin(async move {
                let affected = sqlx::query(
                    r#"
                    UPDATE auth_bootstrap_credentials
                    SET registration_ceremony_id = $1, registration_started_at = $2
                    WHERE id = $3
                      AND consumed_at IS NULL
                      AND revoked_at IS NULL
                      AND registration_ceremony_id IS NULL
                    "#,
                )
                .bind(registration.ceremony_id)
                .bind(now)
                .bind(credential_id)
                .execute(tx.as_mut())
                .await?
                .rows_affected();

                if affected == 1 {
                    Ok(())
                } else {
                    Err(ProvisioningError::BootstrapRegistrationAlreadyStarted)
                }
            })
        })
        .await?;

        Ok(registration)
    }

    pub async fn finish_passkey_registration(
        &self,
        pool: &PgPool,
        passkeys: &PasskeyService,
        ceremony_id: Uuid,
        credential: PasskeyRegistrationCredential,
    ) -> Result<StoredPasskey, ProvisioningError> {
        let row = sqlx::query(
            r#"
            SELECT id, user_id, expires_at, consumed_at, revoked_at
            FROM auth_bootstrap_credentials
            WHERE registration_ceremony_id = $1
            "#,
        )
        .bind(ceremony_id)
        .fetch_optional(pool)
        .await?
        .ok_or(ProvisioningError::InvalidBootstrapCredential)?;

        let bootstrap_id: Uuid = row.try_get("id")?;
        let user_id: Uuid = row.try_get("user_id")?;
        let expires_at: OffsetDateTime = row.try_get("expires_at")?;
        let consumed_at: Option<OffsetDateTime> = row.try_get("consumed_at")?;
        let revoked_at: Option<OffsetDateTime> = row.try_get("revoked_at")?;
        let now = OffsetDateTime::now_utc();
        validate_bootstrap_state(expires_at, consumed_at, revoked_at, now)?;

        // Single transaction: the passkey registration (which atomically claims
        // the WebAuthn ceremony) and the single-use bootstrap-credential consume
        // commit or roll back together, so a passkey can never be created without
        // atomically consuming the bootstrap credential that authorized it.
        let mut tx = pool.begin().await?;

        let stored_passkey = passkeys
            .finish_registration_in_tx(&mut tx, ceremony_id, credential, now)
            .await?;

        let affected = sqlx::query(
            r#"
            UPDATE auth_bootstrap_credentials
            SET consumed_at = $1
            WHERE id = $2
              AND consumed_at IS NULL
              AND revoked_at IS NULL
            "#,
        )
        .bind(now)
        .bind(bootstrap_id)
        .execute(tx.as_mut())
        .await?
        .rows_affected();

        if affected != 1 {
            // Rolls back the passkey insert as well: no orphan enrollment.
            return Err(ProvisioningError::BootstrapCredentialUsed);
        }

        let audit = AuditEvent::new(
            Some(UserId::from_uuid(user_id)),
            AuditAction::new("auth.bootstrap.consume")?,
            "auth_bootstrap_credential",
            bootstrap_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "user_id": user_id,
                "passkey_id": stored_passkey.id,
            })),
        );
        insert_audit_event(&mut tx, &audit).await?;

        tx.commit().await?;

        Ok(stored_passkey)
    }
}

#[derive(Debug, Deserialize)]
struct RosterImport {
    users: Vec<RosterUser>,
}

#[derive(Debug, Deserialize)]
struct RosterUser {
    display_name: String,
    phone: String,
    team: Option<String>,
    roles: Vec<String>,
    branches: Vec<RosterBranchMembership>,
}

#[derive(Debug, Deserialize)]
struct RosterBranchMembership {
    region: String,
    branch: String,
}

#[derive(Debug, Clone)]
struct NormalizedRosterUser {
    display_name: String,
    phone: String,
    team: Option<String>,
    roles: Vec<String>,
    branches: Vec<BranchRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct BranchRef {
    region: String,
    branch: String,
}

fn normalize_roster(roster: RosterImport) -> Result<Vec<NormalizedRosterUser>, ProvisioningError> {
    if roster.users.is_empty() {
        return Err(ProvisioningError::InvalidRoster(
            "at least one user row is required".to_owned(),
        ));
    }

    let mut phones = BTreeSet::new();
    let mut users = Vec::with_capacity(roster.users.len());

    for row in roster.users {
        let display_name = row.display_name.trim().to_owned();
        if display_name.is_empty() {
            return Err(ProvisioningError::InvalidRoster(
                "display_name is required".to_owned(),
            ));
        }

        let phone = row.phone.trim().to_owned();
        if phone.is_empty() {
            return Err(ProvisioningError::InvalidRoster(
                "phone is required for idempotent roster import".to_owned(),
            ));
        }
        if !phones.insert(phone.clone()) {
            return Err(ProvisioningError::InvalidRoster(format!(
                "duplicate phone {phone}"
            )));
        }

        let team = row.team.map(|team| team.trim().to_owned());
        if let Some(team) = &team
            && !VALID_TEAMS.contains(&team.as_str())
        {
            return Err(ProvisioningError::InvalidRoster(format!(
                "invalid team {team:?} for phone {phone}"
            )));
        }

        let mut roles = row
            .roles
            .into_iter()
            .map(|role| role.trim().to_owned())
            .collect::<Vec<_>>();
        roles.sort();
        roles.dedup();
        if roles.is_empty() {
            return Err(ProvisioningError::InvalidRoster(format!(
                "roles are required for phone {phone}"
            )));
        }
        if let Some(invalid) = roles
            .iter()
            .find(|role| !VALID_ROLES.contains(&role.as_str()))
        {
            return Err(ProvisioningError::InvalidRoster(format!(
                "invalid role {invalid:?} for phone {phone}"
            )));
        }

        let mut branches = row
            .branches
            .into_iter()
            .map(|branch| BranchRef {
                region: branch.region.trim().to_owned(),
                branch: branch.branch.trim().to_owned(),
            })
            .collect::<Vec<_>>();
        branches.sort();
        branches.dedup();
        if branches
            .iter()
            .any(|item| item.region.is_empty() || item.branch.is_empty())
        {
            return Err(ProvisioningError::InvalidRoster(format!(
                "branch region/name are required for phone {phone}"
            )));
        }

        users.push(NormalizedRosterUser {
            display_name,
            phone,
            team,
            roles,
            branches,
        });
    }

    Ok(users)
}

async fn apply_roster_tx(
    tx: &mut Transaction<'_, Postgres>,
    users: Vec<NormalizedRosterUser>,
    now: OffsetDateTime,
    bootstrap_ttl: Duration,
) -> Result<RosterImportReport, ProvisioningError> {
    let mut resolved_branches: BTreeMap<(String, String), Uuid> = BTreeMap::new();
    let mut seen_branch_keys = BTreeSet::new();
    for user in &users {
        for branch_ref in &user.branches {
            let branch_key = (branch_ref.region.clone(), branch_ref.branch.clone());
            if seen_branch_keys.insert(branch_key.clone()) {
                let branch_id = resolve_branch_tx(tx, &user.phone, branch_ref).await?;
                resolved_branches.insert(branch_key, branch_id);
            }
        }
    }

    let mut report = RosterImportReport::default();

    for user in users {
        let desired_branches = user
            .branches
            .iter()
            .filter_map(|branch_ref| {
                resolved_branches
                    .get(&(branch_ref.region.clone(), branch_ref.branch.clone()))
                    .copied()
            })
            .collect::<BTreeSet<_>>();

        let existing = sqlx::query(
            r#"
            SELECT id, display_name, roles, team
            FROM users
            WHERE phone = $1
            FOR UPDATE
            "#,
        )
        .bind(&user.phone)
        .fetch_optional(tx.as_mut())
        .await?;

        let user_id = if let Some(row) = existing {
            let user_id: Uuid = row.try_get("id")?;
            let existing_display_name: String = row.try_get("display_name")?;
            let existing_roles: Vec<String> = row.try_get("roles")?;
            let existing_team: Option<String> = row.try_get("team")?;

            if existing_display_name != user.display_name
                || existing_roles != user.roles
                || existing_team != user.team
            {
                sqlx::query(
                    r#"
                    UPDATE users
                    SET display_name = $1, roles = $2, team = $3
                    WHERE id = $4
                    "#,
                )
                .bind(&user.display_name)
                .bind(&user.roles)
                .bind(&user.team)
                .bind(user_id)
                .execute(tx.as_mut())
                .await?;
                report.users_updated += 1;
            } else {
                report.users_unchanged += 1;
            }

            user_id
        } else {
            let user_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO users (display_name, phone, roles, team)
                VALUES ($1, $2, $3, $4)
                RETURNING id
                "#,
            )
            .bind(&user.display_name)
            .bind(&user.phone)
            .bind(&user.roles)
            .bind(&user.team)
            .fetch_one(tx.as_mut())
            .await?;
            report.users_created += 1;

            if let Some(issue) =
                issue_bootstrap_if_needed_tx(tx, user_id, now, bootstrap_ttl, false).await?
            {
                report.bootstrap_credentials_issued.push(issue);
            }

            user_id
        };

        let existing_branch_rows: Vec<Uuid> =
            sqlx::query_scalar("SELECT branch_id FROM user_branches WHERE user_id = $1")
                .bind(user_id)
                .fetch_all(tx.as_mut())
                .await?;
        let existing_branches = existing_branch_rows.into_iter().collect::<BTreeSet<_>>();

        for branch_id in desired_branches.difference(&existing_branches) {
            sqlx::query("INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)")
                .bind(user_id)
                .bind(*branch_id)
                .execute(tx.as_mut())
                .await?;
            report.branch_memberships_added += 1;
        }

        for branch_id in existing_branches.difference(&desired_branches) {
            sqlx::query("DELETE FROM user_branches WHERE user_id = $1 AND branch_id = $2")
                .bind(user_id)
                .bind(*branch_id)
                .execute(tx.as_mut())
                .await?;
            report.branch_memberships_removed += 1;
        }
    }

    Ok(report)
}

async fn resolve_branch_tx(
    tx: &mut Transaction<'_, Postgres>,
    phone: &str,
    branch_ref: &BranchRef,
) -> Result<Uuid, ProvisioningError> {
    sqlx::query_scalar(
        r#"
        SELECT b.id
        FROM branches b
        JOIN regions r ON r.id = b.region_id
        WHERE r.name = $1 AND b.name = $2
        "#,
    )
    .bind(&branch_ref.region)
    .bind(&branch_ref.branch)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| ProvisioningError::UnknownBranch {
        phone: phone.to_owned(),
        region: branch_ref.region.clone(),
        branch: branch_ref.branch.clone(),
    })
}

async fn issue_bootstrap_if_needed_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    now: OffsetDateTime,
    ttl: Duration,
    reject_existing: bool,
) -> Result<Option<BootstrapCredentialIssue>, ProvisioningError> {
    sqlx::query(
        r#"
        UPDATE auth_bootstrap_credentials
        SET revoked_at = $1, revoked_reason = 'expired'
        WHERE user_id = $2
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at <= $1
        "#,
    )
    .bind(now)
    .bind(user_id)
    .execute(tx.as_mut())
    .await?;

    let passkey_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(tx.as_mut())
            .await?;
    if passkey_count > 0 {
        if reject_existing {
            return Err(ProvisioningError::UserAlreadyHasPasskey);
        }
        return Ok(None);
    }

    let existing_active: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM auth_bootstrap_credentials
        WHERE user_id = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL
        FOR UPDATE
        "#,
    )
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?;
    if existing_active.is_some() {
        if reject_existing {
            return Err(ProvisioningError::ActiveBootstrapCredentialExists);
        }
        return Ok(None);
    }

    let credential_id = Uuid::new_v4();
    let token = generate_bootstrap_token();
    let token_hash = hash_token(token.as_str());
    let expires_at = now + ttl;

    sqlx::query(
        r#"
        INSERT INTO auth_bootstrap_credentials (
            id, user_id, token_hash, issued_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(credential_id)
    .bind(user_id)
    .bind(token_hash)
    .bind(now)
    .bind(expires_at)
    .execute(tx.as_mut())
    .await?;

    Ok(Some(BootstrapCredentialIssue {
        credential_id,
        user_id,
        token,
        expires_at,
    }))
}

async fn count_user_passkeys(pool: &PgPool, user_id: Uuid) -> Result<i64, ProvisioningError> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await?,
    )
}

fn validate_bootstrap_state(
    expires_at: OffsetDateTime,
    consumed_at: Option<OffsetDateTime>,
    revoked_at: Option<OffsetDateTime>,
    now: OffsetDateTime,
) -> Result<(), ProvisioningError> {
    if consumed_at.is_some() {
        return Err(ProvisioningError::BootstrapCredentialUsed);
    }
    if revoked_at.is_some() {
        return Err(ProvisioningError::BootstrapCredentialRevoked);
    }
    if expires_at <= now {
        return Err(ProvisioningError::BootstrapCredentialExpired);
    }
    Ok(())
}

fn generate_bootstrap_token() -> BootstrapToken {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    BootstrapToken(format!("mnt_boot_{}", hex_encode(&bytes)))
}

fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
