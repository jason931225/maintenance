//! Bulk roster provisioning and passkey cold-start.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::{BTreeMap, BTreeSet};

use mnt_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use mnt_platform_db::{insert_audit_event, with_audit, with_audits};
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

    /// Generic OTP-redeem failure. Unknown, expired, revoked, and
    /// already-consumed all collapse to this single variant so the REST layer can
    /// surface one "invalid or expired" message without revealing which it was.
    #[error("invalid bootstrap credential")]
    InvalidBootstrapCredential,

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
        // Roster import stamps every row with KNL today (single-tenant import).
        // Arm KNL as the GUC so the FORCE-RLS WITH CHECK on `users`,
        // `user_branches`, and `auth_bootstrap_credentials` accepts these writes
        // under the non-owner `mnt_rt` role.
        .with_org(OrgId::knl())
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
        org: OrgId,
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
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "user_id": user_id,
                "expires_at": now + ttl,
            })),
        );

        with_audit::<_, BootstrapCredentialIssue, ProvisioningError>(pool, audit, |tx| {
            Box::pin(async move {
                // Admin-issued OTP path: the request's tenant `org` is threaded in
                // from the authenticated admin's verified token. `with_audit` arms
                // `app.current_org` to that org from the audit event above (the
                // `.with_org(org)` call), so the FORCE-RLS WITH CHECK on
                // `auth_bootstrap_credentials` accepts the row for ANY tenant — not
                // just KNL — and the credential is stamped with the real org.
                issue_bootstrap_if_needed_tx(tx, user_id, org, now, ttl, true)
                    .await?
                    .ok_or(ProvisioningError::ActiveBootstrapCredentialExists)
            })
        })
        .await
    }

    /// Redeem a one-time OTP (bootstrap token) as a FIRST SIGN-IN.
    ///
    /// This is a sign-in, not signup: the user row was pre-provisioned by the
    /// admin who issued the OTP (or seeded for the cold-start admin). The
    /// redeeming user's id is returned so the caller can mint a session. Passkey
    /// enrollment is NOT bundled here — the user adds a passkey afterwards from
    /// authenticated initial settings.
    ///
    /// Security properties:
    /// * VERIFY-ONLY: a redeem mints a session but does NOT consume the code.
    ///   Single-use is enforced at passkey REGISTRATION by
    ///   [`Self::consume_open_credentials_tx`], which burns the code atomically
    ///   with the passkey insert (the harden-1 pattern). An incomplete or
    ///   cancelled enrollment therefore never burns the code — the user can
    ///   re-redeem until a passkey actually sticks; once a passkey exists the code
    ///   is dead and can never mint another session.
    /// * A WRONG guess never consumes or invalidates a credential — an unknown
    ///   token simply finds no row. There is deliberately no per-OTP attempt cap
    ///   (that would let an attacker burn a victim's OTP); brute-force is bounded
    ///   by the caller's per-client rate limit plus the short TTL.
    /// * Expiry and revocation are still enforced here, so an expired or revoked
    ///   OTP cannot mint a session.
    ///
    /// All failure modes collapse to [`ProvisioningError::InvalidBootstrapCredential`]
    /// so the caller can return a single generic "invalid or expired" message
    /// without revealing whether the token was unknown, expired, or already used.
    pub async fn redeem_otp(
        &self,
        pool: &PgPool,
        token: &str,
        now: OffsetDateTime,
    ) -> Result<OtpRedemption, ProvisioningError> {
        let token_hash = hash_token(token);

        // Atomic single-use claim + expiry check in one statement. RETURNING the
        // owning user only when the row was still unconsumed, unrevoked, and
        // unexpired — exactly the harden-1 invariant, so a redeemed OTP can never
        // be replayed.
        let mut tx = pool.begin().await?;

        // Resolve the credential's tenant from the token hash FIRST, then arm the
        // GUC, THEN do the RLS-gated read. `auth_bootstrap_credentials` is FORCE
        // RLS (migration 0035), so as the non-owner `mnt_rt` role a lookup-by-hash
        // returns ZERO rows until `app.current_org` is set — but the org is what we
        // need to set it. The narrow SECURITY DEFINER resolver
        // `platform_resolve_bootstrap_org` (migration 0038) returns only the
        // credential's org_id, breaking that chicken-and-egg so OTP first sign-in
        // works for ANY tenant. A NULL means the token is unknown: keep the same
        // generic invalid-OTP error (no row), revealing nothing.
        let Some(org_uuid) = resolve_bootstrap_org(&mut tx, &token_hash).await? else {
            tx.rollback().await?;
            return Err(ProvisioningError::InvalidBootstrapCredential);
        };
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_uuid.to_string())
            .execute(tx.as_mut())
            .await?;

        // Verify-ONLY: a redeem mints a session but does NOT consume the code.
        // Single-use is enforced at passkey REGISTRATION (consume_open_credentials_tx,
        // atomic with the passkey insert via the harden-1 pattern), so an incomplete
        // or cancelled enrollment never burns the code — the user can re-redeem until
        // a passkey actually sticks. Expiry/revocation are still enforced here.
        let claimed = sqlx::query(
            r#"
            SELECT id, user_id
            FROM auth_bootstrap_credentials
            WHERE token_hash = $1
              AND consumed_at IS NULL
              AND revoked_at IS NULL
              AND expires_at > $2
            "#,
        )
        .bind(&token_hash)
        .bind(now)
        .fetch_optional(tx.as_mut())
        .await?;

        let Some(row) = claimed else {
            // Unknown, expired, revoked, or already-consumed: single generic error.
            tx.rollback().await?;
            return Err(ProvisioningError::InvalidBootstrapCredential);
        };
        let credential_id: Uuid = row.try_get("id")?;
        let user_id: Uuid = row.try_get("user_id")?;

        let requires_passkey_setup = count_user_passkeys_tx(&mut tx, user_id).await? == 0;

        let audit = AuditEvent::new(
            Some(UserId::from_uuid(user_id)),
            AuditAction::new("auth.otp.redeem")?,
            "auth_bootstrap_credential",
            credential_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "user_id": user_id,
                "requires_passkey_setup": requires_passkey_setup,
            })),
        );
        insert_audit_event(&mut tx, &audit).await?;

        tx.commit().await?;

        Ok(OtpRedemption {
            user_id,
            org_id: OrgId::from_uuid(org_uuid),
            requires_passkey_setup,
        })
    }

    /// Consume the user's open one-time code(s) inside the caller's transaction.
    ///
    /// Called from passkey registration so the code is consumed ATOMICALLY with the
    /// passkey insert (the harden-1 single-use invariant). Because a redeem no longer
    /// consumes, this is the single point of consumption: once a passkey exists the
    /// code is dead and can never mint another session. A returning user adding a
    /// second passkey simply has no open code, so this is a clean no-op (0 rows).
    pub async fn consume_open_credentials_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        user_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<(), ProvisioningError> {
        let consumed = sqlx::query(
            r#"
            UPDATE auth_bootstrap_credentials
            SET consumed_at = $2
            WHERE user_id = $1
              AND consumed_at IS NULL
              AND revoked_at IS NULL
              AND expires_at > $2
            RETURNING id
            "#,
        )
        .bind(user_id)
        .bind(now)
        .fetch_all(tx.as_mut())
        .await?;

        for row in consumed {
            let credential_id: Uuid = row.try_get("id")?;
            let audit = AuditEvent::new(
                Some(UserId::from_uuid(user_id)),
                AuditAction::new("auth.otp.consume")?,
                "auth_bootstrap_credential",
                credential_id.to_string(),
                TraceContext::generate(),
                now,
            )
            .with_snapshots(None, Some(serde_json::json!({ "user_id": user_id })));
            insert_audit_event(tx, &audit).await?;
        }
        Ok(())
    }

    /// Seed a deploy-time cold-start OTP for the PLATFORM cold-start SUPER_ADMIN
    /// at app boot.
    ///
    /// The global `MNT_COLDSTART_OTP` bootstraps the PLATFORM admin — the first
    /// account ABOVE all tenants — NOT a tenant admin. The "Cold Start Admin"
    /// user is re-homed to the platform sentinel org [`OrgId::platform`] by
    /// migration 0036, so this arms that sentinel as the GUC; the seeded
    /// bootstrap credential carries the sentinel org_id. KNL's own tenant admin
    /// is created via the per-org onboarding flow (POST /platform/orgs), not here.
    ///
    /// ONLY IF that admin has neither a registered passkey nor an already-open
    /// bootstrap credential, this inserts a single bootstrap credential whose
    /// `token_hash = hash_token(otp)` and that expires at `now + ttl`. The insert
    /// is audited via [`with_audits`] (action `auth.coldstart.seed`, target = the
    /// admin user id); the OTP value is NEVER written to the audit snapshot or any
    /// log.
    ///
    /// Returns `Ok(true)` when a credential was seeded and `Ok(false)` when it was
    /// skipped (no cold-start admin, or the admin already has a passkey or an open
    /// credential). Idempotent and race-safe: the existence checks and the insert
    /// run inside one transaction with `FOR UPDATE` on the admin row, exactly like
    /// [`issue_bootstrap_if_needed_tx`], so two concurrent boots cannot double-seed.
    pub async fn seed_cold_start_credential(
        &self,
        pool: &PgPool,
        otp: &str,
        ttl: Duration,
        now: OffsetDateTime,
    ) -> Result<bool, ProvisioningError> {
        let token_hash = hash_token(otp);

        with_audits::<_, bool, ProvisioningError>(pool, OrgId::platform(), |tx| {
            Box::pin(async move {
                match seed_cold_start_if_needed_tx(tx, &token_hash, now, ttl).await? {
                    Some((admin_id, credential_id)) => {
                        // The OTP value is NEVER placed in the audit trail; only the
                        // admin id and the new credential id are recorded.
                        let event = AuditEvent::new(
                            Some(UserId::from_uuid(admin_id)),
                            AuditAction::new("auth.coldstart.seed")?,
                            "auth_bootstrap_credential",
                            credential_id.to_string(),
                            TraceContext::generate(),
                            now,
                        )
                        .with_snapshots(None, Some(serde_json::json!({ "user_id": admin_id })));
                        Ok((true, vec![event]))
                    }
                    None => Ok((false, Vec::new())),
                }
            })
        })
        .await
    }
}

