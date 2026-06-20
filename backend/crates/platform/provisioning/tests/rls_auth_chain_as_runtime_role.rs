#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! THE GATE for the pre-auth RLS fix (launch-blocking).
//!
//! An adversarial audit proved that under the prod runtime role `mnt_rt`
//! (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) the three pre-auth auth paths read/write
//! the FORCE-RLS org-scoped auth tables with `app.current_org` UNSET, so RLS
//! returns ZERO rows / rejects the WITH CHECK and the paths are broken in prod —
//! while the existing tests pass only because `sqlx::test` connects as a
//! BYPASSRLS superuser (masking the bug).
//!
//! This test runs the WHOLE auth chain as the genuine NON-OWNER `mnt_rt` role
//! (a dedicated pool whose every connection does `SET ROLE mnt_rt`), exactly like
//! production. It proves, as `mnt_rt`:
//!   * OTP redeem finds the seeded bootstrap credential and issues a session,
//!   * passkey registration-finish INSERTs with the correct org,
//!   * passkey login finds the credential and authenticates,
//!   * admin-issues-OTP for a NON-KNL tenant -> that tenant's user redeems it
//!     (cross-tenant new-account registration),
//!   * a cross-org credential is NOT visible (isolation preserved).
//!
//! It FAILS on the pre-fix code (GUC unset -> zero rows / WITH CHECK violation)
//! and PASSES after the fix (the narrow SECURITY DEFINER resolvers + per-path
//! set_config arm the tenant before each RLS-gated read/write).

use mnt_kernel_core::OrgId;
use mnt_platform_auth::{
    PasskeyRegistrationStart, PasskeyService, RefreshTokenStore, WebauthnSettings,
};
use mnt_platform_provisioning::{BootstrapCredentialStore, RosterProvisioner};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use url::Url;
use uuid::Uuid;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_authenticator_rs::prelude::RequestChallengeResponse;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

/// A second, non-KNL tenant id, to prove the cross-tenant paths.
const ORG_T2: Uuid = Uuid::from_u128(0x2222_2222_2222_2222_2222_2222_2222_2222);

/// Inject one `allowCredentials` entry into a discoverable challenge so the
/// SoftPasskey harness (no resident-key store) can locate its key. The SERVER
/// ceremony stays fully discoverable; the assertion still carries the credential
/// id the server resolves by. Mirrors the helper in the auth crate's tests.
fn inject_allow_credential(
    challenge: RequestChallengeResponse,
    credential_id: &str,
) -> RequestChallengeResponse {
    let mut value = serde_json::to_value(&challenge).unwrap();
    let allow = value
        .get_mut("publicKey")
        .and_then(|pk| pk.get_mut("allowCredentials"))
        .and_then(serde_json::Value::as_array_mut)
        .expect("discoverable challenge must have an allowCredentials array");
    allow.push(serde_json::json!({ "type": "public-key", "id": credential_id }));
    serde_json::from_value(value).unwrap()
}

fn passkey_service() -> PasskeyService {
    PasskeyService::new(WebauthnSettings {
        rp_id: "example.com".to_owned(),
        rp_origin: Url::parse("https://auth.example.com").unwrap(),
        rp_name: "MNT Maintenance".to_owned(),
        extra_allowed_origins: vec![],
        ceremony_ttl: Duration::minutes(5),
    })
    .unwrap()
}

