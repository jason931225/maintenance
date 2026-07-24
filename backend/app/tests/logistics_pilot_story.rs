#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]
//! Authenticated, runtime-role PostgreSQL story for the bounded logistics pilot.
//! It intentionally crosses the assembled HTTP router rather than calling stores.

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{BranchId, OrgId, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const ISSUER: &str = "mnt-platform-auth";
const AUDIENCE: &str = "mnt-api";
const ASN: &str = "/api/v1/logistics/asns";
const FULFILLMENTS: &str = "/api/v1/logistics/fulfillments";

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn authenticated_runtime_role_completes_pilot_lifecycle_without_finance_posting(pool: PgPool) {
    let keys = Keys::generate();
    let rt = runtime_role_pool(&pool).await;
    let branch = seed_branch(&pool, OrgId::knl(), "pilot-main").await;
    let actor = seed_actor_with_logistics_grants(&pool, OrgId::knl(), branch).await;
    let token = keys.token(actor, OrgId::knl(), vec![branch]);

    let (status, created) = send(&rt, &keys, "POST", ASN, &token, Some(json!({
        "branchId": branch, "warehouseCode": "WH-A", "externalReference": "ASN-STORY-1",
        "sku": "PILOT-SKU", "expectedQuantity": 10
    })), None).await;
    assert_eq!(status, StatusCode::CREATED, "create ASN: {created}");
    let asn = created["id"].as_str().unwrap().to_owned();

    let receipt = json!({"branchId": branch, "receivedQuantity": 4});
    let (status, partial) = send(&rt, &keys, "POST", &format!("{ASN}/{asn}/receipts"), &token, Some(receipt.clone()), Some("receipt-story-key-0001")).await;
    assert_eq!(status, StatusCode::OK, "partial receipt: {partial}");
    assert_eq!(partial["status"], "PARTIAL_RECEIVED");
    let (status, replay) = send(&rt, &keys, "POST", &format!("{ASN}/{asn}/receipts"), &token, Some(receipt), Some("receipt-story-key-0001")).await;
    assert_eq!(status, StatusCode::OK, "idempotent replay: {replay}");
    assert_eq!(replay["replayed"], true);
    let (status, changed) = send(&rt, &keys, "POST", &format!("{ASN}/{asn}/receipts"), &token, Some(json!({"branchId": branch, "receivedQuantity": 5})), Some("receipt-story-key-0001")).await;
    assert_eq!(status, StatusCode::CONFLICT, "changed replay must conflict: {changed}");
    let (status, received) = send(&rt, &keys, "POST", &format!("{ASN}/{asn}/receipts"), &token, Some(json!({"branchId": branch, "receivedQuantity": 6})), Some("receipt-story-key-0002")).await;
    assert_eq!(status, StatusCode::OK, "full receipt: {received}");
    assert_eq!(received["status"], "RECEIVED");
    let (status, putaway) = send(&rt, &keys, "POST", &format!("{ASN}/{asn}/putaway"), &token, Some(json!({"branchId": branch})), None).await;
    assert_eq!(status, StatusCode::OK, "putaway: {putaway}");

    let due = OffsetDateTime::now_utc() + Duration::hours(1);
    let (status, released) = send(&rt, &keys, "POST", FULFILLMENTS, &token, Some(json!({"branchId": branch, "warehouseCode": "WH-A", "sku": "PILOT-SKU", "requestedQuantity": 5, "dueAt": due})), None).await;
    assert_eq!(status, StatusCode::CREATED, "release: {released}");
    let fulfillment = released["id"].as_str().unwrap();
    let (status, picked) = send(&rt, &keys, "POST", &format!("{FULFILLMENTS}/{fulfillment}/pick"), &token, Some(json!({"branchId": branch, "pickedQuantity": 5})), None).await;
    assert_eq!(status, StatusCode::OK, "pick: {picked}");
    let (status, packed) = send(&rt, &keys, "POST", &format!("{FULFILLMENTS}/{fulfillment}/pack"), &token, Some(json!({"branchId": branch})), None).await;
    assert_eq!(status, StatusCode::OK, "pack: {packed}");
    let (status, shipment) = send(&rt, &keys, "POST", &format!("{FULFILLMENTS}/{fulfillment}/dispatch"), &token, Some(json!({"branchId": branch, "carrierName": "Pilot Carrier", "vehicleReference": "TRUCK-1"})), None).await;
    assert_eq!(status, StatusCode::CREATED, "dispatch: {shipment}");
    let shipment = shipment["id"].as_str().unwrap();
    let (status, pod) = send(&rt, &keys, "POST", &format!("/api/v1/logistics/shipments/{shipment}/pod"), &token, Some(json!({"branchId": branch, "recipientName": "Recipient", "evidenceReference": "evidence://pod/story-0001", "confirmedAt": OffsetDateTime::now_utc()})), None).await;
    assert_eq!(status, StatusCode::OK, "recipient-confirmed POD: {pod}");
    assert_eq!(pod["slaAssessment"], "MET");
    let (status, settled) = send(&rt, &keys, "POST", &format!("/api/v1/logistics/shipments/{shipment}/settlements"), &token, Some(json!({"branchId": branch, "currencyCode": "KRW", "amountMinor": 12000, "settledAt": OffsetDateTime::now_utc()})), None).await;
    assert_eq!(status, StatusCode::OK, "operational settlement: {settled}");
    assert_eq!(settled["status"], "SETTLED");
    assert!(settled["financeGlPosting"].is_null(), "pilot must not claim a GL posting: {settled}");

    let histories: i64 = sqlx::query_scalar("SELECT count(*) FROM logistics_history WHERE aggregate_id = $1")
        .bind(Uuid::parse_str(shipment).unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(histories, 2, "shipment delivery and settlement history are committed atomically");
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE target_id = $1")
        .bind(shipment).fetch_one(&pool).await.unwrap();
    assert_eq!(audits, 3, "dispatch, POD, and settlement each append an audit event");
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn logistics_capabilities_conceal_other_branches_and_prevent_oversell(pool: PgPool) {
    let keys = Keys::generate();
    let rt = runtime_role_pool(&pool).await;
    let branch_a = seed_branch(&pool, OrgId::knl(), "pilot-a").await;
    let branch_b = seed_branch(&pool, OrgId::knl(), "pilot-b").await;
    let actor = seed_actor_with_logistics_grants(&pool, OrgId::knl(), branch_a).await;
    let token = keys.token(actor, OrgId::knl(), vec![branch_a]);
    let (status, denied) = send(&rt, &keys, "POST", ASN, &token, Some(json!({"branchId": branch_b, "warehouseCode": "WH-B", "externalReference": "OUTSIDE-BRANCH", "sku": "PILOT-SKU", "expectedQuantity": 1})), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "grant cannot widen JWT branch scope: {denied}");

    let ungranted = UserId::new();
    seed_user(&pool, OrgId::knl(), ungranted, branch_a).await;
    let denied_token = keys.token(ungranted, OrgId::knl(), vec![branch_a]);
    let (status, denied) = send(&rt, &keys, "POST", ASN, &denied_token, Some(json!({"branchId": branch_a, "warehouseCode": "WH-A", "externalReference": "NO-GRANT", "sku": "PILOT-SKU", "expectedQuantity": 1})), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "logistics is PBAC grant-only: {denied}");

    sqlx::query("INSERT INTO logistics_stock (org_id, branch_id, warehouse_code, sku, quantity_on_hand, quantity_reserved) VALUES ($1,$2,'WH-A','PILOT-SKU',10,0)")
        .bind(*OrgId::knl().as_uuid()).bind(*branch_a.as_uuid()).execute(&pool).await.unwrap();
    let due = OffsetDateTime::now_utc() + Duration::hours(1);
    let body = json!({"branchId": branch_a, "warehouseCode":"WH-A", "sku":"PILOT-SKU", "requestedQuantity":6, "dueAt":due});
    let (first, second) = tokio::join!(
        send(&rt, &keys, "POST", FULFILLMENTS, &token, Some(body.clone()), None),
        send(&rt, &keys, "POST", FULFILLMENTS, &token, Some(body), None)
    );
    assert_eq!([first.0, second.0].into_iter().filter(|s| *s == StatusCode::CREATED).count(), 1, "only one concurrent reservation may win");
    assert_eq!([first.0, second.0].into_iter().filter(|s| *s == StatusCode::CONFLICT).count(), 1, "the other reservation must fail without oversell");
    let row = sqlx::query("SELECT quantity_on_hand, quantity_reserved FROM logistics_stock WHERE org_id=$1 AND branch_id=$2 AND warehouse_code='WH-A' AND sku='PILOT-SKU'")
        .bind(*OrgId::knl().as_uuid()).bind(*branch_a.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(row.get::<i64, _>("quantity_on_hand"), 10);
    assert_eq!(row.get::<i64, _>("quantity_reserved"), 6);
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn branch_b_dispatch_grant_cannot_transition_branch_a_fulfillment_with_a_legacy_hint(
    pool: PgPool,
) {
    let keys = Keys::generate();
    let rt = runtime_role_pool(&pool).await;
    let branch_a = seed_branch(&pool, OrgId::knl(), "branch-authority-a").await;
    let branch_b = seed_branch(&pool, OrgId::knl(), "branch-authority-b").await;

    let actor_a = seed_actor_with_logistics_grants(&pool, OrgId::knl(), branch_a).await;
    let token_a = keys.token(actor_a, OrgId::knl(), vec![branch_a]);
    sqlx::query(
        "INSERT INTO logistics_stock (org_id, branch_id, warehouse_code, sku, quantity_on_hand, quantity_reserved) VALUES ($1,$2,'WH-A','BRANCH-A-SKU',5,0)",
    )
    .bind(*OrgId::knl().as_uuid())
    .bind(*branch_a.as_uuid())
    .execute(&pool)
    .await
    .unwrap();

    let due = OffsetDateTime::now_utc() + Duration::hours(1);
    let (status, released) = send(
        &rt,
        &keys,
        "POST",
        FULFILLMENTS,
        &token_a,
        Some(json!({
            "branchId": branch_a,
            "warehouseCode": "WH-A",
            "sku": "BRANCH-A-SKU",
            "requestedQuantity": 5,
            "dueAt": due,
        })),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "release branch A fulfillment: {released}"
    );
    let fulfillment = released["id"].as_str().unwrap().to_owned();
    let (status, picked) = send(
        &rt,
        &keys,
        "POST",
        &format!("{FULFILLMENTS}/{fulfillment}/pick"),
        &token_a,
        Some(json!({"branchId": branch_a, "pickedQuantity": 5})),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "pick branch A fulfillment: {picked}"
    );
    let (status, packed) = send(
        &rt,
        &keys,
        "POST",
        &format!("{FULFILLMENTS}/{fulfillment}/pack"),
        &token_a,
        Some(json!({"branchId": branch_a})),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "pack branch A fulfillment: {packed}"
    );

    let actor_b = seed_actor_with_logistics_grants(&pool, OrgId::knl(), branch_b).await;
    let token_b = keys.token(actor_b, OrgId::knl(), vec![branch_b]);
    let (status, denied) = send(
        &rt,
        &keys,
        "POST",
        &format!("{FULFILLMENTS}/{fulfillment}/dispatch"),
        &token_b,
        Some(json!({
            "branchId": branch_b,
            "carrierName": "Branch B Carrier",
            "vehicleReference": "B-ONLY-1",
        })),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a branch-B grant and legacy branch hint must not disclose or transition branch-A data: {denied}"
    );

    let fulfillment_id = Uuid::parse_str(&fulfillment).unwrap();
    let state: String =
        sqlx::query_scalar("SELECT status FROM logistics_fulfillments WHERE id = $1")
            .bind(fulfillment_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        state, "PACKED",
        "denied dispatch must leave the fulfillment unchanged"
    );
    let shipments: i64 =
        sqlx::query_scalar("SELECT count(*) FROM logistics_shipments WHERE fulfillment_id = $1")
            .bind(fulfillment_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        shipments, 0,
        "denied dispatch must not create a child shipment"
    );
    let dispatch_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'logistics.shipment.dispatch' AND actor = $1",
    )
    .bind(*actor_b.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        dispatch_audits, 0,
        "denied dispatch must not append an audit event"
    );
}

struct Keys { private_pem: String, public_pem: String }
impl Keys {
    fn generate() -> Self { let key = SigningKey::random(&mut OsRng); Self { private_pem: key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(), public_pem: key.verifying_key().to_public_key_pem(LineEnding::LF).unwrap() } }
    fn token(&self, user: UserId, org: OrgId, branches: Vec<BranchId>) -> String {
        JwtIssuer::from_es256_pem(JwtSettings { issuer: ISSUER.into(), audience: AUDIENCE.into(), access_token_ttl: Duration::minutes(15) }, self.private_pem.as_bytes(), self.public_pem.as_bytes()).unwrap()
            .issue_access_token(AccessTokenInput { subject: user, org_id: org, roles: vec!["MEMBER".into()], branches, platform: false, view_as: false, read_only: false, display_name: None, feature_grants: Vec::new(), authz_subject_version: 0, authz_policy_version: 0, session_generation: 0, issued_at: OffsetDateTime::now_utc() }).unwrap()
    }
}
async fn runtime_role_pool(owner: &PgPool) -> PgPool { PgPoolOptions::new().max_connections(8).after_connect(|conn, _| Box::pin(async move { sqlx::query("SET ROLE mnt_rt").execute(conn).await?; Ok(()) })).connect_with(owner.connect_options().as_ref().clone()).await.unwrap() }
async fn send(pool: &PgPool, keys: &Keys, method: &str, uri: &str, token: &str, body: Option<Value>, key: Option<&str>) -> (StatusCode, Value) {
    let request = Request::builder().method(method).uri(uri).header(header::AUTHORIZATION, format!("Bearer {token}")).header(header::CONTENT_TYPE, "application/json").header("Idempotency-Key", key.unwrap_or("not-used-by-this-request")).body(body.map(|v| Body::from(serde_json::to_vec(&v).unwrap())).unwrap_or_else(Body::empty)).unwrap();
    let response = build_router(app_state(pool.clone(), keys.public_pem.clone()).unwrap()).oneshot(request).await.unwrap(); let status = response.status(); let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap(); (status, if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() })
}
fn app_state(pool: PgPool, public_key: String) -> Result<AppState, mnt_app::AppError> { AppState::new(AppConfig::from_pairs([("MNT_APP_ROLE", AppRole::Api.to_string()), ("MNT_HTTP_ADDR", "127.0.0.1:0".into()), ("MNT_JWT_ISSUER", ISSUER.into()), ("MNT_JWT_AUDIENCE", AUDIENCE.into()), ("MNT_JWT_PUBLIC_KEY_PEM", public_key)])?, DatabaseDependency::Postgres(pool)) }
async fn seed_branch(pool: &PgPool, org: OrgId, name: &str) -> BranchId { let region: Uuid = sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1,$2) RETURNING id").bind(format!("region-{name}")).bind(*org.as_uuid()).fetch_one(pool).await.unwrap(); BranchId::from_uuid(sqlx::query_scalar("INSERT INTO branches (region_id,name,org_id) VALUES ($1,$2,$3) RETURNING id").bind(region).bind(name).bind(*org.as_uuid()).fetch_one(pool).await.unwrap()) }
async fn seed_user(pool: &PgPool, org: OrgId, user: UserId, branch: BranchId) { sqlx::query("INSERT INTO users (id,display_name,roles,is_active,org_id) VALUES ($1,$2,$3,true,$4)").bind(*user.as_uuid()).bind(format!("pilot-{user}")).bind(vec!["MEMBER"]).bind(*org.as_uuid()).execute(pool).await.unwrap(); sqlx::query("INSERT INTO user_branches (user_id,branch_id,org_id) VALUES ($1,$2,$3)").bind(*user.as_uuid()).bind(*branch.as_uuid()).bind(*org.as_uuid()).execute(pool).await.unwrap(); }
async fn seed_actor_with_logistics_grants(pool: &PgPool, org: OrgId, branch: BranchId) -> UserId { let user = UserId::new(); seed_user(pool, org, user, branch).await; let role: Uuid = sqlx::query_scalar("INSERT INTO policy_roles (org_id,role_key,display_name,status,is_system,created_by,updated_by) VALUES ($1,$2,$3,'ACTIVE',false,$4,$4) RETURNING id").bind(*org.as_uuid()).bind(format!("pilot_{}", Uuid::new_v4().simple())).bind("Pilot logistics operator").bind(*user.as_uuid()).fetch_one(pool).await.unwrap(); for feature in ["logistics_receive","logistics_putaway","logistics_release","logistics_pick_pack","logistics_dispatch","logistics_pod","logistics_settle"] { sqlx::query("INSERT INTO policy_role_permissions (org_id,role_id,feature_key,permission_level) VALUES ($1,$2,$3,'allow')").bind(*org.as_uuid()).bind(role).bind(feature).execute(pool).await.unwrap(); } sqlx::query("INSERT INTO user_role_assignments (org_id,user_id,role_id,assigned_by) VALUES ($1,$2,$3,$2)").bind(*org.as_uuid()).bind(*user.as_uuid()).bind(role).execute(pool).await.unwrap(); user }
