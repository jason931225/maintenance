#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_platform_auth::{
    AuthenticationStart, PasskeyRegistrationStart, PasskeyService, WebauthnSettings,
};
use sqlx::{PgPool, Row};
use time::Duration;
use url::Url;
use webauthn_authenticator_rs::prelude::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

async fn seed_user(pool: &PgPool) -> uuid::Uuid {
    sqlx::query_scalar("INSERT INTO users (display_name, roles) VALUES ($1, $2) RETURNING id")
        .bind("Passkey User")
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

#[sqlx::test(migrations = "../db/migrations")]
async fn passkey_registration_login_and_ceremony_state_are_persisted(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let service = service();

    let registration = service
        .start_registration(
            &pool,
            PasskeyRegistrationStart {
                user_id,
                username: "passkey.user".to_owned(),
                display_name: "Passkey User".to_owned(),
            },
        )
        .await
        .unwrap();

    let stored_state_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_ceremonies WHERE id = $1")
            .bind(registration.ceremony_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored_state_count, 1);

    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential = authenticator
        .do_registration(
            Url::parse("https://auth.example.com").unwrap(),
            registration.challenge,
        )
        .unwrap();

    let stored_passkey = service
        .finish_registration(&pool, registration.ceremony_id, credential)
        .await
        .unwrap();
    assert_eq!(stored_passkey.user_id, user_id);

    let consumed_at: Option<time::OffsetDateTime> =
        sqlx::query("SELECT consumed_at FROM auth_webauthn_ceremonies WHERE id = $1")
            .bind(registration.ceremony_id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .try_get("consumed_at")
            .unwrap();
    assert!(consumed_at.is_some());

    let authentication = service
        .start_authentication(&pool, AuthenticationStart { user_id })
        .await
        .unwrap();

    let assertion = authenticator
        .do_authentication(
            Url::parse("https://auth.example.com").unwrap(),
            authentication.challenge,
        )
        .unwrap();

    let outcome = service
        .finish_authentication(&pool, authentication.ceremony_id, assertion)
        .await
        .unwrap();
    assert_eq!(outcome.user_id, user_id);
    assert_eq!(outcome.passkey_id, stored_passkey.id);
}
