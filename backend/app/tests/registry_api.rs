#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{BranchId, EquipmentId, OrgId, UserId};
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
async fn substitutes_endpoint_is_branch_scoped_and_super_admin_can_expand(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch = seed_branch(&pool, "REST Substitute Region", "REST Substitute Branch").await;
    let other_branch = seed_branch(&pool, "REST Other Region", "REST Other Branch").await;
    let admin = seed_user_with_branch(&pool, "ADMIN", branch).await;
    let super_admin = UserId::new();
    let down = seed_equipment(
        &pool,
        branch,
        EquipmentFixture::new("CFO25-0290", "290", "임대", "좌식", "2.5T"),
    )
    .await;
    seed_equipment(
        &pool,
        branch,
        EquipmentFixture::new("DFO25-0106", "106", "예비", "좌식", "2.5T")
            .placement_location("REST Reserve Exact"),
    )
    .await;
    seed_equipment(
        &pool,
        branch,
        EquipmentFixture::new("CFO35-0075", "075", "예비", "좌식", "3.5T"),
    )
    .await;
    seed_equipment(
        &pool,
        other_branch,
        EquipmentFixture::new("DFO25-9106", "9106", "예비", "좌식", "2.5T")
            .placement_location("REST Other Branch"),
    )
    .await;

    let admin_token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        admin,
        vec!["ADMIN".to_owned()],
        vec![branch],
    )
    .unwrap();
    let super_token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        super_admin,
        vec!["SUPER_ADMIN".to_owned()],
        vec![],
    )
    .unwrap();
    let service = build_router(app_state(pool, public_key_pem).unwrap());

    let scoped = get_json(
        service.clone(),
        &format!("/api/v1/equipment/{down}/substitutes"),
        &admin_token,
    )
    .await;
    assert_eq!(scoped.status, StatusCode::OK, "{:?}", scoped.json);
    assert_eq!(
        equipment_numbers(&scoped.json),
        vec!["DFO25-0106", "CFO35-0075"]
    );
    assert_eq!(scoped.json["items"][0]["status"], "spare");
    assert_eq!(
        scoped.json["items"][0]["placement_location"],
        "REST Reserve Exact"
    );

    let forbidden = get_json(
        service.clone(),
        &format!("/api/v1/equipment/{down}/substitutes?all_branches=true"),
        &admin_token,
    )
    .await;
    assert_eq!(forbidden.status, StatusCode::FORBIDDEN);

    let expanded = get_json(
        service,
        &format!("/api/v1/equipment/{down}/substitutes?all_branches=true"),
        &super_token,
    )
    .await;
    assert_eq!(expanded.status, StatusCode::OK, "{:?}", expanded.json);
    assert_eq!(
        equipment_numbers(&expanded.json),
        vec!["DFO25-0106", "DFO25-9106", "CFO35-0075"]
    );
}

struct JsonResponse {
    status: StatusCode,
    json: Value,
}

async fn get_json(service: axum::Router, uri: &str, token: &str) -> JsonResponse {
    let response = service
        .oneshot(
            Request::builder()
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
    JsonResponse { status, json }
}

fn equipment_numbers(json: &Value) -> Vec<&str> {
    json["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["equipment_no"].as_str().unwrap())
        .collect()
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

#[derive(Debug, Clone)]
struct EquipmentFixture {
    equipment_no: &'static str,
    management_no: &'static str,
    status: &'static str,
    specification: &'static str,
    ton: &'static str,
    placement_location: Option<&'static str>,
}

impl EquipmentFixture {
    fn new(
        equipment_no: &'static str,
        management_no: &'static str,
        status: &'static str,
        specification: &'static str,
        ton: &'static str,
    ) -> Self {
        Self {
            equipment_no,
            management_no,
            status,
            specification,
            ton,
            placement_location: None,
        }
    }

    fn placement_location(mut self, placement_location: &'static str) -> Self {
        self.placement_location = Some(placement_location);
        self
    }
}

async fn seed_branch(pool: &PgPool, region_name: &str, branch_name: &str) -> BranchId {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(region_name)
            .bind(*OrgId::knl().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(branch_name)
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user_with_branch(pool: &PgPool, role: &str, branch_id: BranchId) -> UserId {
    let user_id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("Registry REST {role}"))
        .bind(Vec::from([role]))
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    user_id
}

async fn seed_equipment(
    pool: &PgPool,
    branch_id: BranchId,
    fixture: EquipmentFixture,
) -> EquipmentId {
    let customer_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO registry_customers (branch_id, name, org_id)
        VALUES ($1, 'K&L', $2)
        ON CONFLICT (branch_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    let site_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO registry_sites (branch_id, customer_id, name, org_id)
        VALUES ($1, $2, '케이앤엘', $3)
        ON CONFLICT (branch_id, customer_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    let ton_milli = ton_milli(fixture.ton);
    let equipment_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, power_label, status,
            placement_location, specification, ton_text, ton_milli,
            model, source_sheet, source_row, org_id
        )
        VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, 'test fixture', 1, $16
        )
        RETURNING id
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(fixture.equipment_no)
    .bind(fixture.management_no)
    .bind(&fixture.equipment_no[0..1])
    .bind(&fixture.equipment_no[1..2])
    .bind(&fixture.equipment_no[2..3])
    .bind(power_label(&fixture.equipment_no[2..3]))
    .bind(fixture.status)
    .bind(fixture.placement_location)
    .bind(fixture.specification)
    .bind(fixture.ton)
    .bind(ton_milli)
    .bind(format!("Model {}", fixture.management_no))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    EquipmentId::from_uuid(equipment_id)
}

fn ton_milli(ton: &str) -> Option<i32> {
    ton.strip_suffix('T')
        .and_then(|raw| raw.parse::<f64>().ok())
        .map(|tons| (tons * 1000.0).round() as i32)
}

fn power_label(power_code: &str) -> &'static str {
    match power_code {
        "B" => "전동",
        "O" => "디젤",
        _ => "기타",
    }
}