/// Build a SECOND pool from the migrated `sqlx::test` pool's connection options,
/// whose every connection runs `SET ROLE mnt_rt` on checkout. Statements issued
/// through this pool therefore execute as the genuine non-owner RUNTIME role —
/// FORCE RLS applies and BYPASSRLS does not — exactly as production connects.
async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                // SET ROLE (session-scoped) makes every subsequent statement on
                // this connection run as `mnt_rt`. The connection started as the
                // superuser, so it has the privilege to assume the role.
                sqlx::query("SET ROLE mnt_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

/// Seed an `organizations` row + one user in it, as the OWNER (superuser) pool
/// with `row_security` off so the cross-org bootstrap rows go in regardless of
/// any GUC. Returns the new user's id.
async fn seed_org_and_user(owner_pool: &PgPool, org: Uuid, tag: &str) -> Uuid {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING")
        .bind(org)
        .bind(format!("org-{}", tag.to_lowercase()))
        .bind(format!("Org {tag}"))
        .execute(&mut *tx)
        .await
        .unwrap();
    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(format!("User {tag}"))
    .bind(vec!["MECHANIC".to_string()])
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    user_id
}

/// Seed an admin SUPER_ADMIN user in `org` (so admin-issued OTP authz passes).
/// Creates the `organizations` row first (idempotent) so the user FK is satisfied
/// even when this runs before [`seed_org_and_user`].
async fn seed_admin(owner_pool: &PgPool, org: Uuid, tag: &str) -> Uuid {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING")
        .bind(org)
        .bind(format!("org-{}", tag.to_lowercase()))
        .bind(format!("Org {tag}"))
        .execute(&mut *tx)
        .await
        .unwrap();
    let admin_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(format!("Admin {tag}"))
    .bind(vec!["SUPER_ADMIN".to_string()])
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    admin_id
}

/// Register a discoverable passkey for `user_id` in `org` as `mnt_rt`, returning
/// the stored credential id. Exercises start/finish registration (the
/// registration-finish INSERT is the org-stamped write the fix unblocks).
async fn register_passkey_as_runtime(
    service: &PasskeyService,
    rt_pool: &PgPool,
    org: OrgId,
    user_id: Uuid,
) -> (String, WebauthnAuthenticator<SoftPasskey>) {
    let registration = service
        .start_registration(
            rt_pool,
            org,
            PasskeyRegistrationStart {
                user_id,
                username: "rls.user".to_owned(),
                display_name: "RLS User".to_owned(),
            },
        )
        .await
        .expect("start_registration must succeed as mnt_rt");

    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential = authenticator
        .do_registration(
            Url::parse("https://auth.example.com").unwrap(),
            registration.challenge,
        )
        .unwrap();

    let stored = service
        .finish_registration(rt_pool, org, registration.ceremony_id, credential)
        .await
        .expect("finish_registration must INSERT the passkey as mnt_rt");
    assert_eq!(stored.user_id, user_id);

    // The credential row must carry the REAL org (the OrgId::knl() hardcode bug
    // would mis-stamp a non-KNL tenant). Verify as mnt_rt under the right GUC.
    let stamped_org = credential_org_as_runtime(rt_pool, org, &stored.credential_id).await;
    assert_eq!(
        stamped_org,
        Some(*org.as_uuid()),
        "passkey row must be stamped with the authenticated org, not a hardcoded one"
    );

    (stored.credential_id, authenticator)
}

/// Read a credential's org_id as `mnt_rt` with the GUC armed to `org`.
async fn credential_org_as_runtime(
    rt_pool: &PgPool,
    org: OrgId,
    credential_id: &str,
) -> Option<Uuid> {
    let mut tx = rt_pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let org_id: Option<Uuid> =
        sqlx::query_scalar("SELECT org_id FROM auth_webauthn_credentials WHERE credential_id = $1")
            .bind(credential_id)
            .fetch_optional(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    org_id
}

/// Issue an admin OTP for `user_id` in `org` via the provisioning store
/// (the admin path that hardcoded KNL + armed no GUC before the fix).
async fn issue_admin_otp_as_runtime(rt_pool: &PgPool, org: OrgId, user_id: Uuid) -> String {
    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            rt_pool,
            user_id,
            org,
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await
        .expect("admin OTP issuance must succeed for any tenant as mnt_rt");
    issue.token.as_str().to_owned()
}

// ===========================================================================
// (1) KNL: full chain — admin OTP -> redeem -> passkey register -> passkey login.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn knl_auth_chain_works_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let user_id = seed_org_and_user(&owner_pool, *knl.as_uuid(), "KNL").await;

    // Admin issues a one-time code for the pre-provisioned user (as mnt_rt).
    let otp = issue_admin_otp_as_runtime(&rt_pool, knl, user_id).await;

    // OTP first sign-in: redeem must FIND the bootstrap credential as mnt_rt.
    let redemption = BootstrapCredentialStore
        .redeem_otp(&rt_pool, &otp, OffsetDateTime::now_utc())
        .await
        .expect("OTP redeem must find the seeded credential as mnt_rt");
    assert_eq!(redemption.user_id, user_id);
    assert_eq!(redemption.org_id, knl);
    assert!(redemption.requires_passkey_setup);

    // The redeemed user can mint a session (refresh family issue is RLS-gated).
    RefreshTokenStore
        .issue_family(
            &rt_pool,
            user_id,
            knl,
            OffsetDateTime::now_utc(),
            Duration::days(30),
        )
        .await
        .expect("session mint (refresh family) must pass RLS as mnt_rt");

    // Passkey registration-finish INSERTs the credential with the correct org.
    let service = passkey_service();
    let (credential_id, mut authenticator) =
        register_passkey_as_runtime(&service, &rt_pool, knl, user_id).await;

    // Passkey LOGIN: usernameless discoverable auth must resolve the user FROM
    // the credential as mnt_rt and authenticate.
    let authentication = service
        .start_authentication(&rt_pool)
        .await
        .expect("start_authentication as mnt_rt");
    let challenge = inject_allow_credential(authentication.challenge, &credential_id);
    let assertion = authenticator
        .do_authentication(Url::parse("https://auth.example.com").unwrap(), challenge)
        .unwrap();
    let outcome = service
        .finish_authentication(&rt_pool, authentication.ceremony_id, assertion)
        .await
        .expect("passkey login must authenticate as mnt_rt");
    assert_eq!(outcome.user_id, user_id);
    assert_eq!(outcome.org_id, knl);
}

// ===========================================================================
// (2) NON-KNL tenant: admin-issues-OTP -> that tenant's user redeems it.
// Proves cross-tenant new-account registration works as mnt_rt (the KNL hardcode
// + no-GUC bug broke this for every tenant other than KNL).
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn non_knl_admin_otp_and_redeem_work_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org2 = OrgId::from_uuid(ORG_T2);
    let _admin = seed_admin(&owner_pool, ORG_T2, "T2").await;
    let user_id = seed_org_and_user(&owner_pool, ORG_T2, "T2").await;

    // Admin issues a one-time code for a NON-KNL tenant user (as mnt_rt). Before
    // the fix this either mis-stamped KNL or failed the WITH CHECK outright.
    let otp = issue_admin_otp_as_runtime(&rt_pool, org2, user_id).await;

    // The credential must be stamped with org2, not KNL.
    let stamped = bootstrap_org_as_runtime(&rt_pool, org2, &otp).await;
    assert_eq!(
        stamped,
        Some(ORG_T2),
        "admin-issued OTP must be stamped with the request's tenant, not KNL"
    );

    // That tenant's user redeems it and gets a session, all as mnt_rt.
    let redemption = BootstrapCredentialStore
        .redeem_otp(&rt_pool, &otp, OffsetDateTime::now_utc())
        .await
        .expect("non-KNL tenant OTP redeem must succeed as mnt_rt");
    assert_eq!(redemption.user_id, user_id);
    assert_eq!(redemption.org_id, org2);

    RefreshTokenStore
        .issue_family(
            &rt_pool,
            user_id,
            org2,
            OffsetDateTime::now_utc(),
            Duration::days(30),
        )
        .await
        .expect("non-KNL session mint must pass RLS as mnt_rt");
}