// ---------------------------------------------------------------------------
// Platform tenant onboarding.
// ---------------------------------------------------------------------------

/// Summary of a tenant row for the platform tenant-list / status APIs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OrganizationSummary {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub status: String,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

/// Per-tenant health/usage rollup for the platform ops dashboard.
///
/// Produced by the SECURITY DEFINER `platform_org_health()` function (the only
/// sanctioned cross-tenant aggregation path) and surfaced through an audited
/// platform read. Carries only counts + a last-activity timestamp; never any
/// row-level tenant data.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TenantHealth {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub status: String,
    pub user_count: i64,
    pub active_user_count: i64,
    pub active_work_orders: i64,
    pub open_work_orders: i64,
    pub last_activity_at: Option<OffsetDateTime>,
}

/// Outcome of onboarding a new tenant: the created org plus the ONE-TIME OTP for
/// its first SUPER_ADMIN, to be delivered out-of-band.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantOnboarding {
    pub organization: OrganizationSummary,
    pub admin_user_id: Uuid,
    /// The one-time cold-start OTP for the new org's first SUPER_ADMIN. Returned
    /// to the platform caller exactly once; never logged or audited.
    pub admin_otp: BootstrapToken,
    pub admin_otp_expires_at: OffsetDateTime,
}

/// Cross-tenant tenant-provisioning operations for the PLATFORM tier.
///
/// Every method here is a privileged, AUDITED, cross-tenant action. The REST
/// layer only reaches it behind the platform extractor (a tenant token is
/// rejected), so these can never be driven by a tenant admin.
#[derive(Debug, Clone, Copy)]
pub struct PlatformProvisioner {
    onboarding_otp_ttl: Duration,
}

