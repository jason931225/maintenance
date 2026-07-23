#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

//! Runtime-role HTTP coverage for the production planning lifecycle.
//!
//! Fixtures are seeded as the migration owner, while every HTTP request uses
//! the non-owner `mnt_rt` role. This ensures the real request-context/RLS path
//! is exercised rather than a BYPASSRLS pool or direct SQL substitute.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use mnt_kernel_core::{BranchId, OrgId, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_test_support::runtime_role_pool;
use mnt_production_rest::{
    PRODUCTION_CAPACITY_SLOTS_PATH, PRODUCTION_PLAN_PATH, PRODUCTION_PLANS_PATH,
    ProductionRestState, router,
};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const ISSUER: &str = "mnt-platform-auth";
const AUDIENCE: &str = "mnt-api";

struct Keys {
    private_pem: String,
    public_pem: String,
}

struct Fixture {
    org: OrgId,
    branch: BranchId,
    planner: UserId,
    reviewer: UserId,
    operator: UserId,
    demand: Uuid,
    capacity: Uuid,
    material: Uuid,
    ontology: Uuid,
    approval: Uuid,
    due_at: OffsetDateTime,
}

fn keys() -> Keys {
    let key = SigningKey::random(&mut OsRng);
    Keys {
        private_pem: key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
        public_pem: key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    }
}

fn bearer(keys: &Keys, user: UserId, org: OrgId, role: &str, branch: BranchId) -> String {
    JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: ISSUER.to_owned(),
            audience: AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.private_pem.as_bytes(),
        keys.public_pem.as_bytes(),
    )
    .unwrap()
    .issue_access_token(AccessTokenInput {
        subject: user,
        org_id: org,
        roles: vec![role.to_owned()],
        branches: vec![branch],
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

fn app(pool: PgPool, keys: &Keys) -> axum::Router {
    let verifier = JwtVerifier::from_es256_public_pem(
        JwtSettings {
            issuer: ISSUER.to_owned(),
            audience: AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.public_pem.as_bytes(),
    )
    .unwrap();
    router(ProductionRestState::new(pool, Some(verifier)))
}

async fn post(service: axum::Router, uri: &str, token: &str, body: Value) -> (StatusCode, Value) {
    let response = service
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&body).unwrap_or_else(|_| json!({})),
    )
}

async fn get(service: axum::Router, uri: &str, token: &str) -> (StatusCode, Value) {
    let response = service
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&body).unwrap_or_else(|_| json!({})),
    )
}