/// Read a bootstrap credential's org_id by its OTP, as `mnt_rt` with the GUC
/// armed to `org` (so the read is allowed and we can confirm the stamp).
async fn bootstrap_org_as_runtime(rt_pool: &PgPool, org: OrgId, otp: &str) -> Option<Uuid> {
    use sha2::{Digest, Sha256};
    let token_hash = Sha256::digest(otp.as_bytes()).to_vec();
    let mut tx = rt_pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let org_id: Option<Uuid> =
        sqlx::query_scalar("SELECT org_id FROM auth_bootstrap_credentials WHERE token_hash = $1")
            .bind(&token_hash)
            .fetch_optional(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    org_id
}

// ===========================================================================
// (3) Cross-org isolation: a passkey login for tenant A's credential must NOT
// leak tenant B, and an OTP from one tenant must redeem as ITS tenant only.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn cross_org_credential_is_isolated_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let org2 = OrgId::from_uuid(ORG_T2);

    let knl_user = seed_org_and_user(&owner_pool, *knl.as_uuid(), "KNL").await;
    let t2_user = seed_org_and_user(&owner_pool, ORG_T2, "T2").await;

    // Register a passkey in each tenant.
    let service = passkey_service();
    let (knl_cred, _) = register_passkey_as_runtime(&service, &rt_pool, knl, knl_user).await;
    let (t2_cred, _) = register_passkey_as_runtime(&service, &rt_pool, org2, t2_user).await;

    // KNL's credential is invisible to org2's GUC, and vice versa.
    assert_eq!(
        credential_org_as_runtime(&rt_pool, org2, &knl_cred).await,
        None,
        "KNL credential must be invisible under org2's tenant GUC"
    );
    assert_eq!(
        credential_org_as_runtime(&rt_pool, knl, &t2_cred).await,
        None,
        "org2 credential must be invisible under KNL's tenant GUC"
    );

    // But each is visible under its OWN tenant GUC.
    assert_eq!(
        credential_org_as_runtime(&rt_pool, knl, &knl_cred).await,
        Some(*knl.as_uuid())
    );
    assert_eq!(
        credential_org_as_runtime(&rt_pool, org2, &t2_cred).await,
        Some(ORG_T2)
    );
}

