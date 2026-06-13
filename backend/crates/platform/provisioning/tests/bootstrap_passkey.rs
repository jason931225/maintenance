//! OTP first-sign-in (bootstrap credential) redemption tests.
//!
//! The OTP is a one-time SIGN-IN, not signup: the user row is pre-provisioned
//! by the admin (or seeded for the cold-start admin), and a successful redeem
//! consumes the credential atomically and resolves the owning user so the caller
//! can mint a session. There is deliberately NO per-OTP attempt cap (it would
//! enable a targeted lockout DoS); the controls are single-use-on-success, the
//! short configurable TTL, and the REST-layer rate limit.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_platform_provisioning::BootstrapCredentialStore;
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};

async fn seed_user(pool: &PgPool) -> uuid::Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (display_name, phone, roles) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind("Cold Start User")
    .bind("010-3000-0001")
    .bind(Vec::<String>::from(["MECHANIC".to_owned()]))
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

/// A correct redeem consumes the OTP atomically (single-use ON SUCCESS) and
/// resolves the pre-provisioned user; a second redeem of the same OTP fails.
#[sqlx::test(migrations = "../db/migrations")]
async fn redeem_consumes_otp_once_and_resolves_user(pool: PgPool) {
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
    assert!(consumed_at.is_some(), "OTP must be consumed on success");

    // Replay of the same OTP is rejected.
    let replay = store.redeem_otp(&pool, issue.token.as_str(), now).await;
    assert!(replay.is_err(), "a consumed OTP must not redeem again");
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
        "INSERT INTO users (display_name, phone, roles) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind("Expired OTP User")
    .bind("010-3000-0002")
    .bind(Vec::<String>::from(["MECHANIC".to_owned()]))
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

/// The cold-start fixed secret "coss0000" is seeded for the SUPER_ADMIN cold
/// admin, signs that admin in exactly once, and is dead afterwards.
#[sqlx::test(migrations = "../db/migrations")]
async fn cold_start_coss0000_signs_in_first_admin_once(pool: PgPool) {
    let store = BootstrapCredentialStore;
    let now = OffsetDateTime::now_utc();

    // The migration seeded a Cold Start Admin (SUPER_ADMIN) + the coss0000 OTP.
    let admin_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT id FROM users WHERE display_name = 'Cold Start Admin' AND roles @> ARRAY['SUPER_ADMIN']::text[]",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let redemption = store.redeem_otp(&pool, "coss0000", now).await.unwrap();
    assert_eq!(redemption.user_id, admin_id);
    assert!(redemption.requires_passkey_setup);

    // coss0000 is now dead.
    let replay = store.redeem_otp(&pool, "coss0000", now).await;
    assert!(replay.is_err(), "coss0000 must be single-use");
}
