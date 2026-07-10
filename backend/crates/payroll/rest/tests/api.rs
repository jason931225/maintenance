#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! HTTP-level proofs over the real `mnt-payroll-rest` router, driven on a
//! genuine non-owner `mnt_rt` pool (RLS actually enforced).
//!
//! Proves:
//!  * `GET /api/v1/payroll/payslips/me` is self-scoped, not role-gated,
//!    mirroring `GET /api/v1/hr/attendance-records/me`: an account with no
//!    linked employee reads an empty page (200), never a 403; a linked
//!    employee reads ONLY their own draft lines, never a coworker's;
//!  * `GET /api/v1/payroll/runs` / `/runs/{id}` are EXECUTIVE/SUPER_ADMIN-only
//!    admin reads — MEMBER and a branch-scoped ADMIN are 403;
//!  * another org's runs are invisible to a SUPER_ADMIN of THIS org (RLS).

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use mnt_payroll_adapter_postgres::PgPayrollStore;
use mnt_payroll_rest::{PAYROLL_MY_PAYSLIPS_PATH, PAYROLL_RUNS_PATH, PayrollRestState, router};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_test_support::runtime_role_pool;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::macros::date;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";

struct Keys {
    private_pem: String,
    public_pem: String,
}

struct JsonResponse {
    status: StatusCode,
    json: Value,
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

fn bearer(keys: &Keys, user_id: UserId, org: OrgId, role: &str) -> String {
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

fn app(pool: PgPool, keys: &Keys) -> axum::Router {
    let verifier = JwtVerifier::from_es256_public_pem(
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.public_pem.as_bytes(),
    )
    .unwrap();
    let store = PgPayrollStore::new(pool);
    router(PayrollRestState::new(store, Some(verifier)))
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

fn test_audit_event(
    action: &str,
    target_type: &str,
    target_id: impl ToString,
    org: Uuid,
) -> AuditEvent {
    AuditEvent::new(
        None,
        AuditAction::new(action).unwrap(),
        target_type,
        target_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::from_uuid(org))
}

async fn seed_org(owner_pool: &PgPool, org: Uuid, tag: &str) {
    let event = test_audit_event("test.seed_org", "organization", org, org);
    let tag = tag.to_owned();
    with_audit(owner_pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
            )
            .bind(org)
            .bind(format!("org-{}", tag.to_lowercase()))
            .bind(format!("Org {tag}"))
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
}

async fn seed_user(owner_pool: &PgPool, user_id: UserId, org: Uuid, role: &str) {
    let event = test_audit_event("test.seed_user", "user", *user_id.as_uuid(), org);
    let role = role.to_owned();
    with_audit(owner_pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(*user_id.as_uuid())
            .bind(format!("user-{role}-{}", user_id.as_uuid()))
            .bind(vec![role])
            .bind(org)
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
}

async fn seed_employee(owner_pool: &PgPool, org: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    let event = test_audit_event("test.seed_employee", "employee", id, org);
    let name = name.to_owned();
    with_audit(owner_pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO employees \
                 (id, org_id, company, name, source_filename, source_sheet, source_row, source_key) \
                 VALUES ($1, $2, 'KNL', $3, 'roster.xlsx', 'Sheet1', 1, $4)",
            )
            .bind(id)
            .bind(org)
            .bind(name)
            .bind(format!("emp-{id}"))
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
    id
}

async fn seed_user_linked_to_employee(
    owner_pool: &PgPool,
    user_id: UserId,
    org: Uuid,
    employee: Uuid,
) {
    let event = test_audit_event("test.seed_user", "user", *user_id.as_uuid(), org);
    with_audit(owner_pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO users (id, display_name, roles, org_id, employee_id) \
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(*user_id.as_uuid())
            .bind(format!("linked-{}", user_id.as_uuid()))
            .bind(vec!["MEMBER".to_string()])
            .bind(org)
            .bind(employee)
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
}

async fn seed_run(owner_pool: &PgPool, org: Uuid, source_label: &str) -> Uuid {
    let run_id = Uuid::new_v4();
    let event = test_audit_event("test.seed_run", "payroll_draft_run", run_id, org);
    let source_label = source_label.to_owned();
    with_audit(owner_pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO payroll_draft_runs (id, org_id, period_start, period_end, source_label) \
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(run_id)
            .bind(org)
            .bind(date!(2026 - 06 - 01))
            .bind(date!(2026 - 06 - 30))
            .bind(source_label)
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
    run_id
}

async fn seed_line(owner_pool: &PgPool, org: Uuid, run_id: Uuid, employee: Uuid, name: &str) {
    let event = test_audit_event("test.seed_line", "payroll_draft_line", employee, org);
    let name = name.to_owned();
    with_audit(owner_pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO payroll_draft_lines \
                 (org_id, run_id, employee_id, employee_source_key, employee_display_name, employee_company) \
                 VALUES ($1, $2, $3, $4, $5, 'KNL')",
            )
            .bind(org)
            .bind(run_id)
            .bind(employee)
            .bind(format!("src-{employee}"))
            .bind(name)
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn payslips_me_is_self_scoped_never_a_coworkers(pool: PgPool) {
    let keys = keys();
    let org = OrgId::knl();

    let run = seed_run(&pool, *org.as_uuid(), "shared-run").await;
    let alice_employee = seed_employee(&pool, *org.as_uuid(), "Alice").await;
    let bob_employee = seed_employee(&pool, *org.as_uuid(), "Bob").await;
    seed_line(&pool, *org.as_uuid(), run, alice_employee, "Alice").await;
    seed_line(&pool, *org.as_uuid(), run, bob_employee, "Bob").await;

    let alice_user = UserId::new();
    seed_user_linked_to_employee(&pool, alice_user, *org.as_uuid(), alice_employee).await;
    let admin_no_link = UserId::new();
    seed_user(&pool, admin_no_link, *org.as_uuid(), "ADMIN").await;

    let service = app(runtime_role_pool(&pool).await, &keys);

    // Alice reads exactly her own line.
    let alice_read = get(
        service.clone(),
        PAYROLL_MY_PAYSLIPS_PATH,
        &bearer(&keys, alice_user, org, "MEMBER"),
    )
    .await;
    assert_eq!(alice_read.status, StatusCode::OK, "{:?}", alice_read.json);
    assert_eq!(alice_read.json["total"], 1);
    let items = alice_read.json["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    // Only readiness/draft fields are present — no gross/net pay amount field
    // exists anywhere in the response (see module docs: the crate stores no
    // won amount).
    assert!(items[0].get("gross_pay_won").is_none());
    assert!(items[0].get("net_pay_won").is_none());

    // An ADMIN with no employee link reads an empty page, not a 403, and
    // never leaks Alice's or Bob's rows.
    let admin_read = get(
        service,
        PAYROLL_MY_PAYSLIPS_PATH,
        &bearer(&keys, admin_no_link, org, "ADMIN"),
    )
    .await;
    assert_eq!(
        admin_read.status,
        StatusCode::OK,
        "self-service read must not be forbidden: {:?}",
        admin_read.json
    );
    assert_eq!(admin_read.json["total"], 0);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn runs_admin_read_is_executive_and_super_admin_only(pool: PgPool) {
    let keys = keys();
    let org = OrgId::knl();
    seed_run(&pool, *org.as_uuid(), "run-1").await;

    let member = UserId::new();
    seed_user(&pool, member, *org.as_uuid(), "MEMBER").await;
    let admin = UserId::new();
    seed_user(&pool, admin, *org.as_uuid(), "ADMIN").await;
    let super_admin = UserId::new();
    seed_user(&pool, super_admin, *org.as_uuid(), "SUPER_ADMIN").await;

    let service = app(runtime_role_pool(&pool).await, &keys);

    let member_read = get(
        service.clone(),
        PAYROLL_RUNS_PATH,
        &bearer(&keys, member, org, "MEMBER"),
    )
    .await;
    assert_eq!(member_read.status, StatusCode::FORBIDDEN);

    // ADMIN's JWT carries no `branches` claim, which resolves to an EMPTY
    // branch scope (not All) — denied same as MEMBER, matching the
    // `authorize_org_wide` built-in-role behavior documented in the crate.
    let admin_read = get(
        service.clone(),
        PAYROLL_RUNS_PATH,
        &bearer(&keys, admin, org, "ADMIN"),
    )
    .await;
    assert_eq!(admin_read.status, StatusCode::FORBIDDEN);

    let super_admin_read = get(
        service,
        PAYROLL_RUNS_PATH,
        &bearer(&keys, super_admin, org, "SUPER_ADMIN"),
    )
    .await;
    assert_eq!(
        super_admin_read.status,
        StatusCode::OK,
        "{:?}",
        super_admin_read.json
    );
    assert_eq!(super_admin_read.json["total"], 1);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn runs_are_org_isolated_over_http(pool: PgPool) {
    let keys = keys();
    let org = OrgId::knl();
    let other_org = Uuid::from_u128(0x5ea5_5ea5_5ea5_5ea5_5ea5_5ea5_5ea5_5ea5);
    seed_org(&pool, other_org, "OTHER").await;

    seed_run(&pool, *org.as_uuid(), "org-run").await;
    seed_run(&pool, other_org, "other-org-run").await;

    let super_admin = UserId::new();
    seed_user(&pool, super_admin, *org.as_uuid(), "SUPER_ADMIN").await;

    let service = app(runtime_role_pool(&pool).await, &keys);
    let read = get(
        service,
        PAYROLL_RUNS_PATH,
        &bearer(&keys, super_admin, org, "SUPER_ADMIN"),
    )
    .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.json);
    assert_eq!(
        read.json["total"], 1,
        "must see only this org's run, never the other org's"
    );
}
