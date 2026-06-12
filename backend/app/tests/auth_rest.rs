#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{BranchId, UserId};
use mnt_platform_provisioning::BootstrapCredentialStore;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;
use webauthn_authenticator_rs::prelude::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_rs::prelude::{CreationChallengeResponse, RequestChallengeResponse};

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";
const TEST_ORIGIN: &str = "https://auth.example.com";

#[derive(Debug, Deserialize)]
struct RegisterStartResponse {
    ceremony_id: Uuid,
    challenge: CreationChallengeResponse,
}

#[derive(Debug, Deserialize)]
struct LoginStartResponse {
    ceremony_id: Uuid,
    challenge: RequestChallengeResponse,
}

#[derive(Debug, Deserialize)]
struct TokenPairResponse {
    access_token: String,
    refresh_token: String,
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn passkey_http_flow_issues_tokens_and_refresh_reuse_revokes_family(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Auth Region", "Auth Branch").await;
    let user_id =
        seed_user_with_branch(&pool, "Auth User", "010-4000-0001", "ADMIN", branch_id).await;
    seed_equipment(&pool, branch_id, "290").await;

    let bootstrap = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            *user_id.as_uuid(),
            OffsetDateTime::now_utc(),
            Duration::minutes(30),
        )
        .await
        .unwrap();

    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));

    let registration: RegisterStartResponse = post_json(
        service.clone(),
        "/api/v1/auth/passkey/register/start",
        None,
        json!({
            "bootstrap_token": bootstrap.token.as_str(),
            "username": "auth.user",
            "display_name": "Auth User"
        }),
        StatusCode::OK,
    )
    .await;
    let credential = authenticator
        .do_registration(Url::parse(TEST_ORIGIN).unwrap(), registration.challenge)
        .unwrap();

    let _: Value = post_json(
        service.clone(),
        "/api/v1/auth/passkey/register/finish",
        None,
        json!({
            "ceremony_id": registration.ceremony_id,
            "credential": credential
        }),
        StatusCode::CREATED,
    )
    .await;

    let first_tokens = login(&service, &mut authenticator, *user_id.as_uuid()).await;
    let work_order: Value = post_json(
        service.clone(),
        "/api/work-orders",
        Some(&first_tokens.access_token),
        json!({
            "branch_id": branch_id,
            "management_no": "#290",
            "symptom": "Hydraulic oil leak"
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(work_order["status"], "RECEIVED");

    let rotated: TokenPairResponse = post_json(
        service.clone(),
        "/api/v1/auth/token/refresh",
        None,
        json!({ "refresh_token": first_tokens.refresh_token }),
        StatusCode::OK,
    )
    .await;
    assert_ne!(rotated.refresh_token, first_tokens.refresh_token);

    let reuse = post_raw(
        service.clone(),
        "/api/v1/auth/token/refresh",
        None,
        json!({ "refresh_token": first_tokens.refresh_token }),
    )
    .await;
    assert_eq!(reuse.status(), StatusCode::UNAUTHORIZED);

    let revoked_reuse_families: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM auth_refresh_token_families WHERE user_id = $1 AND revoked_reason = 'reuse_detected'",
    )
    .bind(*user_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(revoked_reuse_families, 1);

    let logout_tokens = login(&service, &mut authenticator, *user_id.as_uuid()).await;
    let logout = post_raw(
        service,
        "/api/v1/auth/logout",
        None,
        json!({ "refresh_token": logout_tokens.refresh_token }),
    )
    .await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);

    assert_audit_count(&pool, "auth.login", 2).await;
    assert_audit_count(&pool, "auth.refresh", 1).await;
    assert_audit_count(&pool, "auth.logout", 1).await;
}

async fn login(
    service: &axum::Router,
    authenticator: &mut WebauthnAuthenticator<SoftPasskey>,
    user_id: Uuid,
) -> TokenPairResponse {
    let start: LoginStartResponse = post_json(
        service.clone(),
        "/api/v1/auth/passkey/login/start",
        None,
        json!({ "user_id": user_id }),
        StatusCode::OK,
    )
    .await;
    let assertion = authenticator
        .do_authentication(Url::parse(TEST_ORIGIN).unwrap(), start.challenge)
        .unwrap();

    post_json(
        service.clone(),
        "/api/v1/auth/passkey/login/finish",
        None,
        json!({
            "ceremony_id": start.ceremony_id,
            "credential": assertion
        }),
        StatusCode::OK,
    )
    .await
}

async fn post_json<T>(
    service: axum::Router,
    uri: &str,
    bearer: Option<&str>,
    body: Value,
    expected: StatusCode,
) -> T
where
    T: for<'de> Deserialize<'de>,
{
    let response = post_raw(service, uri, bearer, body).await;
    assert_eq!(response.status(), expected);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn post_raw(
    service: axum::Router,
    uri: &str,
    bearer: Option<&str>,
    body: Value,
) -> http::Response<Body> {
    let mut builder = Request::builder()
        .uri(uri)
        .method("POST")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    service
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

fn app_state(
    pool: PgPool,
    private_key_pem: String,
    public_key_pem: String,
) -> Result<AppState, mnt_app::AppError> {
    let config = AppConfig::from_pairs([
        ("MNT_APP_ROLE", AppRole::Api.to_string()),
        ("MNT_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("MNT_JWT_ISSUER", TEST_ISSUER.to_owned()),
        ("MNT_JWT_AUDIENCE", TEST_AUDIENCE.to_owned()),
        ("MNT_JWT_PRIVATE_KEY_PEM", private_key_pem),
        ("MNT_JWT_PUBLIC_KEY_PEM", public_key_pem),
        ("MNT_WEBAUTHN_RP_ID", "example.com".to_owned()),
        ("MNT_WEBAUTHN_RP_ORIGIN", TEST_ORIGIN.to_owned()),
        ("MNT_WEBAUTHN_RP_NAME", "MNT Maintenance".to_owned()),
    ])?;

    AppState::new(config, DatabaseDependency::Postgres(pool))
}

async fn seed_branch(pool: &PgPool, region_name: &str, branch_name: &str) -> BranchId {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name) VALUES ($1) RETURNING id")
            .bind(region_name)
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO branches (region_id, name) VALUES ($1, $2) RETURNING id")
            .bind(region_id)
            .bind(branch_name)
            .fetch_one(pool)
            .await
            .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user_with_branch(
    pool: &PgPool,
    display_name: &str,
    phone: &str,
    role: &str,
    branch_id: BranchId,
) -> UserId {
    let user_id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, phone, roles) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(display_name)
        .bind(phone)
        .bind(Vec::from([role]))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    user_id
}

async fn seed_equipment(pool: &PgPool, branch_id: BranchId, management_no: &str) {
    let equipment_suffix = format!("{:0>4}", management_no);
    let customer_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name) VALUES ($1, $2) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(format!("Customer {management_no}"))
    .fetch_one(pool)
    .await
    .unwrap();
    let site_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, name) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(format!("Site {management_no}"))
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, model, source_sheet, source_row
        )
        VALUES ($1, $2, $3, $4, $5,
                'A', 'B', 'C', '임대', '좌식', '2.5', 'GTS25DE', 'test', 1)
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(format!("ABC12-{equipment_suffix}"))
    .bind(management_no)
    .execute(pool)
    .await
    .unwrap();
}

async fn assert_audit_count(pool: &PgPool, action: &str, expected: i64) {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = $1")
        .bind(action)
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(count, expected, "unexpected audit count for {action}");
}
