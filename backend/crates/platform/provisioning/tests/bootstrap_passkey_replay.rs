//! Regression test for atomic single-use bootstrap-credential consumption.
//!
//! A single bootstrap credential authorizes EXACTLY ONE passkey enrollment.
//! Two concurrent `finish_passkey_registration` calls for the same ceremony
//! must result in exactly one success: the passkey-registration commit and the
//! bootstrap-credential consume happen in ONE transaction, so a passkey can
//! never be created without atomically consuming the single-use credential.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use mnt_platform_auth::{PasskeyService, WebauthnSettings};
use mnt_platform_provisioning::BootstrapCredentialStore;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tokio::sync::Barrier;
use url::Url;
use webauthn_authenticator_rs::prelude::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

async fn seed_user(pool: &PgPool) -> uuid::Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (display_name, phone, roles) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind("Cold Start Replay User")
    .bind("010-3000-9999")
    .bind(Vec::<String>::from(["MECHANIC".to_owned()]))
    .fetch_one(pool)
    .await
    .unwrap()
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

/// One bootstrap credential, two concurrent finish_passkey_registration calls:
/// exactly one wins, and exactly one passkey row is written.
#[sqlx::test(migrations = "../db/migrations")]
async fn concurrent_bootstrap_finish_enrolls_exactly_one_passkey(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = BootstrapCredentialStore;
    let service = Arc::new(passkey_service());
    let now = OffsetDateTime::now_utc();

    let issue = store
        .issue_for_zero_credential_user(&pool, user_id, now, Duration::minutes(30))
        .await
        .unwrap();

    let registration = store
        .start_passkey_registration(
            &pool,
            &service,
            issue.token.as_str(),
            "cold.start.replay".to_owned(),
            "Cold Start Replay User".to_owned(),
        )
        .await
        .unwrap();
    let ceremony_id = registration.ceremony_id;

    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential = authenticator
        .do_registration(
            Url::parse("https://auth.example.com").unwrap(),
            registration.challenge,
        )
        .unwrap();

    let barrier = Arc::new(Barrier::new(2));
    let store_a = store;
    let store_b = store;
    let svc_a = Arc::clone(&service);
    let svc_b = Arc::clone(&service);
    let pool_a = pool.clone();
    let pool_b = pool.clone();
    let cred_a = credential.clone();
    let cred_b = credential.clone();
    let barrier_a = Arc::clone(&barrier);
    let barrier_b = Arc::clone(&barrier);

    let handle_a = tokio::spawn(async move {
        barrier_a.wait().await;
        store_a
            .finish_passkey_registration(&pool_a, &svc_a, ceremony_id, cred_a)
            .await
    });
    let handle_b = tokio::spawn(async move {
        barrier_b.wait().await;
        store_b
            .finish_passkey_registration(&pool_b, &svc_b, ceremony_id, cred_b)
            .await
    });

    let result_a = handle_a.await.unwrap();
    let result_b = handle_b.await.unwrap();

    let successes = [&result_a, &result_b].iter().filter(|r| r.is_ok()).count();
    assert_eq!(
        successes, 1,
        "exactly one concurrent bootstrap finish must succeed (a={result_a:?}, b={result_b:?})"
    );

    // Exactly one passkey row for the user.
    let passkey_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        passkey_count, 1,
        "one bootstrap credential must enroll exactly one passkey"
    );

    // Bootstrap credential must be consumed.
    let consumed_at: Option<OffsetDateTime> =
        sqlx::query_scalar("SELECT consumed_at FROM auth_bootstrap_credentials WHERE id = $1")
            .bind(issue.credential_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        consumed_at.is_some(),
        "bootstrap credential must be consumed after enrollment"
    );
}

/// A passkey must NEVER be committed unless the single-use bootstrap credential
/// is consumed in the SAME transaction.
///
/// We deterministically interleave a concurrent consume of the bootstrap
/// credential: a held transaction locks the credential row `FOR UPDATE`, then
/// `finish_passkey_registration` is invoked. On the unfixed code the passkey
/// registration commits in its own transaction first; only afterwards does the
/// bootstrap consume run, where it blocks on the lock. We then mark the
/// credential consumed and release the lock, so the consume guard
/// (`consumed_at IS NULL`) matches 0 rows and the call errors — leaving an
/// orphan passkey committed without the credential being consumed by THIS call.
///
/// With the fix (one transaction) the passkey INSERT and the bootstrap consume
/// share a transaction that rolls back entirely: the call errors AND no passkey
/// row exists.
#[sqlx::test(migrations = "../db/migrations")]
async fn bootstrap_finish_rolls_back_passkey_when_credential_consume_fails(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = BootstrapCredentialStore;
    let service = passkey_service();
    let now = OffsetDateTime::now_utc();

    let issue = store
        .issue_for_zero_credential_user(&pool, user_id, now, Duration::minutes(30))
        .await
        .unwrap();

    let registration = store
        .start_passkey_registration(
            &pool,
            &service,
            issue.token.as_str(),
            "cold.start.orphan".to_owned(),
            "Cold Start Replay User".to_owned(),
        )
        .await
        .unwrap();

    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential = authenticator
        .do_registration(
            Url::parse("https://auth.example.com").unwrap(),
            registration.challenge,
        )
        .unwrap();

    // Hold a lock on the bootstrap credential row in a separate transaction.
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM auth_bootstrap_credentials WHERE id = $1 FOR UPDATE")
        .bind(issue.credential_id)
        .fetch_one(blocker.as_mut())
        .await
        .unwrap();

    // Drive the enrollment concurrently; its bootstrap-consume UPDATE will block
    // on the lock above.
    let finish_pool = pool.clone();
    let finish_service = service.clone();
    let ceremony_id = registration.ceremony_id;
    let finish_handle = tokio::spawn(async move {
        let store = BootstrapCredentialStore;
        store
            .finish_passkey_registration(&finish_pool, &finish_service, ceremony_id, credential)
            .await
    });

    // Give the spawned task time to reach (and block on) the consume UPDATE.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // Mark the credential consumed, then release the lock so the blocked consume
    // guard now matches 0 rows.
    sqlx::query("UPDATE auth_bootstrap_credentials SET consumed_at = $1 WHERE id = $2")
        .bind(now)
        .bind(issue.credential_id)
        .execute(blocker.as_mut())
        .await
        .unwrap();
    blocker.commit().await.unwrap();

    let result = finish_handle.await.unwrap();
    assert!(
        result.is_err(),
        "finish must fail when the bootstrap credential cannot be consumed, got {result:?}"
    );

    // The passkey must NOT have been committed: no orphan enrollment.
    let passkey_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        passkey_count, 0,
        "a passkey must not be created without atomically consuming the bootstrap credential"
    );
}
