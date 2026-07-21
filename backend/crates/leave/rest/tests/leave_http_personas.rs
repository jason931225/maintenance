#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Real-router proof for the self-service/managed leave boundary.
//!
//! Requests use signed JWTs and a genuine `mnt_rt` pool. This locks three
//! invariants at the transport boundary: self reads never require directory
//! authority, managed reads remain denied to a member, and client-supplied
//! employee/branch identifiers cannot influence filing.

use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use mnt_inbox_adapter_postgres::PgInboxStore;
use mnt_kernel_core::{BranchId, OrgId, UserId};
use mnt_leave_adapter_postgres::PgLeaveStore;
use mnt_leave_rest::{LeaveRestState, router};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_test_support::{grant_mnt_rt, runtime_role_pool};
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

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn member_self_service_is_server_bound_and_missing_home_branch_is_explicit(
    owner_pool: PgPool,
) {
    let org = OrgId::new();
    let branch = BranchId::new();
    let member = UserId::new();
    let employee = Uuid::new_v4();
    seed_subject(&owner_pool, org, branch, member, employee).await;
    grant_mnt_rt(
        &owner_pool,
        &[
            "GRANT SELECT, INSERT, UPDATE ON leave_requests TO mnt_rt",
            "GRANT SELECT, INSERT ON leave_charge_resolutions TO mnt_rt",
            "GRANT SELECT, INSERT ON audit_events TO mnt_rt",
            "GRANT SELECT, UPDATE ON employees TO mnt_rt",
            "GRANT SELECT ON users TO mnt_rt",
            "GRANT SELECT ON user_branches TO mnt_rt",
            "GRANT SELECT ON branches TO mnt_rt",
            "GRANT SELECT ON organizations TO mnt_rt",
        ],
    )
    .await;

    let auth = test_auth(member, org, vec![branch]);
    let runtime_pool = runtime_role_pool(&owner_pool).await;
    let service = router(LeaveRestState::new(
        PgLeaveStore::new(
            runtime_pool.clone(),
            Arc::new(PgInboxStore::new(runtime_pool)),
        ),
        Some(auth.verifier),
    ));

    let own = request_json(
        service.clone(),
        "GET",
        "/api/v2/me/leave",
        &auth.token,
        None,
    )
    .await;
    assert_eq!(own.status, StatusCode::OK, "{:?}", own.body);
    assert_eq!(own.body["balance"]["employee_id"], employee.to_string());
    assert_eq!(own.body["balance"]["filing_state"], "ready");
    assert_eq!(
        own.body["balance"]["home_branch_id"],
        branch.as_uuid().to_string()
    );
    assert_eq!(own.body["requests"]["items"], json!([]));

    let managed = request_json(
        service.clone(),
        "GET",
        "/api/v2/leave/requests",
        &auth.token,
        None,
    )
    .await;
    assert_eq!(managed.status, StatusCode::FORBIDDEN, "{:?}", managed.body);

    let forged = request_json(
        service.clone(),
        "POST",
        "/api/v2/leave/requests",
        &auth.token,
        Some(json!({
            "leave_type": "annual",
            "idempotency_key": Uuid::new_v4(),
            "start_date": "2026-07-21",
            "end_date": "2026-07-21",
            "reason": "self service",
            "subject_employee_id": Uuid::new_v4(),
            "branch_id": Uuid::new_v4()
        })),
    )
    .await;
    assert_eq!(forged.status, StatusCode::UNPROCESSABLE_ENTITY);

    let definer_pool = leave_definer_role_pool(&owner_pool).await;
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(org.as_uuid().to_string())
        .execute(&definer_pool)
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET home_branch_id = NULL WHERE org_id = $1 AND id = $2")
        .bind(*org.as_uuid())
        .bind(employee)
        .execute(&definer_pool)
        .await
        .unwrap();

    let readable_while_blocked = request_json(
        service.clone(),
        "GET",
        "/api/v2/me/leave",
        &auth.token,
        None,
    )
    .await;
    assert_eq!(readable_while_blocked.status, StatusCode::OK);
    assert_eq!(
        readable_while_blocked.body["balance"]["filing_state"],
        "home_branch_required"
    );
    assert!(readable_while_blocked.body["balance"]["home_branch_id"].is_null());

    let blocked = request_json(
        service.clone(),
        "POST",
        "/api/v2/leave/requests",
        &auth.token,
        Some(json!({
            "leave_type": "half_day",
            "idempotency_key": Uuid::new_v4(),
            "partial_day_period": "pm",
            "start_date": "2026-07-21",
            "end_date": "2026-07-21",
            "reason": "medical appointment"
        })),
    )
    .await;
    assert_eq!(blocked.status, StatusCode::CONFLICT, "{:?}", blocked.body);
    assert_eq!(
        blocked.body["error"]["code"],
        "leave_home_branch_review_required"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn v1_wire_shape_is_frozen_and_v2_requires_modern_exact_cas(owner_pool: PgPool) {
    let org = OrgId::new();
    let branch = BranchId::new();
    let requester = UserId::new();
    let decider = UserId::new();
    let employee = Uuid::new_v4();
    seed_subject(&owner_pool, org, branch, requester, employee).await;
    seed_branch_admin(&owner_pool, org, branch, decider).await;
    grant_mnt_rt(
        &owner_pool,
        &[
            "GRANT SELECT ON leave_requests TO mnt_rt",
            "GRANT SELECT ON users TO mnt_rt",
            "GRANT SELECT ON user_branches TO mnt_rt",
            "GRANT SELECT ON branches TO mnt_rt",
            "GRANT SELECT ON organizations TO mnt_rt",
        ],
    )
    .await;

    let v1_request = Uuid::new_v4();
    let modern_request = Uuid::new_v4();
    let definer_pool = leave_definer_role_pool(&owner_pool).await;
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(org.as_uuid().to_string())
        .execute(&definer_pool)
        .await
        .unwrap();
    for (id, reason) in [
        (v1_request, "v1 versionless decision"),
        (modern_request, "modern stale decision"),
    ] {
        sqlx::query(
            "INSERT INTO leave_requests \
             (id, org_id, branch_id, requester_user_id, subject_employee_id, leave_type, days, \
              start_date, end_date, reason, status) \
             VALUES ($1, $2, $3, $4, $5, 'annual', 1, DATE '2026-10-01', \
                     DATE '2026-10-01', $6, 'pending')",
        )
        .bind(id)
        .bind(*org.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*requester.as_uuid())
        .bind(employee)
        .bind(reason)
        .execute(&definer_pool)
        .await
        .unwrap();
    }

    let auth = test_auth_with_roles(decider, org, vec![branch], vec!["ADMIN"]);
    let runtime_pool = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let service = router(LeaveRestState::new(
        PgLeaveStore::new(
            runtime_pool.clone(),
            Arc::new(PgInboxStore::new(runtime_pool)),
        )
        .with_leave_command_pool(command_pool),
        Some(auth.verifier),
    ));

    let versionless = request_json(
        service.clone(),
        "POST",
        &format!("/api/v1/leave/requests/{v1_request}/decide"),
        &auth.token,
        Some(json!({"decision": "reject", "comment": "v1 reject"})),
    )
    .await;
    assert_eq!(versionless.status, StatusCode::OK, "{:?}", versionless.body);
    assert_eq!(versionless.body["status"], "rejected");
    let legacy_keys = versionless
        .body
        .as_object()
        .expect("v1 decision response must be an object")
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        legacy_keys,
        std::collections::BTreeSet::from([
            "branch_id",
            "created_at",
            "days",
            "decided_at",
            "decided_by",
            "decision_comment",
            "end_date",
            "id",
            "leave_type",
            "reason",
            "requester_user_id",
            "start_date",
            "status",
            "subject_employee_id",
        ]),
        "v1 must remain byte-shape compatible with the deployed strict client"
    );

    let repeated = request_json(
        service.clone(),
        "POST",
        &format!("/api/v1/leave/requests/{v1_request}/decide"),
        &auth.token,
        Some(json!({"decision": "reject", "comment": "repeated"})),
    )
    .await;
    assert_eq!(repeated.status, StatusCode::CONFLICT, "{:?}", repeated.body);
    assert_eq!(repeated.body["error"]["code"], "conflict");

    let stale_modern = request_json(
        service.clone(),
        "POST",
        &format!("/api/v2/leave/requests/{modern_request}/decide"),
        &auth.token,
        Some(json!({
            "expected_version": 99,
            "decision": "reject",
            "comment": "stale"
        })),
    )
    .await;
    assert_eq!(
        stale_modern.status,
        StatusCode::CONFLICT,
        "{:?}",
        stale_modern.body
    );
    assert_eq!(
        stale_modern.body["error"]["code"],
        "leave_concurrent_modification"
    );

    let legacy_page = request_json(
        service.clone(),
        "GET",
        "/api/v1/leave/requests",
        &auth.token,
        None,
    )
    .await;
    assert_eq!(legacy_page.status, StatusCode::OK, "{:?}", legacy_page.body);
    assert!(legacy_page.body.get("next_cursor").is_none());
    assert!(
        legacy_page.body["items"][0]
            .get("request_version")
            .is_none()
    );

    let v2_page = request_json(service, "GET", "/api/v2/leave/requests", &auth.token, None).await;
    assert_eq!(v2_page.status, StatusCode::OK, "{:?}", v2_page.body);
    assert!(v2_page.body.get("next_cursor").is_some());
    assert!(v2_page.body["items"][0].get("request_version").is_some());
}

struct TestAuth {
    token: String,
    verifier: JwtVerifier,
}

fn test_auth(user_id: UserId, org: OrgId, branches: Vec<BranchId>) -> TestAuth {
    test_auth_with_roles(user_id, org, branches, vec!["MEMBER"])
}

fn test_auth_with_roles(
    user_id: UserId,
    org: OrgId,
    branches: Vec<BranchId>,
    roles: Vec<&str>,
) -> TestAuth {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let settings = JwtSettings {
        issuer: TEST_ISSUER.to_owned(),
        audience: TEST_AUDIENCE.to_owned(),
        access_token_ttl: Duration::minutes(15),
    };
    let verifier =
        JwtVerifier::from_es256_public_pem(settings.clone(), public_pem.as_bytes()).unwrap();
    let issuer =
        JwtIssuer::from_es256_pem(settings, private_pem.as_bytes(), public_pem.as_bytes()).unwrap();
    let token = issuer
        .issue_access_token(AccessTokenInput {
            subject: user_id,
            org_id: org,
            roles: roles.into_iter().map(str::to_owned).collect(),
            branches,
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
        .unwrap();
    TestAuth { token, verifier }
}

async fn leave_command_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_leave_cmd")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn leave_definer_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_leave_definer")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn seed_branch_admin(pool: &PgPool, org: OrgId, branch: BranchId, user: UserId) {
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id) \
         VALUES ($1, 'Leave branch admin', ARRAY['ADMIN'], $2)",
    )
    .bind(*user.as_uuid())
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_subject(pool: &PgPool, org: OrgId, branch: BranchId, user: UserId, employee: Uuid) {
    let region = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
        .bind(*org.as_uuid())
        .bind(format!(
            "leave-http-{}",
            &org.as_uuid().simple().to_string()[..12]
        ))
        .bind("Leave HTTP proof")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
        .bind(region)
        .bind(format!("Leave HTTP region {region}"))
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*branch.as_uuid())
        .bind(region)
        .bind("Leave HTTP branch")
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    let definer_pool = leave_definer_role_pool(pool).await;
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(org.as_uuid().to_string())
        .execute(&definer_pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, \
         source_row, source_key, leave_accrued, leave_used, leave_remaining, home_branch_id) \
         VALUES ($1, $2, 'OYATIE', 'Member employee', 'test.xlsx', 'employees', 1, $3, 15, 2, 13, $4)",
    )
    .bind(employee)
    .bind(*org.as_uuid())
    .bind(format!("leave-http-{employee}"))
    .bind(*branch.as_uuid())
    .execute(&definer_pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, employee_id) \
         VALUES ($1, 'Leave member', ARRAY['MEMBER'], $2, $3)",
    )
    .bind(*user.as_uuid())
    .bind(*org.as_uuid())
    .bind(employee)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

struct JsonResponse {
    status: StatusCode,
    body: Value,
}

async fn request_json(
    service: axum::Router,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> JsonResponse {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    let body = match body {
        Some(body) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&body).unwrap())
        }
        None => Body::empty(),
    };
    let response = service.oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    JsonResponse { status, body }
}
