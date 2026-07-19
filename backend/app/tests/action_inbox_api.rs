#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Unified action inbox (`GET /api/v1/me/action-inbox`).
//!
//! Drives the REAL router on a genuine non-owner `mnt_rt` pool (RLS actually
//! enforced, never a BYPASSRLS superuser). Locks the two visibility invariants
//! for the hand-written work-order source of the aggregate:
//!   * an item surfaces ONLY when it is assigned to the caller — a work order
//!     assigned to another user in the SAME org never appears (no widening);
//!   * the aggregate is org-scoped — a work order assigned to the caller's user
//!     id but living in ANOTHER org is invisible (RLS confinement of the raw
//!     query under `with_org_conn`).

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{BranchId, OrgId, UserId, WorkOrderId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";
const PATH: &str = "/api/v1/me/action-inbox";

struct Keys {
    private_pem: String,
    public_pem: String,
}

struct JsonResponse {
    status: StatusCode,
    json: Value,
}

// ===========================================================================
// The inbox surfaces only the caller's own assigned work orders. A WO assigned
// to another user in the same org must never appear.
// ===========================================================================
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn action_inbox_returns_only_my_assigned_work_orders(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool, OrgId::knl(), "리전", "지사").await;

    let alice = UserId::new();
    seed_user(&pool, OrgId::knl(), alice, "MEMBER", branch).await;
    let bob = UserId::new();
    seed_user(&pool, OrgId::knl(), bob, "MEMBER", branch).await;

    let equipment = seed_equipment(&pool, OrgId::knl(), branch, "0001").await;
    let alice_wo = seed_assigned_work_order(
        &pool,
        OrgId::knl(),
        branch,
        equipment,
        alice,
        "20260701-101",
    )
    .await;
    // Bob's own assigned work order in the SAME org — must not leak to alice.
    let _bob_wo =
        seed_assigned_work_order(&pool, OrgId::knl(), branch, equipment, bob, "20260701-102").await;

    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());

    let resp = get(service, PATH, &bearer(&keys, OrgId::knl(), alice, "MEMBER")).await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.json);
    let items = resp.json["items"].as_array().unwrap();
    assert_eq!(
        items.len(),
        1,
        "alice must see exactly her one assigned WO: {:?}",
        resp.json
    );
    assert_eq!(items[0]["kind"], "work");
    assert_eq!(items[0]["id"], format!("work:{}", alice_wo));
    assert_eq!(items[0]["ref"], "20260701-101");
    assert_eq!(items[0]["done"], false);
    assert_eq!(resp.json["total"], 1);
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn action_inbox_keyset_pages_past_the_old_two_hundred_item_cap(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool, OrgId::knl(), "페이지 리전", "페이지 지사").await;
    let alice = UserId::new();
    seed_user(&pool, OrgId::knl(), alice, "MEMBER", branch).await;
    let equipment = seed_equipment(&pool, OrgId::knl(), branch, "page").await;
    for index in 0..205 {
        seed_assigned_work_order(
            &pool,
            OrgId::knl(),
            branch,
            equipment,
            alice,
            &format!("20260702-{index:03}"),
        )
        .await;
    }

    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&keys, OrgId::knl(), alice, "MEMBER");
    let first = get(service.clone(), &format!("{PATH}?limit=200"), &token).await;
    assert_eq!(first.status, StatusCode::OK, "{:?}", first.json);
    assert_eq!(first.json["items"].as_array().map(Vec::len), Some(200));
    assert_eq!(first.json["total"], 205);
    assert_eq!(first.json["total_is_exact"], true);
    let cursor = first.json["next_cursor"].as_str().expect("second page");
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("limit", "200")
        .append_pair("cursor", cursor)
        .finish();
    let second = get(service, &format!("{PATH}?{query}"), &token).await;
    assert_eq!(second.status, StatusCode::OK, "{:?}", second.json);
    assert_eq!(second.json["items"].as_array().map(Vec::len), Some(5));
    assert!(second.json["next_cursor"].is_null());
    let first_ids = first.json["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert!(
        second.json["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| !first_ids.contains(item["id"].as_str().unwrap()))
    );
}