impl PlatformProvisioner {
    #[must_use]
    pub const fn new(onboarding_otp_ttl: Duration) -> Self {
        Self { onboarding_otp_ttl }
    }

    /// Onboard a NEW tenant: create the `organizations` row, seed its first
    /// SUPER_ADMIN user (org_id = the new org), and issue a per-org cold-start
    /// OTP — all in ONE transaction, audited to the TARGET org so the action
    /// shows in both the platform and the tenant's audit trail.
    ///
    /// The org row is INSERTed via the SECURITY DEFINER `platform_create_organization`
    /// (migration 0036): `organizations` is SELECT-only + FORCE RLS for the app's
    /// `mnt_rt` role, so this is the ONLY path that can create an org. The function
    /// arms `app.current_org` to the new id, so the rest of the transaction (the
    /// admin user + the OTP credential, both stamped with the new org) passes the
    /// FORCE-RLS WITH CHECK on every tenant table as the non-owner role.
    pub async fn onboard_tenant(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        slug: &str,
        name: &str,
        now: OffsetDateTime,
    ) -> Result<TenantOnboarding, ProvisioningError> {
        let slug = slug.trim().to_owned();
        let name = name.trim().to_owned();
        if slug.is_empty() || name.is_empty() {
            return Err(ProvisioningError::InvalidRoster(
                "slug and name are required to onboard a tenant".to_owned(),
            ));
        }
        let ttl = self.onboarding_otp_ttl;

        let mut tx = pool.begin().await?;

        // (1) Create the org via the privileged DEFINER function. It arms the GUC
        // to the new id, so every subsequent tenant write in this tx passes RLS.
        let org_id: Uuid = sqlx::query_scalar("SELECT platform_create_organization($1, $2)")
            .bind(&slug)
            .bind(&name)
            .fetch_one(tx.as_mut())
            .await?;

        let organization = fetch_org_tx(&mut tx, org_id).await?;

        // (2) Seed the first SUPER_ADMIN for the new tenant.
        let admin_user_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO users (display_name, roles, is_active, org_id)
            VALUES ($1, $2, true, $3)
            RETURNING id
            "#,
        )
        .bind("Tenant Admin")
        .bind(&["SUPER_ADMIN"] as &[&str])
        .bind(org_id)
        .fetch_one(tx.as_mut())
        .await?;

