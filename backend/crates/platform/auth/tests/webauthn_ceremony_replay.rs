//! Regression tests for atomic WebAuthn ceremony consumption.
//!
//! A WebAuthn ceremony is single-use. Two concurrent finish requests for one
//! ceremony must result in EXACTLY one committed success; any racing request
//! must be rejected because the consuming transaction claims the ceremony
//! atomically (`UPDATE ... WHERE consumed_at IS NULL ... RETURNING`). This
//! proves the auth replay/race (HIGH) finding is fixed — consumption is no
//! longer a read-then-write on the pool.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use mnt_platform_auth::{
    AuthenticationStart, PasskeyRegistrationStart, PasskeyService, WebauthnSettings,
};
use sqlx::PgPool;
use time::Duration;
use tokio::sync::Barrier;
use url::Url;
use webauthn_authenticator_rs::prelude::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

/// Number of times to replay the race. The unfixed (non-atomic) consume has a
/// window between the pool read and the unguarded UPDATE; iterating makes the
/// double-success deterministic rather than luck-dependent. The fixed code must
/// satisfy the single-success invariant on EVERY iteration.
const RACE_ITERATIONS: usize = 25;

async fn seed_user(pool: &PgPool) -> uuid::Uuid {
    sqlx::query_scalar("INSERT INTO users (display_name, roles) VALUES ($1, $2) RETURNING id")
        .bind("Replay Test User")
        .bind(Vec::<String>::from(["MECHANIC".to_owned()]))
        .fetch_one(pool)
        .await
        .unwrap()
}

fn service() -> PasskeyService {
    PasskeyService::new(WebauthnSettings {
        rp_id: "example.com".to_owned(),
        rp_origin: Url::parse("https://auth.example.com").unwrap(),
        rp_name: "MNT Maintenance".to_owned(),
        extra_allowed_origins: vec![],
        ceremony_ttl: Duration::minutes(5),
    })
    .unwrap()
}

/// Two concurrent `finish_registration` calls for the same ceremony and the
/// same credential: exactly one must succeed, and exactly one passkey row must
/// be written for the ceremony.
#[sqlx::test(migrations = "../db/migrations")]
async fn concurrent_finish_registration_consumes_ceremony_exactly_once(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let service = Arc::new(service());

    let registration = service
        .start_registration(
            &pool,
            PasskeyRegistrationStart {
                user_id,
                username: "replay.user".to_owned(),
                display_name: "Replay Test User".to_owned(),
            },
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
        svc_a
            .finish_registration(&pool_a, ceremony_id, cred_a)
            .await
    });
    let handle_b = tokio::spawn(async move {
        barrier_b.wait().await;
        svc_b
            .finish_registration(&pool_b, ceremony_id, cred_b)
            .await
    });

    let result_a = handle_a.await.unwrap();
    let result_b = handle_b.await.unwrap();

    let successes = [&result_a, &result_b].iter().filter(|r| r.is_ok()).count();
    assert_eq!(
        successes, 1,
        "exactly one concurrent finish_registration must succeed (a={result_a:?}, b={result_b:?})"
    );

    let passkey_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        passkey_count, 1,
        "exactly one passkey row must be written for one ceremony"
    );

    let consumed: Option<time::OffsetDateTime> =
        sqlx::query_scalar("SELECT consumed_at FROM auth_webauthn_ceremonies WHERE id = $1")
            .bind(ceremony_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(consumed.is_some(), "ceremony must be marked consumed");
}

/// Two concurrent `finish_authentication` calls for the same ceremony must
/// yield exactly one successful outcome (one token-pair-eligible result). The
/// authentication finish has no UNIQUE row to mask the race, so the unfixed
/// non-atomic consume lets BOTH callers succeed — a replay that mints two token
/// pairs from one ceremony. Repeating the race makes the defect deterministic.
#[sqlx::test(migrations = "../db/migrations")]
async fn concurrent_finish_authentication_consumes_ceremony_exactly_once(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let service = Arc::new(service());

    // Register a passkey once.
    let registration = service
        .start_registration(
            &pool,
            PasskeyRegistrationStart {
                user_id,
                username: "replay.user".to_owned(),
                display_name: "Replay Test User".to_owned(),
            },
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
    service
        .finish_registration(&pool, registration.ceremony_id, credential)
        .await
        .unwrap();

    for iteration in 0..RACE_ITERATIONS {
        let authentication = service
            .start_authentication(&pool, AuthenticationStart { user_id })
            .await
            .unwrap();
        let ceremony_id = authentication.ceremony_id;
        let assertion = authenticator
            .do_authentication(
                Url::parse("https://auth.example.com").unwrap(),
                authentication.challenge,
            )
            .unwrap();

        let barrier = Arc::new(Barrier::new(2));
        let svc_a = Arc::clone(&service);
        let svc_b = Arc::clone(&service);
        let pool_a = pool.clone();
        let pool_b = pool.clone();
        let assertion_a = assertion.clone();
        let assertion_b = assertion.clone();
        let barrier_a = Arc::clone(&barrier);
        let barrier_b = Arc::clone(&barrier);

        let handle_a = tokio::spawn(async move {
            barrier_a.wait().await;
            svc_a
                .finish_authentication(&pool_a, ceremony_id, assertion_a)
                .await
        });
        let handle_b = tokio::spawn(async move {
            barrier_b.wait().await;
            svc_b
                .finish_authentication(&pool_b, ceremony_id, assertion_b)
                .await
        });

        let result_a = handle_a.await.unwrap();
        let result_b = handle_b.await.unwrap();

        let successes = [&result_a, &result_b].iter().filter(|r| r.is_ok()).count();
        assert_eq!(
            successes, 1,
            "iteration {iteration}: exactly one concurrent finish_authentication must succeed \
             (a={result_a:?}, b={result_b:?})"
        );

        let consumed: Option<time::OffsetDateTime> =
            sqlx::query_scalar("SELECT consumed_at FROM auth_webauthn_ceremonies WHERE id = $1")
                .bind(ceremony_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            consumed.is_some(),
            "iteration {iteration}: ceremony must be marked consumed"
        );
    }
}
