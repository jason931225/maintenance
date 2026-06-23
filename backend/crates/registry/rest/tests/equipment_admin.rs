//! Equipment admin REST tests: the master-list import endpoint must parse the
//! real reference workbook through the multipart surface, and the CRUD
//! endpoints must enforce `EquipmentManage` while routing every mutation through
//! the audited adapter.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_kernel_core::{AuditAction, AuditEvent, BranchId, OrgId, TraceContext, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_db::{DbError, with_audit};
use mnt_registry_adapter_postgres::PgRegistryStore;
use mnt_registry_rest::{RegistryRestState, router};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";
const BOUNDARY: &str = "----mnttestboundary7MA4YWxkTrZu0gW";

fn master_list_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../docs/reference/master-list_251120.xlsx")
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn import_endpoint_loads_reference_master_list(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let harness = Harness::new(&pool, "ADMIN").await;
        let bytes = std::fs::read(master_list_path()).unwrap();
        let body = multipart_xlsx(&bytes);

        let (status, json) = harness
            .send(
                "POST",
                "/api/v1/equipment/import",
                Some((format!("multipart/form-data; boundary={BOUNDARY}"), body)),
            )
            .await;

        assert_eq!(status, StatusCode::OK, "{json:?}");
        assert_eq!(json["added"], json!(445));
        assert_eq!(json["updated"], json!(0));
        assert_eq!(json["unchanged"], json!(0));
        assert_eq!(json["orphaned"], json!(0));
        assert_eq!(json["errors"].as_array().unwrap().len(), 0, "{json:?}");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM registry_equipment")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 445);

        let audited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events WHERE action = 'registry.import'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(audited, 1);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn import_endpoint_rejects_non_admin(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let harness = Harness::new(&pool, "MECHANIC").await;
        let bytes = std::fs::read(master_list_path()).unwrap();
        let body = multipart_xlsx(&bytes);

        let (status, _) = harness
            .send(
                "POST",
                "/api/v1/equipment/import",
                Some((format!("multipart/form-data; boundary={BOUNDARY}"), body)),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn equipment_crud_create_update_soft_delete_is_audited(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let harness = Harness::new(&pool, "ADMIN").await;

        let create_body = json!({
            "equipment_no": "CFO25-7777",
            "customer_name": "K&L",
            "site_name": "케이앤엘",
            "status": "rented",
            "specification": "좌식",
            "ton_text": "2.5T",
            "management_no": "777",
            "model": "GTS25DE",
            "vehicle_value": 50_000_000,
            "residual_value": 10_000_000
        });
        let (status, body) = harness
            .send("POST", "/api/v1/equipment", Some(json_body(&create_body)))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body:?}");
        let id = body["id"].as_str().unwrap().to_owned();

        // Persisted fields match.
        let created = fetch_equipment_view(&pool, &id).await;
        assert_eq!(created.status, "임대");
        assert_eq!(created.model.as_deref(), Some("GTS25DE"));
        assert_eq!(created.vehicle_value, Some(50_000_000));

        // Update: flip status to 예비 and clear the model.
        let update_body = json!({ "status": "spare", "model": null, "residual_value": 7_500_000 });
        let (status, _) = harness
            .send(
                "PATCH",
                &format!("/api/v1/equipment/{id}"),
                Some(json_body(&update_body)),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let updated = fetch_equipment_view(&pool, &id).await;
        assert_eq!(updated.status, "예비");
        assert_eq!(updated.model, None);
        assert_eq!(updated.residual_value, Some(7_500_000));
        // Acquisition cost is untouched by an unrelated update (distinct field).
        assert_eq!(updated.acquisition_cost_won, None);
        assert_eq!(updated.acquisition_date, None);

        // Set acquisition cost + date; vehicle_value must stay distinct/unchanged.
        let acq_body = json!({
            "acquisition_cost_won": 42_000_000,
            "acquisition_date": "2024-06-01"
        });
        let (status, _) = harness
            .send(
                "PATCH",
                &format!("/api/v1/equipment/{id}"),
                Some(json_body(&acq_body)),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let with_acq = fetch_equipment_view(&pool, &id).await;
        assert_eq!(with_acq.acquisition_cost_won, Some(42_000_000));
        assert_eq!(with_acq.acquisition_date.as_deref(), Some("2024-06-01"));
        assert_eq!(
            with_acq.vehicle_value,
            Some(50_000_000),
            "acquisition is a distinct fact; it must not touch vehicle_value"
        );

        // A negative acquisition cost is rejected by the DB CHECK (>= 0).
        let bad_body = json!({ "acquisition_cost_won": -1 });
        let (status, _) = harness
            .send(
                "PATCH",
                &format!("/api/v1/equipment/{id}"),
                Some(json_body(&bad_body)),
            )
            .await;
        assert_ne!(
            status,
            StatusCode::NO_CONTENT,
            "negative acquisition cost must be rejected"
        );

        // Clearing acquisition cost (explicit null) sets it back to NULL.
        let clear_body = json!({ "acquisition_cost_won": null });
        let (status, _) = harness
            .send(
                "PATCH",
                &format!("/api/v1/equipment/{id}"),
                Some(json_body(&clear_body)),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(
            fetch_equipment_view(&pool, &id).await.acquisition_cost_won,
            None
        );

        // Soft delete: marks 폐기, never removes the row.
        let (status, _) = harness
            .send("DELETE", &format!("/api/v1/equipment/{id}"), None)
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(fetch_equipment_view(&pool, &id).await.status, "폐기");

        // A second soft delete is a conflict.
        let (status, _) = harness
            .send("DELETE", &format!("/api/v1/equipment/{id}"), None)
            .await;
        assert_eq!(status, StatusCode::CONFLICT);

        // create/delete produced exactly one audit row each; the three
        // successful updates (status, acquisition set, acquisition clear) each
        // produced one — the rejected negative update produced none.
        assert_eq!(audit_count(&pool, "equipment.create").await, 1);
        assert_eq!(audit_count(&pool, "equipment.delete").await, 1);
        assert_eq!(
            audit_count(&pool, "equipment.update").await,
            3,
            "one audit row per successful update; the rejected negative update is not audited"
        );
    })
    .await;
}

#[derive(sqlx::FromRow)]
struct EquipmentView {
    status: String,
    model: Option<String>,
    vehicle_value: Option<i64>,
    residual_value: Option<i64>,
    acquisition_cost_won: Option<i64>,
    acquisition_date: Option<String>,
}

async fn fetch_equipment_view(pool: &PgPool, id: &str) -> EquipmentView {
    // acquisition_date is formatted to an ISO string in SQL so the row tuple
    // stays simple (no nested `time::Date`).
    let row: EquipmentView = sqlx::query_as(
        "SELECT status, model, vehicle_value, residual_value, acquisition_cost_won, \
                to_char(acquisition_date, 'YYYY-MM-DD') AS acquisition_date \
         FROM registry_equipment WHERE id = $1",
    )
    .bind(uuid::Uuid::parse_str(id).unwrap())
    .fetch_one(pool)
    .await
    .unwrap();
    row
}

async fn audit_count(pool: &PgPool, action: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = $1")
        .bind(action)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_equipment_rejects_non_admin(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let harness = Harness::new(&pool, "MECHANIC").await;
        let body = json!({
            "equipment_no": "CFO25-7778",
            "customer_name": "K&L",
            "site_name": "케이앤엘",
            "status": "rented",
            "specification": "좌식",
            "ton_text": "2.5T"
        });
        let (status, _) = harness
            .send("POST", "/api/v1/equipment", Some(json_body(&body)))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn substitute_assign_and_return_are_audited(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let harness = Harness::new(&pool, "ADMIN").await;
        let source = create_equipment(&harness, "CFO25-7777", "777").await;
        let substitute = create_equipment(&harness, "CFO25-8888", "888").await;

        // Assign the substitute (대차).
        let assign_body = json!({
            "source_equipment_id": source,
            "substitute_equipment_id": substitute,
            "assignment_location": "본사 정비고"
        });
        let (status, body) = harness
            .send(
                "POST",
                "/api/v1/equipment-substitutions",
                Some(json_body(&assign_body)),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body:?}");
        let substitution_id = body["id"].as_str().unwrap().to_owned();
        assert_eq!(body["source_equipment_id"].as_str().unwrap(), source);
        assert!(body["returned_at"].is_null());

        // A second assignment of the same pair conflicts (active substitution).
        let (status, _) = harness
            .send(
                "POST",
                "/api/v1/equipment-substitutions",
                Some(json_body(&assign_body)),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT);

        // Return it.
        let return_body = json!({ "return_note": "수리 완료" });
        let (status, body) = harness
            .send(
                "POST",
                &format!("/api/v1/equipment-substitutions/{substitution_id}/return"),
                Some(json_body(&return_body)),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body:?}");
        assert!(!body["returned_at"].is_null());

        // Returning again conflicts.
        let (status, _) = harness
            .send(
                "POST",
                &format!("/api/v1/equipment-substitutions/{substitution_id}/return"),
                Some(json_body(&return_body)),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT);

        assert_eq!(audit_count(&pool, "equipment.substitute.assign").await, 1);
        assert_eq!(audit_count(&pool, "equipment.substitute.return").await, 1);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn substitute_assign_rejects_non_admin(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let harness = Harness::new(&pool, "MECHANIC").await;
        let body = json!({
            "source_equipment_id": "00000000-0000-4000-8000-000000000001",
            "substitute_equipment_id": "00000000-0000-4000-8000-000000000002",
            "assignment_location": "본사"
        });
        let (status, _) = harness
            .send(
                "POST",
                "/api/v1/equipment-substitutions",
                Some(json_body(&body)),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_customer_and_site_appear_in_location_list_and_are_audited(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let harness = Harness::new(&pool, "ADMIN").await;

        // Create a customer.
        let (status, body) = harness
            .send(
                "POST",
                "/api/v1/customers",
                Some(json_body(&json!({ "name": "한울로지스" }))),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body:?}");
        let customer_id = body["id"].as_str().unwrap().to_owned();
        assert_eq!(body["name"].as_str().unwrap(), "한울로지스");

        // A same-name customer is a 409 conflict (explicit create, not a merge).
        let (status, _) = harness
            .send(
                "POST",
                "/api/v1/customers",
                Some(json_body(&json!({ "name": "한울로지스" }))),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT);

        // Create a site under that customer, with address + coordinates + contact.
        let site_body = json!({
            "customer_id": customer_id,
            "name": "안산1공장",
            "address": "경기도 안산시 단원구 1로 1",
            "province": "경기도",
            "city": "안산시",
            "postal_code": "15433",
            "latitude": 37.3219,
            "longitude": 126.8309,
            "geofence_radius_m": 200.0,
            "contact_name": "김현장",
            "contact_phone": "010-2625-0987",
            "contact_email": "site@example.com"
        });
        let (status, body) = harness
            .send("POST", "/api/v1/sites", Some(json_body(&site_body)))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body:?}");
        let site_id = body["id"].as_str().unwrap().to_owned();
        assert_eq!(body["customer_id"].as_str().unwrap(), customer_id);
        assert_eq!(body["name"].as_str().unwrap(), "안산1공장");
        assert_eq!(body["latitude"].as_f64().unwrap(), 37.3219);
        assert_eq!(body["contact_name"].as_str().unwrap(), "김현장");

        // A duplicate site name under the same customer is a 409 conflict.
        let (status, _) = harness
            .send("POST", "/api/v1/sites", Some(json_body(&site_body)))
            .await;
        assert_eq!(status, StatusCode::CONFLICT);

        // The new site is immediately visible in the by-location list.
        let (status, body) = harness
            .send("GET", "/api/v1/equipment-by-location", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body:?}");
        let found = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["site_id"].as_str() == Some(site_id.as_str()));
        assert!(found, "newly created site must appear in the location list");

        // Both creates were audited exactly once.
        assert_eq!(audit_count(&pool, "customer.create").await, 1);
        assert_eq!(audit_count(&pool, "site.create").await, 1);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_customer_rejects_non_admin(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let harness = Harness::new(&pool, "MECHANIC").await;
        let (status, _) = harness
            .send(
                "POST",
                "/api/v1/customers",
                Some(json_body(&json!({ "name": "거부고객" }))),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_customer_rejects_blank_name(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let harness = Harness::new(&pool, "ADMIN").await;
        let (status, _) = harness
            .send(
                "POST",
                "/api/v1/customers",
                Some(json_body(&json!({ "name": "   " }))),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_site_under_unknown_customer_is_not_found(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let harness = Harness::new(&pool, "ADMIN").await;
        let (status, _) = harness
            .send(
                "POST",
                "/api/v1/sites",
                Some(json_body(&json!({
                    "customer_id": "00000000-0000-4000-8000-000000000099",
                    "name": "유령현장"
                }))),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_site_rejects_one_sided_coordinate(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let harness = Harness::new(&pool, "ADMIN").await;
        let (status, body) = harness
            .send(
                "POST",
                "/api/v1/customers",
                Some(json_body(&json!({ "name": "좌표고객" }))),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body:?}");
        let customer_id = body["id"].as_str().unwrap().to_owned();

        // Latitude without longitude is rejected before the write (422).
        let (status, _) = harness
            .send(
                "POST",
                "/api/v1/sites",
                Some(json_body(&json!({
                    "customer_id": customer_id,
                    "name": "반쪽좌표현장",
                    "latitude": 37.5
                }))),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    })
    .await;
}

async fn create_equipment(harness: &Harness, equipment_no: &str, management_no: &str) -> String {
    let body = json!({
        "equipment_no": equipment_no,
        "customer_name": "K&L",
        "site_name": "케이앤엘",
        "status": "spare",
        "specification": "좌식",
        "ton_text": "2.5T",
        "management_no": management_no
    });
    let (status, body) = harness
        .send("POST", "/api/v1/equipment", Some(json_body(&body)))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    body["id"].as_str().unwrap().to_owned()
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Harness {
    service: Router,
    token: String,
}

impl Harness {
    async fn new(pool: &PgPool, role: &str) -> Self {
        let signing_key = SigningKey::random(&mut OsRng);
        let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let public_pem = signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();

        let branch = seed_branch(pool).await;
        let user = seed_user_in_branch(pool, role, branch).await;
        let token = issue_token(
            private_pem.as_bytes(),
            public_pem.as_bytes(),
            user,
            vec![role.to_owned()],
            vec![branch],
        );
        let verifier = JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            public_pem.as_bytes(),
        )
        .unwrap();
        let service = router(RegistryRestState::new(
            PgRegistryStore::new(pool.clone()),
            Some(verifier),
        ));
        Self { service, token }
    }

    async fn send(
        &self,
        method: &str,
        uri: &str,
        body: Option<(String, Vec<u8>)>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token));
        let request = match body {
            Some((content_type, bytes)) => builder
                .header(header::CONTENT_TYPE, content_type)
                .body(Body::from(bytes))
                .unwrap(),
            None => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                builder.body(Body::empty()).unwrap()
            }
        };
        let response = self.service.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, json)
    }
}

fn json_body(value: &Value) -> (String, Vec<u8>) {
    (
        "application/json".to_owned(),
        serde_json::to_vec(value).unwrap(),
    )
}

fn multipart_xlsx(bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"master-list.xlsx\"\r\n",
    );
    body.extend_from_slice(
        b"Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n",
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    body
}

fn issue_token(
    private_key_pem: &[u8],
    public_key_pem: &[u8],
    user_id: UserId,
    roles: Vec<String>,
    branches: Vec<BranchId>,
) -> String {
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        private_key_pem,
        public_key_pem,
    )
    .unwrap();
    issuer
        .issue_access_token(AccessTokenInput {
            subject: user_id,
            org_id: OrgId::knl(),
            roles,
            branches,
            platform: false,
            issued_at: OffsetDateTime::now_utc(),
        })
        .unwrap()
}

// Seed helpers route through `with_audit` because this file lives on a `rest/`
// handler surface scanned by the audit-coverage gate.
async fn seed_branch(pool: &PgPool) -> BranchId {
    let region_id = uuid::Uuid::new_v4();
    let branch_id = BranchId::new();
    let region_name = format!("Registry Admin Region {}", uuid::Uuid::new_v4());
    let branch_name = format!("Registry Admin Branch {}", uuid::Uuid::new_v4());
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_branch").unwrap(),
        "branch",
        branch_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_branch(branch_id);
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
                .bind(region_id)
                .bind(region_name)
                .bind(*OrgId::knl().as_uuid())
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
            sqlx::query(
                "INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(*branch_id.as_uuid())
            .bind(region_id)
            .bind(branch_name)
            .bind(*OrgId::knl().as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<BranchId, DbError>(branch_id)
        })
    })
    .await
    .unwrap()
}

async fn seed_user_in_branch(pool: &PgPool, role: &str, branch_id: BranchId) -> UserId {
    let user_id = UserId::new();
    let role = role.to_owned();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_user").unwrap(),
        "user",
        user_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_branch(branch_id);
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(*user_id.as_uuid())
            .bind(format!("Registry {role}"))
            .bind(Vec::from([role]))
            .bind(*OrgId::knl().as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            sqlx::query(
                "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)",
            )
            .bind(*user_id.as_uuid())
            .bind(*branch_id.as_uuid())
            .bind(*OrgId::knl().as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
    user_id
}