        // (3) Issue the per-org cold-start OTP for that admin. Fresh per-org —
        // never the removed fixed `coss0000` seed.
        let issue = issue_bootstrap_if_needed_tx(
            &mut tx,
            admin_user_id,
            OrgId::from_uuid(org_id),
            now,
            ttl,
            true,
        )
        .await?
        .ok_or(ProvisioningError::ActiveBootstrapCredentialExists)?;

        // (4) Audit the onboarding to the TARGET org (so it lands in the tenant's
        // trail too). The OTP value is NEVER recorded.
        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.tenant.create")?,
            "organizations",
            org_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::from_uuid(org_id))
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "org_id": org_id,
                "slug": slug,
                "admin_user_id": admin_user_id,
            })),
        );
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;

        Ok(TenantOnboarding {
            organization,
            admin_user_id,
            admin_otp: issue.token,
            admin_otp_expires_at: issue.expires_at,
        })
    }

    /// List all tenants (cross-tenant read) via the SECURITY DEFINER
    /// `platform_list_organizations` so the platform tier sees every org even
    /// though `organizations` is RLS-gated for `mnt_rt`. Audited by the caller.
    pub async fn list_tenants(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        now: OffsetDateTime,
    ) -> Result<Vec<OrganizationSummary>, ProvisioningError> {
        let mut tx = pool.begin().await?;
        let rows = sqlx::query(
            r#"
            SELECT id, slug, name, status, created_at, updated_at
            FROM platform_list_organizations()
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .fetch_all(tx.as_mut())
        .await?;

        let summaries = rows
            .into_iter()
            .map(|row| {
                Ok(OrganizationSummary {
                    id: row.try_get("id")?,
                    slug: row.try_get("slug")?,
                    name: row.try_get("name")?,
                    status: row.try_get("status")?,
                    created_at: row.try_get("created_at")?,
                    updated_at: row.try_get("updated_at")?,
                })
            })
            .collect::<Result<Vec<_>, ProvisioningError>>()?;

        // Audited cross-tenant read. This is a PLATFORM-tier event (no single
        // target tenant), so it carries org_id = NULL — the audit_events WITH
        // CHECK allows a NULL-org platform row even with no tenant GUC armed.
        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.tenant.list")?,
            "organizations",
            "list",
            TraceContext::generate(),
            now,
        )
        .with_snapshots(None, Some(serde_json::json!({ "count": summaries.len() })));
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(summaries)
    }

    /// Cross-tenant ops health rollup for EVERY tenant (audited platform read).
    ///
    /// The aggregation runs through the SECURITY DEFINER `platform_org_health()`
    /// function — the single sanctioned cross-tenant path — which scans all
    /// tenants with `row_security` briefly disabled and restored. This is a
    /// PLATFORM-tier read (org_id = NULL on the audit row) recorded as
    /// `platform.tenant.health`, so no cross-tenant read is ever unaudited.
    pub async fn list_tenant_health(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        now: OffsetDateTime,
    ) -> Result<Vec<TenantHealth>, ProvisioningError> {
        let mut tx = pool.begin().await?;
        let rows = sqlx::query(
            r#"
            SELECT
                id, slug, name, status,
                user_count, active_user_count,
                active_work_orders, open_work_orders, last_activity_at
            FROM platform_org_health()
            "#,
        )
        .fetch_all(tx.as_mut())
        .await?;

        let health = rows
            .into_iter()
            .map(|row| {
                Ok(TenantHealth {
                    id: row.try_get("id")?,
                    slug: row.try_get("slug")?,
                    name: row.try_get("name")?,
                    status: row.try_get("status")?,
                    user_count: row.try_get("user_count")?,
                    active_user_count: row.try_get("active_user_count")?,
                    active_work_orders: row.try_get("active_work_orders")?,
                    open_work_orders: row.try_get("open_work_orders")?,
                    last_activity_at: row.try_get("last_activity_at")?,
                })
            })
            .collect::<Result<Vec<_>, ProvisioningError>>()?;

        // Audited cross-tenant read (PLATFORM-tier; org_id = NULL).
        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.tenant.health")?,
            "organizations",
            "health",
            TraceContext::generate(),
            now,
        )
        .with_snapshots(None, Some(serde_json::json!({ "count": health.len() })));
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(health)
    }

    /// Suspend / reactivate a tenant by setting its `status`. Audited to the
    /// TARGET org. Runs via the SECURITY DEFINER `platform_set_organization_status`
    /// (organizations is not UPDATE-able by `mnt_rt`).
    pub async fn set_tenant_status(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        org_id: Uuid,
        status: &str,
        now: OffsetDateTime,
    ) -> Result<OrganizationSummary, ProvisioningError> {
        if !matches!(status, "ACTIVE" | "SUSPENDED" | "ARCHIVED") {
            return Err(ProvisioningError::InvalidRoster(format!(
                "invalid tenant status {status:?}"
            )));
        }

        let mut tx = pool.begin().await?;
        let updated: Option<Uuid> =
            sqlx::query_scalar("SELECT platform_set_organization_status($1, $2)")
                .bind(org_id)
                .bind(status)
                .fetch_one(tx.as_mut())
                .await?;
        let Some(updated_id) = updated else {
            tx.rollback().await?;
            return Err(ProvisioningError::InvalidBootstrapCredential);
        };
        let organization = fetch_org_tx(&mut tx, updated_id).await?;

        // Arm the TARGET org so the audit insert below passes the audit_events
        // WITH CHECK (org_id = GUC). The org row write itself went through the
        // SECURITY DEFINER function, so the GUC was not armed before now.
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(updated_id.to_string())
            .execute(tx.as_mut())
            .await?;

        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.tenant.status")?,
            "organizations",
            org_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::from_uuid(org_id))
        .with_snapshots(None, Some(serde_json::json!({ "status": status })));
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(organization)
    }
}

