#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

//! Disposable-Postgres HTTP coverage for the equipment 3R vertical.
//!
//! The fixture is seeded by the migration owner, but every request goes through
//! the `mnt_rt` pool, live JWT resolver, custom-role PBAC grants, and forced
//! RLS.  This is intentionally separate from the pure FSM unit tests.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use mnt_equipment_adapter_postgres::PgEquipment3rStore;
use mnt_equipment_rest::{EquipmentRestState, router};
use mnt_kernel_core::{BranchId, OrgId, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_test_support::runtime_role_pool;
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
const EQUIPMENT_FEATURES: &[&str] = &[
    "equipment_3r_registry",
    "equipment_3r_quote",
    "equipment_3r_approve",
    "equipment_3r_dispatch",
    "equipment_3r_inspect",
    "equipment_3r_assess",
    "equipment_3r_disposition",
    "equipment_3r_observe",
];

struct Keys {
    private_pem: String,
    public_pem: String,
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

fn bearer(keys: &Keys, user: UserId, org: OrgId, branch: BranchId) -> String {
    JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: ISSUER.into(),
            audience: AUDIENCE.into(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.private_pem.as_bytes(),
        keys.public_pem.as_bytes(),
    )
    .unwrap()
    .issue_access_token(AccessTokenInput {
        subject: user,
        org_id: org,
        roles: vec!["MEMBER".into()],
        branches: vec![branch],
        platform: false,
        view_as: false,
        read_only: false,
        display_name: None,
        feature_grants: vec![],
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
            issuer: ISSUER.into(),
            audience: AUDIENCE.into(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.public_pem.as_bytes(),
    )
    .unwrap();
    router(EquipmentRestState::new(
        PgEquipment3rStore::new(pool),
        Some(verifier),
    ))
}

async fn request(
    service: axum::Router,
    method: &str,
    uri: &str,
    token: &str,
    body: Value,
    idem: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(key) = idem {
        builder = builder.header("Idempotency-Key", key);
    }
    let response = service
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&body).unwrap_or_else(|_| json!({})),
    )
}

async fn seed_tenant(pool: &PgPool, slug: &str) -> (OrgId, BranchId, UserId) {
    let org = OrgId::from_uuid(Uuid::new_v4());
    sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,$3)")
        .bind(*org.as_uuid())
        .bind(format!("{slug}-{}", Uuid::new_v4().simple()))
        .bind(slug)
        .execute(pool)
        .await
        .unwrap();
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (org_id,name) VALUES ($1,$2) RETURNING id")
            .bind(*org.as_uuid())
            .bind(slug)
            .fetch_one(pool)
            .await
            .unwrap();
    let branch = BranchId::from_uuid(
        sqlx::query_scalar(
            "INSERT INTO branches (org_id,region_id,name) VALUES ($1,$2,$3) RETURNING id",
        )
        .bind(*org.as_uuid())
        .bind(region)
        .bind(slug)
        .fetch_one(pool)
        .await
        .unwrap(),
    );
    let user = UserId::new();
    sqlx::query("INSERT INTO users (id,display_name,roles,org_id,is_active) VALUES ($1,$2,ARRAY['MEMBER']::text[],$3,true)")
        .bind(*user.as_uuid()).bind(slug).bind(*org.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO user_branches (user_id,branch_id,org_id) VALUES ($1,$2,$3)")
        .bind(*user.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO policy_roles (id,org_id,role_key,display_name,status,is_system) VALUES ($1,$2,$3,$4,'ACTIVE',false)")
        .bind(role).bind(*org.as_uuid()).bind(format!("equipment_3r_{slug}_{}", Uuid::new_v4().simple())).bind("Equipment 3R operator").execute(pool).await.unwrap();
    for feature in EQUIPMENT_FEATURES {
        sqlx::query("INSERT INTO policy_role_permissions (org_id,role_id,feature_key,permission_level) VALUES ($1,$2,$3,'allow')")
            .bind(*org.as_uuid()).bind(role).bind(feature).execute(pool).await.unwrap();
    }
    sqlx::query("INSERT INTO user_role_assignments (org_id,user_id,role_id) VALUES ($1,$2,$3)")
        .bind(*org.as_uuid())
        .bind(*user.as_uuid())
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
    (org, branch, user)
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn equipment_3r_http_is_rls_scoped_idempotent_audited_and_concurrency_safe(pool: PgPool) {
    let keys = keys();
    let (org, branch, user) = seed_tenant(&pool, "equipment-http").await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    let token = bearer(&keys, user, org, branch);

    let (status, unit) = request(service.clone(), "POST", "/api/v1/equipment-3r/units", &token, json!({
        "branchId": branch, "serialNo": "3R-HTTP-001", "modelName": "3R loader", "capacityClass": "L", "acquisitionCostMinor": 900000
    }), None).await;
    assert_eq!(status, StatusCode::CREATED, "{unit:?}");
    let unit_id = unit["id"].as_str().unwrap();
    let quote = json!({"branchId": branch, "unitId": unit_id, "customerName": "HTTP renter", "siteReference": "site://3r-http", "monthlyRateMinor": 250000, "durationMonths": 3, "currencyCode": "KRW"});
    let key = "equipment-3r-http-quote-001";
    let (status, case) = request(
        service.clone(),
        "POST",
        "/api/v1/equipment-3r/rental-cases",
        &token,
        quote.clone(),
        Some(key),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{case:?}");
    let case_id = case["id"].as_str().unwrap().to_owned();
    let (status, replay) = request(
        service.clone(),
        "POST",
        "/api/v1/equipment-3r/rental-cases",
        &token,
        quote,
        Some(key),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replay:?}");
    assert_eq!(replay["id"], case["id"]);

    let approval_path = format!("/api/v1/equipment-3r/rental-cases/{case_id}/approval");
    let (first, second) = tokio::join!(
        request(
            service.clone(),
            "POST",
            &approval_path,
            &token,
            json!({"decision":"APPROVED"}),
            None
        ),
        request(
            service.clone(),
            "POST",
            &approval_path,
            &token,
            json!({"decision":"APPROVED"}),
            None
        ),
    );
    assert!(
        matches!(
            (first.0, second.0),
            (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
        ),
        "concurrent approval must have one winner: {first:?} {second:?}"
    );
    let (status, _) = request(
        service.clone(),
        "POST",
        &format!("/api/v1/equipment-3r/rental-cases/{case_id}/dispatch"),
        &token,
        json!({"carrierName":"3R logistics","vehicleReference":"TRUCK-3R"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = request(service.clone(), "POST", &format!("/api/v1/equipment-3r/rental-cases/{case_id}/handover"), &token, json!({"recipientName":"HTTP renter","evidenceReference":"evidence://handover/3r-http-001","handedOverAt":"2026-07-24T12:00:00Z"}), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = request(
        service.clone(),
        "POST",
        &format!("/api/v1/equipment-3r/rental-cases/{case_id}/inspections"),
        &token,
        json!({"outcome":"PASS","findings":"ready"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = request(
        service.clone(),
        "POST",
        &format!("/api/v1/equipment-3r/rental-cases/{case_id}/return"),
        &token,
        json!({"returnedAt":"2026-07-25T12:00:00Z"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, assessed) = request(
        service.clone(),
        "POST",
        &format!("/api/v1/equipment-3r/rental-cases/{case_id}/assessment"),
        &token,
        json!({"conditionGrade":"C","findings":"repair then resale","disposition":"RESALE"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{assessed:?}");
    let disposition = assessed["dispositionId"].as_str().unwrap();
    let (status, completed) = request(
        service.clone(),
        "POST",
        &format!("/api/v1/equipment-3r/dispositions/{disposition}/completion"),
        &token,
        json!({"saleAmountMinor": 175000, "buyerName":"Resale buyer"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{completed:?}");
    assert_eq!(completed["status"], "COMPLETED");
    let availability: String =
        sqlx::query_scalar("SELECT availability FROM equipment_3r_units WHERE id=$1")
            .bind(Uuid::parse_str(unit_id).unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(availability, "SOLD");

    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action LIKE 'equipment_3r.%' AND branch_id=$1",
    )
    .bind(*branch.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        audit_count, 9,
        "one replay and one losing concurrent transition must not create audits"
    );
    let (other_org, other_branch, other_user) = seed_tenant(&pool, "equipment-http-other").await;
    let other_token = bearer(&keys, other_user, other_org, other_branch);
    let (status, _) = request(
        service,
        "GET",
        &format!("/api/v1/equipment-3r/units/{unit_id}"),
        &other_token,
        json!({}),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "forced RLS conceals a foreign tenant unit before PBAC can disclose it"
    );
}
