//! OTP first-sign-in (bootstrap credential) redemption tests.
//!
//! The OTP is a one-time SIGN-IN, not signup: the user row is pre-provisioned
//! by the admin (or seeded for the cold-start admin), and a successful redeem
//! consumes the credential atomically and resolves the owning user so the caller
//! can mint a session. There is deliberately NO per-OTP attempt cap (it would
//! enable a targeted lockout DoS); the controls are single-use-on-success, the
//! short configurable TTL, and the REST-layer rate limit.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_kernel_core::OrgId;
use mnt_platform_provisioning::BootstrapCredentialStore;
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};

async fn seed_user(pool: &PgPool) -> uuid::Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (display_name, phone, roles, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind("Cold Start User")
    .bind("010-3000-0001")
    .bind(Vec::<String>::from(["MECHANIC".to_owned()]))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Issued OTP format: exactly 8 characters over the documented alphanumeric +
/// special alphabet.
#[sqlx::test(migrations = "../db/migrations")]
async fn issued_otp_is_eight_char_alphanumeric_special(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let now = OffsetDateTime::now_utc();
    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(&pool, user_id, now, Duration::hours(24))
        .await
        .unwrap();

    let token = issue.token.as_str();
    assert_eq!(token.chars().count(), 8, "OTP must be exactly 8 characters");
    const ALLOWED: &str =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_";
    assert!(
        token.chars().all(|c| ALLOWED.contains(c)),
        "OTP must use only the documented alphabet, got {token:?}"
    );

    // The hash is stored, never the plaintext.
    let token_hash: Vec<u8> =
        sqlx::query("SELECT token_hash FROM auth_bootstrap_credentials WHERE id = $1")
            .bind(issue.credential_id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .try_get("token_hash")
            .unwrap();
    assert_ne!(token_hash, token.as_bytes());
}

/// A redeem VERIFIES the code and resolves the user but does NOT consume it, so a
/// failed enrollment can't lock the user out — the code stays usable until a passkey
/// is actually registered. consume_open_credentials_tx (driven by passkey
/// registration) is the single point of consumption; after it the code is dead.
#[sqlx::test(migrations = "../db/migrations")]
async fn redeem_verifies_without_consuming_then_registration_consumes(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = BootstrapCredentialStore;
    let now = OffsetDateTime::now_utc();

    let issue = store
        .issue_for_zero_credential_user(&pool, user_id, now, Duration::hours(24))
        .await
        .unwrap();

    let redemption = store
        .redeem_otp(&pool, issue.token.as_str(), now)
        .await
        .unwrap();
    assert_eq!(redemption.user_id, user_id);
    assert!(
        redemption.requires_passkey_setup,
        "a zero-passkey user must be flagged for passkey setup"
    );

    let consumed_at: Option<OffsetDateTime> =
        sqlx::query_scalar("SELECT consumed_at FROM auth_bootstrap_credentials WHERE id = $1")
            .bind(issue.credential_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(consumed_at.is_none(), "a redeem must NOT consume the code");

    // A second redeem before registration STILL succeeds (no lockout).
    assert!(
        store
            .redeem_otp(&pool, issue.token.as_str(), now)
            .await
            .is_ok(),
        "the code stays redeemable until a passkey is registered"
    );

    // Registration consumes it atomically (here exercised directly).
    let mut tx = pool.begin().await.unwrap();
    store
        .consume_open_credentials_tx(&mut tx, user_id, now)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let consumed_at: Option<OffsetDateTime> =
        sqlx::query_scalar("SELECT consumed_at FROM auth_bootstrap_credentials WHERE id = $1")
            .bind(issue.credential_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(consumed_at.is_some(), "registration consumes the code");

    // Once consumed, a redeem is rejected.
    assert!(
        store
            .redeem_otp(&pool, issue.token.as_str(), now)
            .await
            .is_err(),
        "a consumed code must not redeem again"
    );
}

/// A WRONG guess must NOT consume or invalidate a legitimate user's OTP: only a
/// correct redemption consumes it.
#[sqlx::test(migrations = "../db/migrations")]
async fn wrong_guess_does_not_consume_the_otp(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = BootstrapCredentialStore;
    let now = OffsetDateTime::now_utc();

    let issue = store
        .issue_for_zero_credential_user(&pool, user_id, now, Duration::hours(24))
        .await
        .unwrap();

    // Several wrong guesses.
    for guess in ["wrongone", "????????", "00000000"] {
        let result = store.redeem_otp(&pool, guess, now).await;
        assert!(result.is_err(), "a wrong guess must be rejected");
    }

    // The credential is still unconsumed and the real OTP still works.
    let consumed_at: Option<OffsetDateTime> =
        sqlx::query_scalar("SELECT consumed_at FROM auth_bootstrap_credentials WHERE id = $1")
            .bind(issue.credential_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        consumed_at.is_none(),
        "wrong guesses must not consume the OTP"
    );

    let redemption = store
        .redeem_otp(&pool, issue.token.as_str(), now)
        .await
        .unwrap();
    assert_eq!(redemption.user_id, user_id);
}

/// The default-24h OTP works inside its window and is rejected after expiry.
#[sqlx::test(migrations = "../db/migrations")]
async fn otp_expiry_is_enforced_on_redeem(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = BootstrapCredentialStore;
    let now = OffsetDateTime::now_utc();

    let issue = store
        .issue_for_zero_credential_user(&pool, user_id, now, Duration::hours(24))
        .await
        .unwrap();
    assert_eq!(issue.expires_at, now + Duration::hours(24));

    // Within the window (just before expiry): redeem succeeds.
    let within = issue.expires_at - Duration::minutes(1);
    let redemption = store
        .redeem_otp(&pool, issue.token.as_str(), within)
        .await
        .unwrap();
    assert_eq!(redemption.user_id, user_id);

    // A fresh OTP, redeemed after its expiry, is rejected.
    let user2 = sqlx::query_scalar::<_, uuid::Uuid>(
        "INSERT INTO users (display_name, phone, roles, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind("Expired OTP User")
    .bind("010-3000-0002")
    .bind(Vec::<String>::from(["MECHANIC".to_owned()]))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    let issue2 = store
        .issue_for_zero_credential_user(&pool, user2, now, Duration::hours(1))
        .await
        .unwrap();
    let after_expiry = issue2.expires_at + Duration::seconds(1);
    let expired = store
        .redeem_otp(&pool, issue2.token.as_str(), after_expiry)
        .await;
    assert!(expired.is_err(), "an expired OTP must be rejected");

    let consumed_at: Option<OffsetDateTime> =
        sqlx::query_scalar("SELECT consumed_at FROM auth_bootstrap_credentials WHERE id = $1")
            .bind(issue2.credential_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        consumed_at.is_none(),
        "an expired OTP must not be consumed by a redeem attempt"
    );
}

/// The cold-start OTP is no longer a committed constant: migration 0023 revoked
/// the fixed "coss0000" seed, so right after migrations there is NO open
/// cold-start credential. The OTP is now seeded at app boot via
/// `seed_cold_start_credential`. Once seeded it signs the cold admin in; a redeem
/// does not consume it (so a failed first-boot enrollment can't brick cold start);
/// it is consumed — and dead — once the admin registers a passkey.
#[sqlx::test(migrations = "../db/migrations")]
async fn cold_start_otp_seeded_at_boot_signs_in_then_dies_on_passkey_registration(pool: PgPool) {
    let store = BootstrapCredentialStore;
    let now = OffsetDateTime::now_utc();

    // The migration keeps the Cold Start Admin (SUPER_ADMIN) user row...
    let admin_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT id FROM users WHERE display_name = 'Cold Start Admin' AND roles @> ARRAY['SUPER_ADMIN']::text[]",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    // ...but the fixed seed is revoked: coss0000 must NOT redeem until re-seeded.
    assert!(
        store.redeem_otp(&pool, "coss0000", now).await.is_err(),
        "the committed coss0000 seed must be revoked by migration 0023"
    );

    // Boot-time seeding with the deploy-time secret.
    let seeded = store
        .seed_cold_start_credential(&pool, "coss0000", Duration::hours(1), now)
        .await
        .unwrap();
    assert!(
        seeded,
        "the cold admin has no passkey/open credential -> seeded"
    );

    let redemption = store.redeem_otp(&pool, "coss0000", now).await.unwrap();
    assert_eq!(redemption.user_id, admin_id);
    assert!(redemption.requires_passkey_setup);

    // Redeem does NOT consume — coss0000 stays usable until the admin enrolls a passkey.
    assert!(
        store.redeem_otp(&pool, "coss0000", now).await.is_ok(),
        "coss0000 stays redeemable until the admin registers a passkey"
    );

    // Passkey registration consumes it; afterwards it is dead.
    let mut tx = pool.begin().await.unwrap();
    store
        .consume_open_credentials_tx(&mut tx, admin_id, now)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(
        store.redeem_otp(&pool, "coss0000", now).await.is_err(),
        "coss0000 is dead once the admin has a passkey"
    );
}

/// `seed_cold_start_credential` is idempotent and gated: it seeds only when the
/// cold admin has neither a passkey nor an open credential, returns the seeded OTP
/// as redeemable, and skips (returns false) once a credential is already open or a
/// passkey exists.
#[sqlx::test(migrations = "../db/migrations")]
async fn seed_cold_start_credential_is_gated_and_idempotent(pool: PgPool) {
    let store = BootstrapCredentialStore;
    let now = OffsetDateTime::now_utc();

    let admin_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT id FROM users WHERE display_name = 'Cold Start Admin' AND roles @> ARRAY['SUPER_ADMIN']::text[]",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    // First seed succeeds (no passkey, no open credential after 0023's revoke).
    let first = store
        .seed_cold_start_credential(&pool, "secret-otp", Duration::hours(1), now)
        .await
        .unwrap();
    assert!(first, "first seed must insert a credential");

    // The seeded token redeems via redeem_otp for the cold admin.
    let redemption = store.redeem_otp(&pool, "secret-otp", now).await.unwrap();
    assert_eq!(redemption.user_id, admin_id);

    // A second seed is a no-op: an open credential already exists.
    let second = store
        .seed_cold_start_credential(&pool, "another-otp", Duration::hours(1), now)
        .await
        .unwrap();
    assert!(!second, "a second seed must skip when a credential is open");

    // The audit trail records exactly one coldstart seed and never the OTP value.
    let seed_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'auth.coldstart.seed'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(seed_audits, 1, "exactly one coldstart seed must be audited");
    let leaked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events \
         WHERE action = 'auth.coldstart.seed' AND after_snap::text LIKE '%secret-otp%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        leaked, 0,
        "the OTP value must never appear in the audit snapshot"
    );

    // Consume the open credential (simulating passkey registration), then a seed
    // still skips because the admin now has a passkey.
    let mut tx = pool.begin().await.unwrap();
    store
        .consume_open_credentials_tx(&mut tx, admin_id, now)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    // Give the admin a passkey so the no-passkey gate is exercised.
    sqlx::query(
        "INSERT INTO auth_webauthn_credentials \
         (user_id, credential_id, passkey_json, org_id) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(admin_id)
    .bind("cred-id")
    .bind(serde_json::json!({}))
    // The Cold Start Admin is the PLATFORM admin, re-homed to the platform
    // sentinel org by migration 0036; its passkey must carry that same org to
    // satisfy the (user_id, org_id) composite FK to `users`.
    .bind(*OrgId::platform().as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let third = store
        .seed_cold_start_credential(&pool, "third-otp", Duration::hours(1), now)
        .await
        .unwrap();
    assert!(!third, "a seed must skip once the admin has a passkey");
}

/// An EXPIRED open cold-start credential must not wedge cold-start: a later boot
/// re-seeds (revives the expired row) so the operator gets a fresh redeemable
/// window. Regression for the seeder's expiry-blind "open credential" gate.
#[sqlx::test(migrations = "../db/migrations")]
async fn seed_cold_start_credential_reseeds_after_expiry(pool: PgPool) {
    let store = BootstrapCredentialStore;
    let now = OffsetDateTime::now_utc();

    // Seed a short-lived credential.
    let first = store
        .seed_cold_start_credential(&pool, "expiring-otp", Duration::hours(1), now)
        .await
        .unwrap();
    assert!(first, "first seed must insert");

    // Past its TTL the same OTP no longer redeems.
    let later = now + Duration::hours(2);
    assert!(
        store
            .redeem_otp(&pool, "expiring-otp", later)
            .await
            .is_err(),
        "the credential must be expired at `later`"
    );

    // A boot at `later` must RE-SEED (revive the expired row), not skip.
    let reseeded = store
        .seed_cold_start_credential(&pool, "expiring-otp", Duration::hours(1), later)
        .await
        .unwrap();
    assert!(
        reseeded,
        "an expired open credential must not block re-seeding"
    );

    // ...and the refreshed credential redeems again at `later`.
    let redemption = store
        .redeem_otp(&pool, "expiring-otp", later)
        .await
        .unwrap();
    let admin_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT id FROM users WHERE display_name = 'Cold Start Admin' AND roles @> ARRAY['SUPER_ADMIN']::text[]",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(redemption.user_id, admin_id);
}