async fn seed_fixture(pool: &PgPool) -> Fixture {
    let org = OrgId::knl();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING")
        .bind(*org.as_uuid())
        .bind("production-http")
        .bind("Production HTTP")
        .execute(pool)
        .await
        .unwrap();

    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("production-http-{}", Uuid::new_v4()))
            .bind(*org.as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch = BranchId::from_uuid(
        sqlx::query_scalar(
            "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(region)
        .bind(format!("production-http-{}", Uuid::new_v4()))
        .bind(*org.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap(),
    );
    let planner = seed_user(pool, org, branch, "SUPER_ADMIN", "planner").await;
    let reviewer = seed_user(pool, org, branch, "SUPER_ADMIN", "reviewer").await;
    let operator = seed_user(pool, org, branch, "SUPER_ADMIN", "operator").await;
    let customer: Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, org_id, name) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch.as_uuid())
    .bind(*org.as_uuid())
    .bind("Production customer")
    .fetch_one(pool)
    .await
    .unwrap();
    let site: Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, org_id, name) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(*branch.as_uuid())
    .bind(customer)
    .bind(*org.as_uuid())
    .bind("Production site")
    .fetch_one(pool)
    .await
    .unwrap();
    let inquiry = Uuid::new_v4();
    sqlx::query("INSERT INTO customer_inquiries (id, org_id, name, phone, topic, status) VALUES ($1, $2, $3, $4, 'OTHER', 'NEW')")
        .bind(inquiry).bind(*org.as_uuid()).bind("Production customer").bind("010-0000-0000")
        .execute(pool).await.unwrap();
    let due_at = OffsetDateTime::now_utc() + Duration::days(7);
    let demand = Uuid::new_v4();
    sqlx::query("INSERT INTO production_demand_contracts (id, org_id, inquiry_id, product_code, quantity, due_at, source_system, source_id, source_version, evaluated_at) VALUES ($1,$2,$3,'IV-PROD-001',10,$4,'sales','inquiry-1','v1',now())")
        .bind(demand).bind(*org.as_uuid()).bind(inquiry).bind(due_at).execute(pool).await.unwrap();
    let location: Uuid = sqlx::query_scalar("INSERT INTO inventory_stock_locations (org_id,branch_id,site_id,label,status) VALUES ($1,$2,$3,'Production store','ACTIVE') RETURNING id")
        .bind(*org.as_uuid()).bind(*branch.as_uuid()).bind(site).fetch_one(pool).await.unwrap();
    let material: Uuid = sqlx::query_scalar("INSERT INTO inventory_items (org_id,branch_id,stock_location_id,site_id,iv_code,display_name,unit_code,quantity_on_hand_milli,safety_stock_milli,status,created_by) VALUES ($1,$2,$3,$4,'IV-PROD-001','Production material','EA',100,5,'ACTIVE',$5) RETURNING id")
        .bind(*org.as_uuid()).bind(*branch.as_uuid()).bind(location).bind(site).bind(*planner.as_uuid()).fetch_one(pool).await.unwrap();
    let capacity = Uuid::new_v4();
    sqlx::query("INSERT INTO production_capacity_slots (id,org_id,branch_id,site_id,capacity_date,available_quantity,reserved_quantity,source_system,source_id,source_version,evaluated_at) VALUES ($1,$2,$3,$4,$5,100,0,'erp','capacity-1','v1',now())")
        .bind(capacity).bind(*org.as_uuid()).bind(*branch.as_uuid()).bind(site).bind(due_at.date()).execute(pool).await.unwrap();
    let ontology: Uuid = sqlx::query_scalar("INSERT INTO ont_object_types (org_id,stable_key,title,backing_kind,schema_version,lifecycle_state,created_by) VALUES ($1,$2,'Production plan','instance',1,'published',$3) RETURNING id")
        .bind(*org.as_uuid()).bind(format!("production.plan.test{}", Uuid::new_v4().simple())).bind(*planner.as_uuid()).fetch_one(pool).await.unwrap();
    let approval = Uuid::new_v4();
    sqlx::query("INSERT INTO gov_approvals (id,org_id,request_ref,kind,target_ref,requested_by,approver_id,decision) VALUES ($1,$2,$3,'production_plan_create',$4,$5,$6,'approved')")
        .bind(approval).bind(*org.as_uuid()).bind(Uuid::new_v4()).bind(demand).bind(*planner.as_uuid()).bind(*reviewer.as_uuid()).execute(pool).await.unwrap();
    Fixture {
        org,
        branch,
        planner,
        reviewer,
        operator,
        demand,
        capacity,
        material,
        ontology,
        approval,
        due_at,
    }
}

async fn seed_user(pool: &PgPool, org: OrgId, branch: BranchId, role: &str, name: &str) -> UserId {
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1,$2,$3,$4,true)",
    )
    .bind(*user.as_uuid())
    .bind(name)
    .bind(vec![role.to_owned()])
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1,$2,$3)")
        .bind(*user.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    user
}

