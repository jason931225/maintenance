#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Real `mnt_rt` coverage for People & Workforce employee creation.

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{OrgId, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";
const EMPLOYEES_PATH: &str = "/api/v1/employees";

struct Keys {
    private_pem: String,
    public_pem: String,
}
struct JsonResponse {
    status: StatusCode,
    json: Value,
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn employee_create_is_idempotent_unique_and_tenant_scoped(pool: PgPool) {
    let keys = keys();
    let org = OrgId::knl();
    let user = UserId::new();
    seed_user(&pool, org, user).await;
    let branch = seed_branch(&pool, org, "People test branch").await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&keys, org, user);
    let body = create_body(branch, "PEOPLE-001", "same-key", "010-1234-5678", "Kim");

    let (first, second) = tokio::join!(
        post(service.clone(), EMPLOYEES_PATH, &token, body.clone()),
        post(service.clone(), EMPLOYEES_PATH, &token, body),
    );
    assert!(
        [first.status, second.status].contains(&StatusCode::CREATED)
            && [first.status, second.status].contains(&StatusCode::OK),
        "same-key requests must produce one 201 and one replayed 200: {:?} / {:?}",
        first.json,
        second.json
    );
    let created = if first.status == StatusCode::CREATED {
        &first.json
    } else {
        &second.json
    };
    let employee_id = created["employee"]["id"].as_str().unwrap();
    assert_eq!(created["employment"]["phone_e164"], "+821012345678");
    let signoffs: Value = sqlx::query_scalar(
        "SELECT signoffs FROM employee_lifecycle_events WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(*org.as_uuid())
    .bind(Uuid::parse_str(employee_id).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        signoffs,
        json!({}),
        "employee creation must not fabricate acknowledgements"
    );
    for table in [
        "employees",
        "employee_employment_profiles",
        "employee_lifecycle_events",
        "employee_create_idempotency",
    ] {
        let count: i64 =
            sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE org_id = $1"))
                .bind(*org.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1, "same-key race must write exactly one {table} row");
    }

    let changed = post(
        service.clone(),
        EMPLOYEES_PATH,
        &token,
        create_body(branch, "PEOPLE-001", "same-key", "010-1234-5678", "Changed"),
    )
    .await;
    assert_eq!(changed.status, StatusCode::CONFLICT, "{:?}", changed.json);

    let duplicate = post(
        service.clone(),
        EMPLOYEES_PATH,
        &token,
        create_body(
            branch,
            "PEOPLE-001",
            "new-key",
            "010-1234-5678",
            "Duplicate",
        ),
    )
    .await;
    assert_eq!(
        duplicate.status,
        StatusCode::CONFLICT,
        "{:?}",
        duplicate.json
    );

    for (employee_number, key, base_pay, expected) in [
        ("PEOPLE-LOWER", "pay-lower", "0", "0.00"),
        (
            "PEOPLE-UPPER",
            "pay-upper",
            "999999999999.99",
            "999999999999.99",
        ),
    ] {
        let mut boundary = create_body(branch, employee_number, key, "010-1234-5678", "Pay bound");
        boundary["base_pay"] = json!(base_pay);
        let response = post(service.clone(), EMPLOYEES_PATH, &token, boundary).await;
        assert_eq!(response.status, StatusCode::CREATED, "{:?}", response.json);
        assert_eq!(response.json["employment"]["base_pay"], expected);
    }
    for (employee_number, key, base_pay) in [
        ("PEOPLE-SCALE", "pay-scale", "1.001"),
        ("PEOPLE-RANGE", "pay-range", "1000000000000"),
        ("PEOPLE-CANON", "pay-canon", "01.00"),
        ("PEOPLE-EXP", "pay-exp", "1e2"),
    ] {
        let mut invalid = create_body(branch, employee_number, key, "010-1234-5678", "Invalid pay");
        invalid["base_pay"] = json!(base_pay);
        let response = post(service.clone(), EMPLOYEES_PATH, &token, invalid).await;
        assert_eq!(
            response.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{:?}",
            response.json
        );
    }

    let other_org = OrgId::from_uuid(Uuid::new_v4());
    seed_org(&pool, other_org).await;
    let other_user = UserId::new();
    seed_user(&pool, other_org, other_user).await;
    let denied = get(
        service,
        &format!("{EMPLOYEES_PATH}/{employee_id}"),
        &bearer(&keys, other_org, other_user),
    )
    .await;
    assert_eq!(
        denied.status,
        StatusCode::NOT_FOUND,
        "cross-org detail must not be visible: {:?}",
        denied.json
    );
}

fn create_body(branch: Uuid, employee_number: &str, key: &str, phone: &str, name: &str) -> Value {
    json!({
        "employee_number": employee_number,
        "name": name,
        "company": "테스트 법인",
        "employment_type": "REGULAR",
        "phone": phone,
        "org_unit": "인사",
        "position": "사원",
        "site": "서울",
        "home_branch_id": branch,
        "base_pay": "50000000",
        "idempotency_key": key,
    })
}

async fn seed_org(pool: &PgPool, org: OrgId) {
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
        .bind(*org.as_uuid())
        .bind(format!("people-{}", org.as_uuid()))
        .bind("People test org")
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_user(pool: &PgPool, org: OrgId, user: UserId) {
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user.as_uuid())
        .bind("People administrator")
        .bind(vec!["ADMIN"])
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_branch(pool: &PgPool, org: OrgId, name: &str) -> Uuid {
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("{name} region"))
            .bind(*org.as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region)
    .bind(name)
    .bind(*org.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn post(service: axum::Router, uri: &str, token: &str, body: Value) -> JsonResponse {
    send(service, "POST", uri, token, Some(body)).await
}
async fn get(service: axum::Router, uri: &str, token: &str) -> JsonResponse {
    send(service, "GET", uri, token, None).await
}

async fn send(
    service: axum::Router,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> JsonResponse {
    let mut builder = Request::builder()
        .uri(uri)
        .method(method)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    let request = if let Some(body) = body {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        builder.body(Body::from(body.to_string())).unwrap()
    } else {
        builder.body(Body::empty()).unwrap()
    };
    let response = service.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    JsonResponse {
        status,
        json: serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
    }
}

fn keys() -> Keys {
    let signing_key = SigningKey::random(&mut OsRng);
    Keys {
        private_pem: signing_key
            .to_pkcs8_pem(LineEnding::LF)
            .unwrap()
            .to_string(),
        public_pem: signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    }
}

fn bearer(keys: &Keys, org: OrgId, user: UserId) -> String {
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.private_pem.as_bytes(),
        keys.public_pem.as_bytes(),
    )
    .unwrap();
    issuer
        .issue_access_token(AccessTokenInput {
            subject: user,
            org_id: org,
            roles: vec!["ADMIN".to_owned()],
            branches: Vec::new(),
            platform: false,
            view_as: false,
            read_only: false,
            display_name: None,
            feature_grants: Vec::new(),
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        })
        .unwrap()
}

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
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