// ===========================================================================
// The aggregate is org-scoped: a WO assigned to alice's user id but in ANOTHER
// org is invisible to her KNL-scoped token (RLS confines the raw query).
// ===========================================================================
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn action_inbox_is_org_scoped(pool: PgPool) {
    let keys = keys();

    // Alice belongs to KNL (her real org / token org).
    let knl_branch = seed_branch(&pool, OrgId::knl(), "리전", "지사").await;
    let alice = UserId::new();
    seed_user(&pool, OrgId::knl(), alice, "MEMBER", knl_branch).await;

    // A work order in ANOTHER org, assigned to alice's user id. RLS must hide it
    // from alice's KNL-scoped read even though the assignment matches her uuid.
    let other_org = seed_org(&pool, "other-co", "Other Co").await;
    let other_branch = seed_branch(&pool, other_org, "리전", "지사").await;
    let equipment = seed_equipment(&pool, other_org, other_branch, "0001").await;
    let _wo = seed_assigned_work_order(
        &pool,
        other_org,
        other_branch,
        equipment,
        alice,
        "20260701-201",
    )
    .await;

    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());

    // Alice authenticates against KNL, where she has no assigned work.
    let resp = get(service, PATH, &bearer(&keys, OrgId::knl(), alice, "MEMBER")).await;
    assert_eq!(resp.status, StatusCode::OK, "{:?}", resp.json);
    assert_eq!(
        resp.json["items"].as_array().map(Vec::len),
        Some(0),
        "another org's work order must never surface: {:?}",
        resp.json
    );
    assert_eq!(resp.json["total"], 0);
}

// ===========================================================================
// Helpers.
// ===========================================================================

async fn seed_org(pool: &PgPool, slug: &str, name: &str) -> OrgId {
    let id = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(slug)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    OrgId::from_uuid(id)
}

async fn seed_branch(pool: &PgPool, org: OrgId, region_name: &str, branch_name: &str) -> BranchId {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(region_name)
            .bind(*org.as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(branch_name)
    .bind(*org.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user(pool: &PgPool, org: OrgId, user_id: UserId, role: &str, branch: BranchId) {
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("inbox-{role}-{}", user_id.as_uuid()))
        .bind(vec![role])
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_equipment(pool: &PgPool, org: OrgId, branch: BranchId, tag: &str) -> uuid::Uuid {
    let customer_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch.as_uuid())
    .bind(format!("Customer {tag}"))
    .bind(*org.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    let site_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(*branch.as_uuid())
    .bind(customer_id)
    .bind(format!("Site {tag}"))
    .bind(*org.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query_scalar(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, model, source_sheet, source_row, org_id
        )
        VALUES ($1, $2, $3, $4, $5,
                'A', 'B', 'C', '임대', '좌식', '2.5', 'GTS25DE', 'test', 1, $6)
        RETURNING id
        "#,
    )
    .bind(*branch.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(format!("ABC12-{tag}"))
    .bind(format!("MG-{tag}"))
    .bind(*org.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn seed_assigned_work_order(
    pool: &PgPool,
    org: OrgId,
    branch: BranchId,
    equipment_id: uuid::Uuid,
    mechanic: UserId,
    request_no: &str,
) -> WorkOrderId {
    let work_order_id = WorkOrderId::new();
    sqlx::query(
        r#"
        INSERT INTO work_orders (
            id, request_no, branch_id, equipment_id, customer_id, site_id,
            requested_by, status, priority, symptom, org_id
        )
        SELECT $1, $2, $3, e.id, e.customer_id, e.site_id,
               $4, 'ASSIGNED', 'UNSET', 'inbox fixture', $6
        FROM registry_equipment e
        WHERE e.id = $5
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(request_no)
    .bind(*branch.as_uuid())
    .bind(*mechanic.as_uuid())
    .bind(equipment_id)
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO work_order_assignments (work_order_id, mechanic_id, role, assigned_at, org_id)
        VALUES ($1, $2, 'PRIMARY', now(), $3)
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(*mechanic.as_uuid())
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    work_order_id
}

async fn get(service: axum::Router, uri: &str, token: &str) -> JsonResponse {
    let request = Request::builder()
        .uri(uri)
        .method("GET")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = service.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    JsonResponse { status, json }
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

fn bearer(keys: &Keys, org: OrgId, user_id: UserId, role: &str) -> String {
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
            subject: user_id,
            org_id: org,
            roles: vec![role.to_owned()],
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
        .after_connect(|conn, _meta| {
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