async fn seed_isolated_tenant(pool: &PgPool) -> (OrgId, BranchId, UserId) {
    let org = OrgId::from_uuid(Uuid::new_v4());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
        .bind(*org.as_uuid())
        .bind(format!("production-isolated-{}", Uuid::new_v4().simple()))
        .bind("Isolated production tenant")
        .execute(pool)
        .await
        .unwrap();
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("production-isolated-region-{}", Uuid::new_v4()))
            .bind(*org.as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch = BranchId::from_uuid(
        sqlx::query_scalar(
            "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(region)
        .bind(format!("production-isolated-branch-{}", Uuid::new_v4()))
        .bind(*org.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap(),
    );
    let user = seed_user(pool, org, branch, "SUPER_ADMIN", "isolated planner").await;
    (org, branch, user)
}

fn create_body(fixture: &Fixture, key: &str) -> Value {
    json!({
        "branch_id": fixture.branch,
        "customer_demand_id": fixture.demand,
        "capacity_slot_id": fixture.capacity,
        "material_item_id": fixture.material,
        "quantity": 10,
        "due_at": fixture.due_at,
        "idempotency_key": key,
        "approval_ref": fixture.approval,
        "ontology_type_id": fixture.ontology,
    })
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn planner_reviewer_operator_complete_a_durable_production_lifecycle(pool: PgPool) {
    let keys = keys();
    let fixture = seed_fixture(&pool).await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    let planner_token = bearer(
        &keys,
        fixture.planner,
        fixture.org,
        "SUPER_ADMIN",
        fixture.branch,
    );
    let reviewer_token = bearer(
        &keys,
        fixture.reviewer,
        fixture.org,
        "SUPER_ADMIN",
        fixture.branch,
    );
    let operator_token = bearer(
        &keys,
        fixture.operator,
        fixture.org,
        "SUPER_ADMIN",
        fixture.branch,
    );

    let body = create_body(&fixture, "production-create-1");
    let (status, plan) = post(
        service.clone(),
        PRODUCTION_PLANS_PATH,
        &planner_token,
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{plan:?}");
    let plan_id = plan["id"].as_str().unwrap();
    let operation_id = plan["first_operation_id"].as_str().unwrap();
    let reserved: i64 =
        sqlx::query_scalar("SELECT reserved_quantity FROM production_capacity_slots WHERE id = $1")
            .bind(fixture.capacity)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(reserved, 10, "the real create handler reserves capacity");
    let material_after_reservation: i64 =
        sqlx::query_scalar("SELECT quantity_on_hand_milli FROM inventory_items WHERE id = $1")
            .bind(fixture.material)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        material_after_reservation, 90,
        "the real create handler reserves the requested material quantity"
    );

    let (status, replay) = post(service.clone(), PRODUCTION_PLANS_PATH, &planner_token, body).await;
    assert_eq!(status, StatusCode::OK, "{replay:?}");
    assert_eq!(replay["id"], plan["id"]);

    let (status, released) = post(
        service.clone(),
        &format!("/api/v1/production/plans/{plan_id}/release"),
        &reviewer_token,
        json!({"expected_version": 1, "idempotency_key": "production-release-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{released:?}");
    assert_eq!(released["status"], "RELEASED");

    let (status, operation) = post(
        service,
        &format!("/api/v1/production/plans/{plan_id}/operations/{operation_id}/records"),
        &operator_token,
        json!({"expected_version": 2, "idempotency_key": "production-record-1", "output_quantity": 10, "scrap_quantity": 0, "downtime_minutes": 0, "quality_evidence_ref": "inspection:passed", "quality_passed": true, "note": "completed"}),
    ).await;
    assert_eq!(status, StatusCode::OK, "{operation:?}");
    assert_eq!(operation["status"], "RECORDED");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_rejects_a_reused_idempotency_key_with_a_different_request(pool: PgPool) {
    let keys = keys();
    let fixture = seed_fixture(&pool).await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    let token = bearer(
        &keys,
        fixture.planner,
        fixture.org,
        "SUPER_ADMIN",
        fixture.branch,
    );
    let (status, created) = post(
        service.clone(),
        PRODUCTION_PLANS_PATH,
        &token,
        create_body(&fixture, "production-idempotency-conflict"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created:?}");

    let mut changed = create_body(&fixture, "production-idempotency-conflict");
    changed["quantity"] = json!(9);
    let (status, conflict) = post(service, PRODUCTION_PLANS_PATH, &token, changed).await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict:?}");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_rejects_a_demand_quantity_or_due_date_that_does_not_match_the_ingested_contract(
    pool: PgPool,
) {
    let keys = keys();
    let fixture = seed_fixture(&pool).await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    let token = bearer(
        &keys,
        fixture.planner,
        fixture.org,
        "SUPER_ADMIN",
        fixture.branch,
    );
    let mut body = create_body(&fixture, "production-demand-due-mismatch");
    body["due_at"] = json!(fixture.due_at + Duration::days(1));
    let (status, unavailable) = post(service, PRODUCTION_PLANS_PATH, &token, body).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{unavailable:?}");
    let created: i64 = sqlx::query_scalar("SELECT count(*) FROM production_plans")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        created, 0,
        "a rejected demand contract cannot create a plan"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_rejects_a_production_approval_after_its_single_consumption(pool: PgPool) {
    let keys = keys();
    let fixture = seed_fixture(&pool).await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    let token = bearer(
        &keys,
        fixture.planner,
        fixture.org,
        "SUPER_ADMIN",
        fixture.branch,
    );
    let (status, created) = post(
        service.clone(),
        PRODUCTION_PLANS_PATH,
        &token,
        create_body(&fixture, "production-approval-consume-1"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created:?}");

    let (status, conflict) = post(
        service,
        PRODUCTION_PLANS_PATH,
        &token,
        create_body(&fixture, "production-approval-consume-2"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a consumed approval must fail closed as a conflict: {conflict:?}"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn operation_record_rejects_a_terminal_operation_write(pool: PgPool) {
    let keys = keys();
    let fixture = seed_fixture(&pool).await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    let planner_token = bearer(
        &keys,
        fixture.planner,
        fixture.org,
        "SUPER_ADMIN",
        fixture.branch,
    );
    let reviewer_token = bearer(
        &keys,
        fixture.reviewer,
        fixture.org,
        "SUPER_ADMIN",
        fixture.branch,
    );
    let operator_token = bearer(
        &keys,
        fixture.operator,
        fixture.org,
        "SUPER_ADMIN",
        fixture.branch,
    );
    let (status, plan) = post(
        service.clone(),
        PRODUCTION_PLANS_PATH,
        &planner_token,
        create_body(&fixture, "production-terminal-create"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{plan:?}");
    let plan_id = plan["id"].as_str().unwrap();
    let operation_id = plan["first_operation_id"].as_str().unwrap();
    let (status, release) = post(
        service.clone(),
        &format!("/api/v1/production/plans/{plan_id}/release"),
        &reviewer_token,
        json!({"expected_version": 1, "idempotency_key": "production-terminal-release"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{release:?}");
    let request = json!({"expected_version": 2, "idempotency_key": "production-terminal-record-1", "output_quantity": 10, "scrap_quantity": 0, "downtime_minutes": 0, "quality_evidence_ref": "inspection:passed", "quality_passed": true, "note": "completed"});
    let (status, recorded) = post(
        service.clone(),
        &format!("/api/v1/production/plans/{plan_id}/operations/{operation_id}/records"),
        &operator_token,
        request,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{recorded:?}");
    let (status, conflict) = post(
        service,
        &format!("/api/v1/production/plans/{plan_id}/operations/{operation_id}/records"),
        &operator_token,
        json!({"expected_version": 3, "idempotency_key": "production-terminal-record-2", "output_quantity": 1, "scrap_quantity": 0, "downtime_minutes": 0, "quality_evidence_ref": "inspection:passed", "quality_passed": true, "note": "illegal second write"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict:?}");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn tenant_cannot_read_another_tenants_production_plan_under_force_rls(pool: PgPool) {
    let keys = keys();
    let fixture = seed_fixture(&pool).await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    let planner_token = bearer(
        &keys,
        fixture.planner,
        fixture.org,
        "SUPER_ADMIN",
        fixture.branch,
    );
    let (status, created) = post(
        service.clone(),
        PRODUCTION_PLANS_PATH,
        &planner_token,
        create_body(&fixture, "production-cross-tenant-create"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created:?}");
    let (foreign_org, foreign_branch, foreign_user) = seed_isolated_tenant(&pool).await;
    let foreign_token = bearer(
        &keys,
        foreign_user,
        foreign_org,
        "SUPER_ADMIN",
        foreign_branch,
    );
    let (status, body) = get(
        service,
        &PRODUCTION_PLAN_PATH.replace("{plan_id}", created["id"].as_str().unwrap()),
        &foreign_token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body:?}");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn runtime_routes_reject_caller_authored_demand_and_capacity_ingress(pool: PgPool) {
    let keys = keys();
    let fixture = seed_fixture(&pool).await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    let token = bearer(
        &keys,
        fixture.planner,
        fixture.org,
        "SUPER_ADMIN",
        fixture.branch,
    );
    let (status, capacity) = post(
        service.clone(),
        PRODUCTION_CAPACITY_SLOTS_PATH,
        &token,
        json!({"branch_id": fixture.branch, "available_quantity": 999999}),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{capacity:?}");
    let (status, demand) = post(
        service,
        "/api/v1/production/demand-contracts",
        &token,
        json!({"product_code": "IV-PROD-001", "quantity": 999999}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{demand:?}");
}