/// Outcome of a successful OTP first sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OtpRedemption {
    /// The pre-provisioned user the OTP belonged to; the caller mints a session
    /// for this user.
    pub user_id: Uuid,
    /// The tenant the redeemed credential belongs to, resolved from the token
    /// hash BEFORE the RLS-gated read. The caller arms the GUC with it to load
    /// the user and mint the session, since the OTP redeem route runs before the
    /// tenant middleware.
    pub org_id: OrgId,
    /// True when the user has no registered passkey yet, so the frontend should
    /// force passkey enrollment during initial settings.
    pub requires_passkey_setup: bool,
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
                INSERT INTO users (display_name, phone, roles, team, org_id)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id
                "#,
            )
            .bind(&user.display_name)
            .bind(&user.phone)
            .bind(&user.roles)
            .bind(&user.team)
            .bind(*OrgId::knl().as_uuid())
            .fetch_one(tx.as_mut())
            .await?;
            report.users_created += 1;

            if let Some(issue) =
                issue_bootstrap_if_needed_tx(tx, user_id, OrgId::knl(), now, bootstrap_ttl, false)
                    .await?
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
            sqlx::query(
                "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)",
            )
            .bind(user_id)
            .bind(*branch_id)
            .bind(*OrgId::knl().as_uuid())
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