// ===========================================================================
// (4) Roster import (KNL) must also pass RLS as mnt_rt: it writes users +
// bootstrap credentials stamped KNL, so the GUC must be armed.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn roster_import_works_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    // The KNL org must exist for the FK on users.org_id.
    seed_org_and_user(&owner_pool, *OrgId::knl().as_uuid(), "KNL").await;
    // A region + branch are required for the roster's branch memberships.
    let (region, branch) = seed_region_branch(&owner_pool, *OrgId::knl().as_uuid()).await;

    let roster = serde_json::json!({
        "users": [{
            "display_name": "Roster User",
            "phone": "010-0000-0001",
            "team": "정비",
            "roles": ["MECHANIC"],
            "branches": [{ "region": region, "branch": branch }],
        }]
    })
    .to_string();

    let report = RosterProvisioner::new(Duration::hours(24))
        .import_json(&rt_pool, &roster, OffsetDateTime::now_utc())
        .await
        .expect("roster import must pass RLS as mnt_rt (GUC armed to KNL)");
    assert_eq!(report.users_created, 1);
    assert_eq!(report.bootstrap_credentials_issued.len(), 1);
}

/// Seed a region + branch (owner pool, row_security off) and return their names.
async fn seed_region_branch(owner_pool: &PgPool, org: Uuid) -> (String, String) {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let region_name = "수도권".to_owned();
    let branch_name = "Seed Branch".to_owned();
    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(&region_name)
            .bind(org)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    sqlx::query("INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3)")
        .bind(region_id)
        .bind(&branch_name)
        .bind(org)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    (region_name, branch_name)
}

/// Count `user_id`'s passkeys as `mnt_rt` with the GUC armed to `org`.
async fn passkey_count_as_runtime(rt_pool: &PgPool, org: OrgId, user_id: Uuid) -> i64 {
    let mut tx = rt_pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    count
}

