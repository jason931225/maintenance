//! Regression test for atomic single-use OTP redemption.
//!
//! A single OTP (bootstrap credential) authorizes EXACTLY ONE first sign-in. Two
//! concurrent `redeem_otp` calls for the same OTP must result in exactly one
//! success: the consume uses the harden-1 atomic single-use pattern
//! (`UPDATE ... WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now()
//! RETURNING`), so a racing or replayed redeem matches 0 rows and is rejected.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use mnt_platform_provisioning::BootstrapCredentialStore;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tokio::sync::Barrier;

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

/// One OTP, two concurrent redeems: exactly one wins; the credential ends up
/// consumed exactly once.
#[sqlx::test(migrations = "../db/migrations")]
async fn concurrent_redeem_consumes_otp_exactly_once(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = BootstrapCredentialStore;
    let now = OffsetDateTime::now_utc();

    let issue = store
        .issue_for_zero_credential_user(&pool, user_id, now, Duration::hours(24))
        .await
        .unwrap();

    let barrier = Arc::new(Barrier::new(2));
    let store_a = store;
    let store_b = store;
    let pool_a = pool.clone();
    let pool_b = pool.clone();
    let token_a = issue.token.as_str().to_owned();
    let token_b = issue.token.as_str().to_owned();
    let barrier_a = Arc::clone(&barrier);
    let barrier_b = Arc::clone(&barrier);

    let handle_a = tokio::spawn(async move {
        barrier_a.wait().await;
        store_a.redeem_otp(&pool_a, &token_a, now).await
    });
    let handle_b = tokio::spawn(async move {
        barrier_b.wait().await;
        store_b.redeem_otp(&pool_b, &token_b, now).await
    });

    let result_a = handle_a.await.unwrap();
    let result_b = handle_b.await.unwrap();

    let successes = [&result_a, &result_b].iter().filter(|r| r.is_ok()).count();
    assert_eq!(
        successes, 1,
        "exactly one concurrent OTP redeem must succeed (a={result_a:?}, b={result_b:?})"
    );

    let consumed_at: Option<OffsetDateTime> =
        sqlx::query_scalar("SELECT consumed_at FROM auth_bootstrap_credentials WHERE id = $1")
            .bind(issue.credential_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        consumed_at.is_some(),
        "the OTP must be consumed after the single successful redeem"
    );
}
