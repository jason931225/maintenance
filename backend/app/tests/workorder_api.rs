#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{BranchId, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";

#[tokio::test]
async fn openapi_yaml_is_served() -> Result<(), Box<dyn std::error::Error>> {
    let config = AppConfig::from_pairs([
        ("MNT_APP_ROLE", AppRole::Api.to_string()),
        ("MNT_HTTP_ADDR", "127.0.0.1:0".to_owned()),
    ])?;
    let state = AppState::new(config, DatabaseDependency::NotConfigured)?;

    let response = build_router(state)
        .oneshot(
            Request::builder()
                .uri("/openapi/openapi.yaml")
                .body(Body::empty())?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    let text = String::from_utf8(body.to_vec())?;
    assert!(text.contains("/api/work-orders"));
    assert!(text.contains("bearerAuth"));
    Ok(())
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn workorder_create_is_jwt_authorized_and_branch_scoped(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let admin_id = UserId::new();
    let branch_id = seed_branch(&pool, "WO Region", "WO Branch").await;
    let other_branch_id = seed_branch(&pool, "Other WO Region", "Other WO Branch").await;
    seed_user_with_branch(&pool, admin_id, "ADMIN", branch_id).await;
    seed_equipment(&pool, branch_id, "290").await;
    seed_equipment(&pool, other_branch_id, "777").await;
    let token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        admin_id,
        vec!["ADMIN".to_owned()],
        vec![branch_id],
    )
    .unwrap();
    let service = build_router(app_state(pool.clone(), public_key_pem).unwrap());

    let forbidden = service
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/work-orders")
                .method("POST")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "branch_id": other_branch_id,
                        "management_no": "777",
                        "symptom": "Cross branch create"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    let response = service
        .oneshot(
            Request::builder()
                .uri("/api/work-orders")
                .method("POST")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "branch_id": branch_id,
                        "management_no": "#290",
                        "symptom": "Hydraulic oil leak"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["branch_id"], branch_id.to_string());
    assert_eq!(json["status"], "RECEIVED");
    assert!(json["request_no"].as_str().unwrap().ends_with("-001"));

    let create_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = 'work_order.create'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(create_count, 1);
}

fn issue_token(
    private_key_pem: &[u8],
    public_key_pem: &[u8],
    user_id: UserId,
    roles: Vec<String>,
    branches: Vec<BranchId>,
) -> Result<String, Box<dyn std::error::Error>> {
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        private_key_pem,
        public_key_pem,
    )?;

    Ok(issuer.issue_access_token(AccessTokenInput {
        subject: user_id,
        roles,
        branches,
        issued_at: OffsetDateTime::now_utc(),
    })?)
}

fn app_state(pool: PgPool, public_key_pem: String) -> Result<AppState, mnt_app::AppError> {
    let config = AppConfig::from_pairs([
        ("MNT_APP_ROLE", AppRole::Api.to_string()),
        ("MNT_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("MNT_JWT_ISSUER", TEST_ISSUER.to_owned()),
        ("MNT_JWT_AUDIENCE", TEST_AUDIENCE.to_owned()),
        ("MNT_JWT_PUBLIC_KEY_PEM", public_key_pem),
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

async fn seed_user_with_branch(pool: &PgPool, user_id: UserId, role: &str, branch_id: BranchId) {
    sqlx::query("INSERT INTO users (id, display_name, roles) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(format!("Workorder API {role}"))
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