/// Read one organization by id via the SECURITY DEFINER `platform_get_organization`
/// so the platform path sees the row regardless of the tenant GUC state.
async fn fetch_org_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
) -> Result<OrganizationSummary, ProvisioningError> {
    let row = sqlx::query(
        r#"
        SELECT id, slug, name, status, created_at, updated_at
        FROM platform_get_organization($1)
        "#,
    )
    .bind(org_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or(ProvisioningError::InvalidBootstrapCredential)?;

    Ok(OrganizationSummary {
        id: row.try_get("id")?,
        slug: row.try_get("slug")?,
        name: row.try_get("name")?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
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
    org: OrgId,
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

    // Stamp the credential with the caller-supplied tenant `org`. The caller
    // must arm the SAME org as `app.current_org` for the transaction so the row
    // passes the FORCE-RLS WITH CHECK on `auth_bootstrap_credentials` (KNL roster
    // import, a newly-onboarded org, or an admin-issued OTP).
    sqlx::query(
        r#"
        INSERT INTO auth_bootstrap_credentials (
            id, user_id, token_hash, issued_at, expires_at, org_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(credential_id)
    .bind(user_id)
    .bind(token_hash)
    .bind(now)
    .bind(expires_at)
    .bind(*org.as_uuid())
    .execute(tx.as_mut())
    .await?;

    Ok(Some(BootstrapCredentialIssue {
        credential_id,
        user_id,
        token,
        expires_at,
    }))
}

/// Seed the cold-start admin's bootstrap credential inside the caller's
/// transaction, if and only if it is needed.
///
/// Returns `Some((admin_id, credential_id))` when a credential was opened and
/// `None` when seeding was skipped (no cold-start admin row, the admin already
/// has a passkey or an open bootstrap credential, or the supplied OTP hash is
/// already in use by another row that cannot be revived). The admin row is locked
/// `FOR UPDATE` so concurrent boots serialize on it and cannot double-seed.
///
/// `token_hash` is globally UNIQUE on `auth_bootstrap_credentials`. On an
/// environment that ran migration 0021 and then 0023, a REVOKED row with the
/// fixed `coss0000` hash still exists; re-seeding the same OTP would collide. The
/// insert is therefore an UPSERT that REVIVES a previously revoked-OR-expired,
/// unconsumed row owned by this same admin (clearing `revoked_at`/`consumed_at`
/// and refreshing the expiry) instead of inserting a duplicate. A conflicting row
/// owned by a different user, one already consumed, or one still valid is left
/// untouched and seeding is reported as skipped.
async fn seed_cold_start_if_needed_tx(
    tx: &mut Transaction<'_, Postgres>,
    token_hash: &[u8],
    now: OffsetDateTime,
    ttl: Duration,
) -> Result<Option<(Uuid, Uuid)>, ProvisioningError> {
    let admin_id: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM users
        WHERE display_name = 'Cold Start Admin'
          AND roles @> ARRAY['SUPER_ADMIN']::TEXT[]
        ORDER BY id
        LIMIT 1
        FOR UPDATE
        "#,
    )
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(admin_id) = admin_id else {
        return Ok(None);
    };

    let passkey_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(admin_id)
            .fetch_one(tx.as_mut())
            .await?;
    if passkey_count > 0 {
        return Ok(None);
    }

    // Only a still-VALID (unexpired, unconsumed, unrevoked) credential blocks
    // re-seeding. An EXPIRED open row must not wedge cold-start forever: once the
    // short TTL lapses the operator needs a fresh window on the next boot, and the
    // UPSERT below revives that expired row.
    let existing_open: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM auth_bootstrap_credentials
        WHERE user_id = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > $2
        LIMIT 1
        "#,
    )
    .bind(admin_id)
    .bind(now)
    .fetch_optional(tx.as_mut())
    .await?;
    if existing_open.is_some() {
        return Ok(None);
    }

    let credential_id = Uuid::new_v4();
    let expires_at = now + ttl;
    // UPSERT on the globally-unique token_hash: a fresh OTP inserts; a previously
    // REVOKED, unconsumed row owned by THIS admin (e.g. the migration-0021/0023
    // coss0000 row) is revived. Any other conflict (different user, or consumed)
    // fails the WHERE, updates nothing, and returns no row -> reported as skipped.
    let opened_id: Option<Uuid> = sqlx::query_scalar(
        r#"
        INSERT INTO auth_bootstrap_credentials (
            id, user_id, token_hash, issued_at, expires_at, org_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (token_hash) DO UPDATE
            SET issued_at = EXCLUDED.issued_at,
                expires_at = EXCLUDED.expires_at,
                revoked_at = NULL,
                revoked_reason = NULL,
                consumed_at = NULL
            WHERE auth_bootstrap_credentials.user_id = EXCLUDED.user_id
              AND auth_bootstrap_credentials.consumed_at IS NULL
              AND (auth_bootstrap_credentials.revoked_at IS NOT NULL
                   OR auth_bootstrap_credentials.expires_at <= EXCLUDED.issued_at)
        RETURNING id
        "#,
    )
    .bind(credential_id)
    .bind(admin_id)
    .bind(token_hash)
    .bind(now)
    .bind(expires_at)
    // The platform admin lives in the platform sentinel org; the credential
    // carries it so the FORCE-RLS WITH CHECK (org_id = GUC) accepts the row.
    .bind(*OrgId::platform().as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;

    Ok(opened_id.map(|credential_id| (admin_id, credential_id)))
}

/// Resolve a bootstrap credential's tenant from its token hash, via the narrow
/// SECURITY DEFINER resolver `platform_resolve_bootstrap_org` (migration 0038).
///
/// `auth_bootstrap_credentials` is FORCE RLS, so the app's non-owner `mnt_rt`
/// role cannot read a credential row by hash until `app.current_org` is armed —
/// but the org is exactly what we need to arm it. This resolver returns ONLY the
/// org_id (nothing else), breaking that chicken-and-egg without widening any read
/// surface. Returns `None` for an unknown hash.
async fn resolve_bootstrap_org(
    tx: &mut Transaction<'_, Postgres>,
    token_hash: &[u8],
) -> Result<Option<Uuid>, ProvisioningError> {
    Ok(
        sqlx::query_scalar("SELECT platform_resolve_bootstrap_org($1)")
            .bind(token_hash)
            .fetch_one(tx.as_mut())
            .await?,
    )
}

async fn count_user_passkeys_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<i64, ProvisioningError> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(tx.as_mut())
            .await?,
    )
}

/// Admin-issued OTP length and alphabet.
///
/// 8 characters over a 72-symbol copy-paste-safe alphabet: A-Z, a-z, 0-9 and the
/// special set `!@#$%^&*-_`. That is 72^8 ≈ 2^49.3 of entropy. Eight characters
/// is the product's explicit choice; the brute-force guarantee therefore rests on
/// the per-client rate limit plus the short (default 24h, configurable) TTL and
/// single-use-on-success consume, NOT on the token length alone.
const OTP_LEN: usize = 8;
const OTP_ALPHABET: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_";

/// Generate a cryptographically-random 8-character OTP using rejection sampling
/// over [`OTP_ALPHABET`] so every symbol is equiprobable (no modulo bias).
fn generate_bootstrap_token() -> BootstrapToken {
    let alphabet_len = OTP_ALPHABET.len();
    // Largest multiple of the alphabet length that fits in a byte; bytes at or
    // above this are rejected to keep the distribution uniform.
    let limit = (256 / alphabet_len) * alphabet_len;
    let mut out = String::with_capacity(OTP_LEN);
    while out.len() < OTP_LEN {
        for &byte in fill_random().iter() {
            if (byte as usize) < limit {
                out.push(OTP_ALPHABET[byte as usize % alphabet_len] as char);
                if out.len() == OTP_LEN {
                    break;
                }
            }
        }
    }
    BootstrapToken(out)
}

/// 16 cryptographically-random bytes. `Uuid::new_v4` draws from the OS CSPRNG via
/// `getrandom`, so this reuses the project's existing randomness source without a
/// new dependency.
fn fill_random() -> [u8; 16] {
    *Uuid::new_v4().as_bytes()
}

fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}
