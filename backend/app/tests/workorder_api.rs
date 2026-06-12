#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{BranchId, UserId, WorkOrderId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::format_description::well_known::Rfc3339;
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

    let messenger_thread_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM messenger_threads t
        JOIN messenger_thread_members tm ON tm.thread_id = t.id
        WHERE t.work_order_id = $1
          AND t.kind = 'work_order'
          AND tm.user_id = $2
        "#,
    )
    .bind(uuid::Uuid::parse_str(json["id"].as_str().unwrap()).unwrap())
    .bind(*admin_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(messenger_thread_count, 1);
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn workorder_read_surface_is_branch_scoped_filterable_and_detailed(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Read Region", "Read Branch").await;
    let other_branch_id = seed_branch(&pool, "Read Other Region", "Read Other Branch").await;
    let mechanic = UserId::new();
    let receptionist = UserId::new();
    let admin = UserId::new();
    seed_user_with_branch(&pool, mechanic, "MECHANIC", branch_id).await;
    seed_user_with_branch(&pool, receptionist, "RECEPTIONIST", branch_id).await;
    seed_user_with_branch(&pool, admin, "ADMIN", branch_id).await;
    let equipment_290 = seed_equipment_record(&pool, branch_id, "290", "GTS25DE").await;
    let equipment_291 = seed_equipment_record(&pool, branch_id, "291", "GTS30DE").await;
    let other_equipment = seed_equipment_record(&pool, other_branch_id, "777", "OTHER").await;
    let due_anchor = OffsetDateTime::now_utc();

    let p1 = seed_read_work_order(
        &pool,
        ReadWorkOrderFixture {
            branch_id,
            equipment: equipment_290,
            receptionist,
            mechanic,
            request_no: "20260612-901",
            priority: "P1",
            target_due_at: due_anchor + Duration::hours(6),
        },
    )
    .await;
    let p2 = seed_read_work_order(
        &pool,
        ReadWorkOrderFixture {
            branch_id,
            equipment: equipment_291,
            receptionist,
            mechanic,
            request_no: "20260612-902",
            priority: "P2",
            target_due_at: due_anchor + Duration::hours(2),
        },
    )
    .await;
    let hidden = seed_read_work_order(
        &pool,
        ReadWorkOrderFixture {
            branch_id: other_branch_id,
            equipment: other_equipment,
            receptionist,
            mechanic,
            request_no: "20260612-903",
            priority: "P1",
            target_due_at: due_anchor + Duration::hours(1),
        },
    )
    .await;
    assert_ne!(hidden, p1);

    let token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        mechanic,
        vec!["MECHANIC".to_owned()],
        vec![branch_id],
    )
    .unwrap();
    let service = build_router(app_state(pool.clone(), public_key_pem).unwrap());

    let first_page = get_json(
        service.clone(),
        "/api/v1/work-orders?status=ASSIGNED&assigned_to=me&limit=1&offset=0",
        &token,
    )
    .await;
    assert_eq!(first_page.status, StatusCode::OK, "{:?}", first_page.json);
    assert_eq!(first_page.json["total"], 2);
    assert_eq!(first_page.json["items"].as_array().unwrap().len(), 1);
    assert_eq!(first_page.json["items"][0]["id"], p1.to_string());
    assert_eq!(first_page.json["items"][0]["priority"], "P1");

    let second_page = get_json(
        service.clone(),
        "/api/v1/work-orders?status=ASSIGNED&assigned_to=me&limit=1&offset=1",
        &token,
    )
    .await;
    assert_eq!(second_page.status, StatusCode::OK, "{:?}", second_page.json);
    assert_eq!(second_page.json["items"][0]["id"], p2.to_string());

    let filtered = get_json(
        service.clone(),
        "/api/v1/work-orders?status=ASSIGNED&priority=P2&assigned_to=me&limit=10&offset=0",
        &token,
    )
    .await;
    assert_eq!(filtered.status, StatusCode::OK, "{:?}", filtered.json);
    assert_eq!(filtered.json["total"], 1);
    assert_eq!(filtered.json["items"][0]["id"], p2.to_string());

    let customer_site_filtered = get_json(
        service.clone(),
        &format!(
            "/api/v1/work-orders?customer_id={}&site_id={}&limit=10&offset=0",
            equipment_290.customer_id, equipment_290.site_id
        ),
        &token,
    )
    .await;
    assert_eq!(
        customer_site_filtered.status,
        StatusCode::OK,
        "{:?}",
        customer_site_filtered.json
    );
    assert_eq!(customer_site_filtered.json["total"], 1);
    assert_eq!(
        customer_site_filtered.json["items"][0]["id"],
        p1.to_string()
    );

    let target_due_from = (due_anchor + Duration::hours(5)).format(&Rfc3339).unwrap();
    let target_due_to = (due_anchor + Duration::hours(7)).format(&Rfc3339).unwrap();
    let target_due_filtered = get_json(
        service.clone(),
        &format!(
            "/api/v1/work-orders?target_due_from={target_due_from}&target_due_to={target_due_to}&limit=10&offset=0"
        ),
        &token,
    )
    .await;
    assert_eq!(
        target_due_filtered.status,
        StatusCode::OK,
        "{:?}",
        target_due_filtered.json
    );
    assert_eq!(target_due_filtered.json["total"], 1);
    assert_eq!(target_due_filtered.json["items"][0]["id"], p1.to_string());

    let detail = get_json(
        service.clone(),
        &format!("/api/v1/work-orders/{p1}"),
        &token,
    )
    .await;
    assert_eq!(detail.status, StatusCode::OK, "{:?}", detail.json);
    assert_eq!(detail.json["id"], p1.to_string());
    assert_eq!(detail.json["equipment"]["management_no"], "290");
    assert_eq!(detail.json["equipment"]["model"], "GTS25DE");
    assert_eq!(detail.json["assignments"].as_array().unwrap().len(), 1);
    assert_eq!(detail.json["approval_line"].as_array().unwrap().len(), 3);
    assert!(!detail.json["status_history"].as_array().unwrap().is_empty());
    assert_eq!(detail.json["evidence"].as_array().unwrap().len(), 1);

    let cross_branch_detail =
        get_json(service, &format!("/api/v1/work-orders/{hidden}"), &token).await;
    assert_eq!(cross_branch_detail.status, StatusCode::NOT_FOUND);
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn kpi_endpoint_is_jwt_authorized_and_branch_scoped(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "KPI Region", "KPI Branch").await;
    let other_branch_id = seed_branch(&pool, "KPI Other Region", "KPI Other Branch").await;
    let admin = UserId::new();
    let mechanic = UserId::new();
    seed_user_with_branch(&pool, admin, "ADMIN", branch_id).await;
    seed_user_with_branch(&pool, mechanic, "MECHANIC", branch_id).await;
    let equipment = seed_equipment_record(&pool, branch_id, "290", "GTS25DE").await;
    let other_equipment = seed_equipment_record(&pool, other_branch_id, "777", "OTHER").await;
    let created_at = OffsetDateTime::parse("2026-06-12T08:00:00Z", &Rfc3339).unwrap();
    seed_kpi_completed_work_order(
        &pool,
        KpiWorkOrderFixture {
            branch_id,
            equipment,
            actor: admin,
            mechanic,
            request_no: "20260612-950",
            priority: "P1",
            created_at,
            approved_at: created_at + Duration::hours(8),
        },
    )
    .await;
    seed_kpi_completed_work_order(
        &pool,
        KpiWorkOrderFixture {
            branch_id: other_branch_id,
            equipment: other_equipment,
            actor: admin,
            mechanic,
            request_no: "20260612-951",
            priority: "P2",
            created_at,
            approved_at: created_at + Duration::hours(9),
        },
    )
    .await;

    let admin_token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        admin,
        vec!["ADMIN".to_owned()],
        vec![branch_id],
    )
    .unwrap();
    let mechanic_token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        mechanic,
        vec!["MECHANIC".to_owned()],
        vec![branch_id],
    )
    .unwrap();
    let service = build_router(app_state(pool, public_key_pem).unwrap());

    let denied = get_json(
        service.clone(),
        "/api/v1/kpi?period=2026-06-01..2026-07-01&scope=company",
        &mechanic_token,
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN, "{:?}", denied.json);

    let report = get_json(
        service,
        "/api/v1/kpi?period=2026-06-01..2026-07-01&scope=company",
        &admin_token,
    )
    .await;
    assert_eq!(report.status, StatusCode::OK, "{:?}", report.json);
    let company = report.json["rollups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|rollup| rollup["scope"]["kind"] == "company")
        .unwrap();
    assert_eq!(company["completed_count"], 1);
    assert_eq!(company["weighted_completed_points"], 3);
    assert_eq!(
        report.json["rollups"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|rollup| rollup["scope"]["kind"] == "branch")
            .count(),
        1
    );
    assert_eq!(company["inspection_schedule_due_count"], 0);
    assert_eq!(company["inspection_schedule_completed_count"], 0);
    assert_eq!(
        company["inspection_plan_completion_bps"],
        serde_json::Value::Null
    );
    assert!(
        !report.json["unavailable_metrics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|metric| metric["metric"] == "inspection_plan_completion_rate")
    );
    assert!(
        report.json["unavailable_metrics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|metric| metric["metric"] == "p1_acceptance_rate")
    );
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn equipment_lookup_and_autocomplete_are_branch_scoped(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Equipment Region", "Equipment Branch").await;
    let other_branch_id = seed_branch(&pool, "Equipment Other Region", "Equipment Other").await;
    let receptionist = UserId::new();
    seed_user_with_branch(&pool, receptionist, "RECEPTIONIST", branch_id).await;
    seed_equipment_record(&pool, branch_id, "290", "GTS25DE").await;
    seed_equipment_record(&pool, branch_id, "291", "GTS30DE").await;
    seed_equipment_record(&pool, other_branch_id, "290", "SHOULD_NOT_LEAK").await;
    let token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        receptionist,
        vec!["RECEPTIONIST".to_owned()],
        vec![branch_id],
    )
    .unwrap();
    let service = build_router(app_state(pool, public_key_pem).unwrap());

    let lookup = get_json(
        service.clone(),
        "/api/v1/equipment/lookup?management_no=%23290",
        &token,
    )
    .await;
    assert_eq!(lookup.status, StatusCode::OK, "{:?}", lookup.json);
    assert_eq!(lookup.json["management_no"], "290");
    assert_eq!(lookup.json["model"], "GTS25DE");
    assert_eq!(lookup.json["customer"]["name"], "Customer 290");
    assert_eq!(lookup.json["site"]["name"], "Site 290");

    let autocomplete = get_json(service, "/api/v1/equipment?q=29&limit=10", &token).await;
    assert_eq!(
        autocomplete.status,
        StatusCode::OK,
        "{:?}",
        autocomplete.json
    );
    let models = autocomplete.json["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["model"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(models, vec!["GTS25DE", "GTS30DE"]);
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn reject_with_memo_is_admin_only_and_audited(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Reject Region", "Reject Branch").await;
    let mechanic = UserId::new();
    let receptionist = UserId::new();
    let admin = UserId::new();
    seed_user_with_branch(&pool, mechanic, "MECHANIC", branch_id).await;
    seed_user_with_branch(&pool, receptionist, "RECEPTIONIST", branch_id).await;
    seed_user_with_branch(&pool, admin, "ADMIN", branch_id).await;
    let equipment = seed_equipment_record(&pool, branch_id, "290", "GTS25DE").await;
    let work_order_id =
        seed_received_work_order(&pool, branch_id, equipment, receptionist, "20260612-904").await;
    let mechanic_token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        mechanic,
        vec!["MECHANIC".to_owned()],
        vec![branch_id],
    )
    .unwrap();
    let admin_token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        admin,
        vec!["ADMIN".to_owned()],
        vec![branch_id],
    )
    .unwrap();
    let service = build_router(app_state(pool.clone(), public_key_pem).unwrap());

    let denied = post_json(
        service.clone(),
        &format!("/api/v1/work-orders/{work_order_id}/reject"),
        &mechanic_token,
        json!({ "memo": "not allowed" }),
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN, "{:?}", denied.json);

    let missing_memo = post_json(
        service.clone(),
        &format!("/api/v1/work-orders/{work_order_id}/reject"),
        &admin_token,
        json!({ "memo": "   " }),
    )
    .await;
    assert_eq!(
        missing_memo.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        missing_memo.json
    );
    let status_after_missing_memo: String =
        sqlx::query_scalar("SELECT status FROM work_orders WHERE id = $1")
            .bind(*work_order_id.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status_after_missing_memo, "RECEIVED");
    let reject_audit_count_before_success: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'work_order.reject' AND target_id = $1",
    )
    .bind(work_order_id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reject_audit_count_before_success, 0);

    let rejected = post_json(
        service,
        &format!("/api/v1/work-orders/{work_order_id}/reject"),
        &admin_token,
        json!({ "memo": "Duplicate request from customer" }),
    )
    .await;
    assert_eq!(rejected.status, StatusCode::OK, "{:?}", rejected.json);
    assert_eq!(rejected.json["status"], "REJECTED");

    let memo: String = sqlx::query_scalar(
        r#"
        SELECT after_snap->>'memo'
        FROM audit_events
        WHERE action = 'work_order.reject' AND target_id = $1
        "#,
    )
    .bind(work_order_id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(memo, "Duplicate request from customer");
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
                .method("GET")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    response_json(response).await
}

async fn post_json(service: axum::Router, uri: &str, token: &str, body: Value) -> JsonResponse {
    let response = service
        .oneshot(
            Request::builder()
                .uri(uri)
                .method("POST")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    response_json(response).await
}

async fn response_json(response: http::Response<Body>) -> JsonResponse {
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    JsonResponse { status, json }
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
    seed_equipment_record(pool, branch_id, management_no, "GTS25DE").await;
}

#[derive(Clone, Copy)]
struct SeededEquipment {
    id: uuid::Uuid,
    customer_id: uuid::Uuid,
    site_id: uuid::Uuid,
}

struct ReadWorkOrderFixture {
    branch_id: BranchId,
    equipment: SeededEquipment,
    receptionist: UserId,
    mechanic: UserId,
    request_no: &'static str,
    priority: &'static str,
    target_due_at: OffsetDateTime,
}

struct KpiWorkOrderFixture {
    branch_id: BranchId,
    equipment: SeededEquipment,
    actor: UserId,
    mechanic: UserId,
    request_no: &'static str,
    priority: &'static str,
    created_at: OffsetDateTime,
    approved_at: OffsetDateTime,
}

async fn seed_equipment_record(
    pool: &PgPool,
    branch_id: BranchId,
    management_no: &str,
    model: &str,
) -> SeededEquipment {
    let equipment_suffix = format!("{:0>4}", management_no);
    let equipment_prefix = format!(
        "{}12",
        model
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric())
            .take(3)
            .collect::<String>()
            .to_ascii_uppercase()
    );
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
    let equipment_id = sqlx::query_scalar(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, model, source_sheet, source_row
        )
        VALUES ($1, $2, $3, $4, $5,
                'A', 'B', 'C', '임대', '좌식', '2.5', $6, 'test', 1)
        RETURNING id
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(format!("{equipment_prefix}-{equipment_suffix}"))
    .bind(management_no)
    .bind(model)
    .fetch_one(pool)
    .await
    .unwrap();

    SeededEquipment {
        id: equipment_id,
        customer_id,
        site_id,
    }
}

async fn seed_kpi_completed_work_order(pool: &PgPool, fixture: KpiWorkOrderFixture) -> WorkOrderId {
    let work_order_id = WorkOrderId::new();
    sqlx::query(
        r#"
        INSERT INTO work_orders (
            id, request_no, branch_id, equipment_id, customer_id, site_id,
            requested_by, status, priority, symptom, result_type,
            report_submitted_by, report_submitted_at, created_at, updated_at
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, 'FINAL_COMPLETED', $8, 'KPI fixture',
            'COMPLETED', $9, $10, $11, $10
        )
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(fixture.request_no)
    .bind(*fixture.branch_id.as_uuid())
    .bind(fixture.equipment.id)
    .bind(fixture.equipment.customer_id)
    .bind(fixture.equipment.site_id)
    .bind(*fixture.actor.as_uuid())
    .bind(fixture.priority)
    .bind(*fixture.mechanic.as_uuid())
    .bind(fixture.approved_at)
    .bind(fixture.created_at)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO work_order_assignments (work_order_id, mechanic_id, role, assigned_at)
        VALUES ($1, $2, 'PRIMARY', $3)
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(*fixture.mechanic.as_uuid())
    .bind(fixture.created_at + Duration::minutes(30))
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO work_order_approval_steps (
            work_order_id, step_order, role, approver_id, status,
            requested_at, approved_at, approved_by_id
        )
        VALUES ($1, 2, 'ADMIN', $2, 'APPROVED', $3, $3, $2)
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(*fixture.actor.as_uuid())
    .bind(fixture.approved_at)
    .execute(pool)
    .await
    .unwrap();
    for (action, from_status, to_status, occurred_at) in [
        ("work_order.create", None, "RECEIVED", fixture.created_at),
        (
            "work_order.start",
            Some("ASSIGNED"),
            "IN_PROGRESS",
            fixture.created_at + Duration::hours(1),
        ),
        (
            "work_order.approve",
            Some("ADMIN_REVIEW"),
            "FINAL_COMPLETED",
            fixture.approved_at,
        ),
    ] {
        sqlx::query(
            r#"
            INSERT INTO work_order_status_history (
                work_order_id, actor, action, from_status, to_status, occurred_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(*work_order_id.as_uuid())
        .bind(*fixture.actor.as_uuid())
        .bind(action)
        .bind(from_status)
        .bind(to_status)
        .bind(occurred_at)
        .execute(pool)
        .await
        .unwrap();
    }
    work_order_id
}

async fn seed_received_work_order(
    pool: &PgPool,
    branch_id: BranchId,
    equipment: SeededEquipment,
    receptionist: UserId,
    request_no: &str,
) -> WorkOrderId {
    let work_order_id = WorkOrderId::new();
    sqlx::query(
        r#"
        INSERT INTO work_orders (
            id, request_no, branch_id, equipment_id, customer_id, site_id,
            requested_by, status, priority, symptom
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'RECEIVED', 'UNSET', 'Read fixture')
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(request_no)
    .bind(*branch_id.as_uuid())
    .bind(equipment.id)
    .bind(equipment.customer_id)
    .bind(equipment.site_id)
    .bind(*receptionist.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    work_order_id
}

async fn seed_read_work_order(pool: &PgPool, fixture: ReadWorkOrderFixture) -> WorkOrderId {
    let work_order_id = WorkOrderId::new();
    sqlx::query(
        r#"
        INSERT INTO work_orders (
            id, request_no, branch_id, equipment_id, customer_id, site_id,
            requested_by, status, priority, symptom, target_due_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'ASSIGNED', $8, 'Read fixture', $9)
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(fixture.request_no)
    .bind(*fixture.branch_id.as_uuid())
    .bind(fixture.equipment.id)
    .bind(fixture.equipment.customer_id)
    .bind(fixture.equipment.site_id)
    .bind(*fixture.receptionist.as_uuid())
    .bind(fixture.priority)
    .bind(fixture.target_due_at)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO work_order_assignments (work_order_id, mechanic_id, role, assigned_at)
        VALUES ($1, $2, 'PRIMARY', now())
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(*fixture.mechanic.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    for (step_order, role, status) in [
        (1_i16, "MECHANIC", "PENDING"),
        (2_i16, "ADMIN", "NOT_STARTED"),
        (3_i16, "EXECUTIVE", "NOT_STARTED"),
    ] {
        sqlx::query(
            r#"
            INSERT INTO work_order_approval_steps (work_order_id, step_order, role, status)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(*work_order_id.as_uuid())
        .bind(step_order)
        .bind(role)
        .bind(status)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        r#"
        INSERT INTO work_order_status_history (
            work_order_id, actor, action, from_status, to_status, occurred_at
        )
        VALUES ($1, $2, 'work_order.assign', 'RECEIVED', 'ASSIGNED', now())
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(*fixture.receptionist.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO evidence_media (
            work_order_id, stage, s3_key, content_type, size_bytes,
            uploaded_by, worm_replica_status
        )
        VALUES ($1, 'BEFORE', $2, 'image/jpeg', 128, $3, 'VERIFIED')
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(format!("work-orders/{work_order_id}/before.jpg"))
    .bind(*fixture.mechanic.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    work_order_id
}