// ===========================================================================
// (5) Admin credential RESET (account-recovery escape hatch): a user who already
// has a passkey gets it revoked AND a fresh OTP minted, atomically, as mnt_rt.
// The OLD passkey then no longer authenticates and the new OTP redeems + lets the
// user re-enroll. Proves the lockout the security trace found is recoverable.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn admin_credential_reset_revokes_passkey_and_issues_otp_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let user_id = seed_org_and_user(&owner_pool, *knl.as_uuid(), "KNL").await;

    // The user has a registered passkey (their only login method).
    let service = passkey_service();
    let (old_credential_id, mut old_authenticator) =
        register_passkey_as_runtime(&service, &rt_pool, knl, user_id).await;
    assert_eq!(passkey_count_as_runtime(&rt_pool, knl, user_id).await, 1);

    // The normal admin-OTP path REFUSES a user who already has a passkey — proving
    // the lockout: an admin cannot recover this user via the ordinary path.
    let blocked = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &rt_pool,
            user_id,
            knl,
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await;
    assert!(
        blocked.is_err(),
        "issue_for_zero_credential_user must reject a user that already has a passkey"
    );

    // The RESET escape hatch: revoke ALL passkeys + mint a fresh OTP atomically.
    let issue = BootstrapCredentialStore
        .reset_credentials_for_user(
            &rt_pool,
            user_id,
            knl,
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await
        .expect("admin credential reset must succeed as mnt_rt");

    // The user's passkeys are gone.
    assert_eq!(
        passkey_count_as_runtime(&rt_pool, knl, user_id).await,
        0,
        "reset must revoke every passkey for the user"
    );

    // The OLD passkey no longer authenticates: the credential row is gone, so the
    // usernameless discoverable login cannot resolve it.
    let authentication = service.start_authentication(&rt_pool).await.unwrap();
    let challenge = inject_allow_credential(authentication.challenge, &old_credential_id);
    let assertion = old_authenticator
        .do_authentication(Url::parse("https://auth.example.com").unwrap(), challenge)
        .unwrap();
    let login = service
        .finish_authentication(&rt_pool, authentication.ceremony_id, assertion)
        .await;
    assert!(
        login.is_err(),
        "the revoked passkey must no longer authenticate after a reset"
    );

    // The NEW OTP redeems for a first sign-in.
    let redemption = BootstrapCredentialStore
        .redeem_otp(&rt_pool, issue.token.as_str(), OffsetDateTime::now_utc())
        .await
        .expect("the freshly minted reset OTP must redeem as mnt_rt");
    assert_eq!(redemption.user_id, user_id);
    assert_eq!(redemption.org_id, knl);
    assert!(
        redemption.requires_passkey_setup,
        "after a reset the user has no passkey and must re-enroll"
    );

    // The user can RE-ENROLL a fresh passkey (the recovery completes).
    let (new_credential_id, _) =
        register_passkey_as_runtime(&service, &rt_pool, knl, user_id).await;
    assert_ne!(new_credential_id, old_credential_id);
    assert_eq!(passkey_count_as_runtime(&rt_pool, knl, user_id).await, 1);

    // An admin-reset audit row was written (auth.passkey.admin_reset) for the old
    // credential, proving the revoke is audited.
    let reset_audits = admin_reset_audit_count(&owner_pool, user_id).await;
    assert!(
        reset_audits >= 1,
        "the passkey revoke must be audited as auth.passkey.admin_reset"
    );
}

/// Count `auth.passkey.admin_reset` audit rows for `user_id` (owner pool, RLS off).
async fn admin_reset_audit_count(owner_pool: &PgPool, user_id: Uuid) -> i64 {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM audit_events
        WHERE action = 'auth.passkey.admin_reset'
          AND actor = $1
        "#,
    )
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    count
}

// ===========================================================================
// (6) Cross-org isolation for the reset: a reset issued under tenant A's GUC must
// NOT touch tenant B's user. As mnt_rt, a reset run with the WRONG tenant armed
// sees zero of the target's passkeys (RLS) and cannot revoke them — the escape
// hatch is tenant-scoped exactly like every other auth path.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn admin_credential_reset_is_tenant_scoped_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let org2 = OrgId::from_uuid(ORG_T2);

    // A user in tenant T2 with a passkey.
    let t2_user = seed_org_and_user(&owner_pool, ORG_T2, "T2").await;
    let service = passkey_service();
    let (t2_credential_id, _) =
        register_passkey_as_runtime(&service, &rt_pool, org2, t2_user).await;
    assert_eq!(passkey_count_as_runtime(&rt_pool, org2, t2_user).await, 1);

    // A reset run with the WRONG tenant (KNL) armed must NOT revoke T2's passkey:
    // under KNL's GUC the T2 passkey row is invisible (RLS), so the DELETE matches
    // zero rows. The reset would still mint a KNL-stamped OTP for the (KNL-invisible)
    // user id, but the cross-tenant DELETE is the security-critical assertion.
    let _ = BootstrapCredentialStore
        .reset_credentials_for_user(
            &rt_pool,
            t2_user,
            knl,
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await;

    // T2's passkey is untouched: a cross-org reset cannot revoke another tenant's
    // credential.
    assert_eq!(
        passkey_count_as_runtime(&rt_pool, org2, t2_user).await,
        1,
        "a reset armed to the wrong tenant must NOT revoke another org's passkey"
    );
    assert_eq!(
        credential_org_as_runtime(&rt_pool, org2, &t2_credential_id).await,
        Some(ORG_T2),
        "T2's credential must survive a cross-org reset attempt"
    );
}
