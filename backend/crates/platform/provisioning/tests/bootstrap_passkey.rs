#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_platform_auth::{PasskeyService, WebauthnSettings};
use mnt_platform_provisioning::BootstrapCredentialStore;
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use url::Url;
use webauthn_authenticator_rs::prelude::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

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

#[sqlx::test(migrations = "../db/migrations")]
async fn bootstrap_credential_authorizes_one_passkey_enrollment_then_auto_revokes(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = BootstrapCredentialStore;
    let service = passkey_service();
    let now = OffsetDateTime::now_utc();

    let issue = store
        .issue_for_zero_credential_user(&pool, user_id, now, Duration::minutes(30))
        .await
        .unwrap();
    assert_eq!(issue.user_id, user_id);
    assert_eq!(issue.expires_at, now + Duration::minutes(30));
    assert!(issue.token.as_str().starts_with("mnt_boot_"));

    let token_storage = sqlx::query(
        "SELECT token_hash, consumed_at, revoked_at FROM auth_bootstrap_credentials WHERE id = $1",
    )
    .bind(issue.credential_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let token_hash: Vec<u8> = token_storage.try_get("token_hash").unwrap();
    let consumed_at: Option<OffsetDateTime> = token_storage.try_get("consumed_at").unwrap();
    let revoked_at: Option<OffsetDateTime> = token_storage.try_get("revoked_at").unwrap();
    assert_ne!(token_hash, issue.token.as_str().as_bytes());
    assert!(consumed_at.is_none());
    assert!(revoked_at.is_none());

    let registration = store
        .start_passkey_registration(
            &pool,
            &service,
            issue.token.as_str(),
            "cold.start.user".to_owned(),
            "Cold Start User".to_owned(),
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

    let passkey = store
        .finish_passkey_registration(&pool, &service, registration.ceremony_id, credential)
        .await
        .unwrap();
    assert_eq!(passkey.user_id, user_id);

    let after_finish =
        sqlx::query("SELECT consumed_at, revoked_at FROM auth_bootstrap_credentials WHERE id = $1")
            .bind(issue.credential_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let consumed_at: Option<OffsetDateTime> = after_finish.try_get("consumed_at").unwrap();
    let revoked_at: Option<OffsetDateTime> = after_finish.try_get("revoked_at").unwrap();
    assert!(consumed_at.is_some());
    assert!(revoked_at.is_none());

    let reuse = store
        .start_passkey_registration(
            &pool,
            &service,
            issue.token.as_str(),
            "cold.start.user".to_owned(),
            "Cold Start User".to_owned(),
        )
        .await
        .unwrap_err();
    assert!(
        reuse
            .to_string()
            .contains("bootstrap credential has already been used")
    );

    let passkey_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(passkey_count, 1);
}
