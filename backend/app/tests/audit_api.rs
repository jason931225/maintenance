#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{AuditAction, AuditEvent, BranchId, OrgId, TraceContext, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn admin_reads_only_branch_scoped_audits_and_read_access_is_audited(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let user_id = UserId::new();
    let branch_id = seed_branch(&pool, "Admin Region", "Admin Branch")
        .await
        .unwrap();
    let token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        user_id,
        vec!["ADMIN".to_owned()],
        vec![branch_id],
    )
    .unwrap();
    seed_user_with_branch(&pool, user_id, "ADMIN", branch_id)
        .await
        .unwrap();
    let other_branch = seed_branch(&pool, "Other Region", "Other Branch")
        .await
        .unwrap();
    insert_audit(&pool, Some(user_id), "work_order", "wo-in-scope", branch_id)
        .await
        .unwrap();
    insert_audit(
        &pool,
        Some(user_id),
        "work_order",
        "wo-out-of-scope",
        other_branch,
    )
    .await
    .unwrap();
    let service = build_router(app_state(pool.clone(), public_key_pem).unwrap());

    let response = service
        .oneshot(
            Request::builder()
                .uri("/api/audit?target_type=work_order&limit=10&offset=0")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    let items = json["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["target_id"], "wo-in-scope");
    assert_eq!(items[0]["branch_id"], branch_id.to_string());

    let read_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE actor = $1 AND action = 'audit.read'",
    )
    .bind(*user_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(read_count, 1);
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn mechanic_role_is_denied_audit_read(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Denied Region", "Denied Branch")
        .await
        .unwrap();
    let user_id = UserId::new();
    seed_user_with_branch(&pool, user_id, "MECHANIC", branch_id)
        .await
        .unwrap();
    let token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        user_id,
        vec!["MECHANIC".to_owned()],
        vec![branch_id],
    )
    .unwrap();
    let service = build_router(app_state(pool.clone(), public_key_pem).unwrap());

    let response = service
        .oneshot(
            Request::builder()
                .uri("/api/audit")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let read_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE actor = $1 AND action = 'audit.read'",
    )
    .bind(*user_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(read_count, 0);
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
        org_id: OrgId::knl(),
        roles,
        branches,
        platform: false,
        view_as: false,
        read_only: false,
        display_name: None,
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

async fn seed_branch(
    pool: &PgPool,
    region_name: &str,
    branch_name: &str,
) -> Result<BranchId, sqlx::Error> {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(region_name)
            .bind(*OrgId::knl().as_uuid())
            .fetch_one(pool)
            .await?;
    let branch_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(branch_name)
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await?;
    Ok(BranchId::from_uuid(branch_id))
}

async fn seed_user_with_branch(
    pool: &PgPool,
    user_id: UserId,
    role: &str,
    branch_id: BranchId,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("User {role}"))
        .bind(Vec::from([role]))
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await?;
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await?;
    Ok(())
}

async fn insert_audit(
    pool: &PgPool,
    actor: Option<UserId>,
    target_type: &str,
    target_id: &str,
    branch_id: BranchId,
) -> Result<(), Box<dyn std::error::Error>> {
    let event = AuditEvent::new(
        actor,
        AuditAction::new("work_order.view")?,
        target_type,
        target_id,
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_branch(branch_id);
    let actor_uuid = actor.map(|user_id| *user_id.as_uuid());
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            id, actor, action, target_type, target_id,
            branch_id, trace_id, span_id, occurred_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
    )
    .bind(*event.id.as_uuid())
    .bind(actor_uuid)
    .bind(event.action.as_str())
    .bind(event.target_type)
    .bind(event.target_id)
    .bind(*branch_id.as_uuid())
    .bind(event.trace.trace_id())
    .bind(event.trace.span_id())
    .bind(event.occurred_at)
    .execute(pool)
    .await?;
    Ok(())
}
