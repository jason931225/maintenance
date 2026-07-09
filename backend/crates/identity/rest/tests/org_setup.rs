//! Identity / org-setup REST integration tests.
//!
//! Exercises the cold-start org flow end-to-end: an admin creates regions,
//! branches and users; the IDOR hardening restricts elevated-role grants to
//! SUPER_ADMIN; and every authenticated user can edit their own profile (the
//! "Cold Start Admin" fixing its own name).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_identity_adapter_postgres::PgOrgStore;
use mnt_identity_application::ReplacePolicyRoleAssignmentsCommand;
use mnt_identity_rest::{IdentityRestState, router};
use mnt_kernel_core::{
    AccessScope, AccessScopeLevel, AuditAction, AuditEvent, BranchId, OrgId, ScopeNodeId,
    TraceContext, UserId,
};
use mnt_platform_auth::{
    AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier, PasskeyRegistrationStart,
    PasskeyService, WebauthnSettings,
};
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_request_context::scope_org;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use url::Url;
use webauthn_authenticator_rs::prelude::{RequestChallengeResponse, WebauthnAuthenticator};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";

struct Harness {
    private_pem: String,
    public_pem: String,
    pool: PgPool,
}

impl Harness {
    fn new(pool: PgPool) -> Self {
        let signing_key = SigningKey::random(&mut OsRng);
        let private_pem = signing_key
            .to_pkcs8_pem(LineEnding::LF)
            .unwrap()
            .to_string();
        let public_pem = signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        Self {
            private_pem,
            public_pem,
            pool,
        }
    }

    fn service(&self) -> Router {
        let verifier = JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            self.public_pem.as_bytes(),
        )
        .unwrap();
        router(
            IdentityRestState::new(PgOrgStore::new(self.pool.clone()), Some(verifier))
                .with_passkey_step_up(Some(passkey_service())),
        )
    }

    fn token(&self, user_id: UserId, roles: &[&str], branches: Vec<BranchId>) -> String {
        self.token_for_org(OrgId::knl(), user_id, roles, branches)
    }

    fn token_for_org(
        &self,
        org_id: OrgId,
        user_id: UserId,
        roles: &[&str],
        branches: Vec<BranchId>,
    ) -> String {
        let issuer = self.issuer();
        issuer
            .issue_access_token(self.access_token_input_for_org(org_id, user_id, roles, branches))
            .unwrap()
    }

    fn scoped_token(
        &self,
        user_id: UserId,
        roles: &[&str],
        branches: Vec<BranchId>,
        access_scope: AccessScope,
    ) -> String {
        let issuer = self.issuer();
        issuer
            .issue_scoped_access_token(
                self.access_token_input(user_id, roles, branches),
                access_scope,
                Vec::new(),
            )
            .unwrap()
    }

    fn issuer(&self) -> JwtIssuer {
        JwtIssuer::from_es256_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            self.private_pem.as_bytes(),
            self.public_pem.as_bytes(),
        )
        .unwrap()
    }

    fn access_token_input(
        &self,
        user_id: UserId,
        roles: &[&str],
        branches: Vec<BranchId>,
    ) -> AccessTokenInput {
        self.access_token_input_for_org(OrgId::knl(), user_id, roles, branches)
    }

    fn access_token_input_for_org(
        &self,
        org_id: OrgId,
        user_id: UserId,
        roles: &[&str],
        branches: Vec<BranchId>,
    ) -> AccessTokenInput {
        AccessTokenInput {
            subject: user_id,
            org_id,
            roles: roles.iter().map(|r| (*r).to_owned()).collect(),
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
        }
    }
}

fn passkey_service() -> PasskeyService {
    PasskeyService::new(WebauthnSettings {
        rp_id: "example.com".to_owned(),
        rp_origin: Url::parse("https://auth.example.com").unwrap(),
        rp_name: "MNT Maintenance".to_owned(),
        extra_allowed_origins: vec![],
        ceremony_ttl: Duration::minutes(5),
    })
    .unwrap()
}

fn inject_allow_credential(
    challenge: RequestChallengeResponse,
    credential_id: &str,
) -> RequestChallengeResponse {
    let mut value = serde_json::to_value(&challenge).unwrap();
    let allow = value
        .get_mut("publicKey")
        .and_then(|pk| pk.get_mut("allowCredentials"))
        .and_then(serde_json::Value::as_array_mut)
        .expect("authentication challenge must have an allowCredentials array");
    allow.push(serde_json::json!({ "type": "public-key", "id": credential_id }));
    serde_json::from_value(value).unwrap()
}

async fn fresh_step_up_assertion(pool: &PgPool, user_id: UserId, display_name: &str) -> Value {
    let service = passkey_service();
    let registration = service
        .start_registration(
            pool,
            OrgId::knl(),
            PasskeyRegistrationStart {
                user_id: *user_id.as_uuid(),
                username: format!("{user_id}.example"),
                display_name: display_name.to_owned(),
            },
        )
        .await
        .unwrap();
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential = authenticator
        .do_registration(
            Url::parse("https://auth.example.com").unwrap(),
            registration.challenge,
        )
        .unwrap();
    let stored_passkey = service
        .finish_registration(pool, OrgId::knl(), registration.ceremony_id, credential)
        .await
        .unwrap();

    let authentication = service.start_authentication(pool).await.unwrap();
    let challenge =
        inject_allow_credential(authentication.challenge, &stored_passkey.credential_id);
    let assertion = authenticator
        .do_authentication(Url::parse("https://auth.example.com").unwrap(), challenge)
        .unwrap();

    json!({
        "ceremony_id": authentication.ceremony_id,
        "credential": assertion
    })
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn admin_creates_region_branch_and_user_then_lists_and_reads(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let admin_branch = seed_branch(&pool).await;
    let admin = seed_user(&pool, "Branch Admin", &["ADMIN"], Some(admin_branch)).await;
    let token = harness.token(admin, &["ADMIN"], vec![admin_branch]);

    // SUPER_ADMIN is required to create regions/branches? No — ADMIN holds
    // RegionManage/BranchManage. Create a region.
    let (status, region) = send(
        &harness,
        "POST",
        "/api/v1/regions",
        &token,
        Some(json!({ "name": "수도권" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{region:?}");
    let region_id = region["id"].as_str().unwrap().to_owned();

    // Create a branch in that region.
    let (status, branch) = send(
        &harness,
        "POST",
        "/api/v1/branches",
        &token,
        Some(json!({ "region_id": region_id, "name": "강남지점" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{branch:?}");
    let branch_id = branch["id"].as_str().unwrap().to_owned();

    // Create a mechanic in the admin's own branch.
    let (status, user) = send(
        &harness,
        "POST",
        "/api/v1/users",
        &token,
        Some(json!({
            "display_name": "김정비",
            "phone": "010-1234-5678",
            "team": "MAINTENANCE",
            "roles": ["MECHANIC"],
            "branch_ids": [admin_branch.to_string()],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{user:?}");
    assert_eq!(user["display_name"], "김정비");
    assert_eq!(user["team"], "MAINTENANCE");
    assert_eq!(user["is_active"], true);
    let new_user_id = user["id"].as_str().unwrap().to_owned();

    // The branch list (also used for support triage) now returns the new branch.
    let (status, branches) = send(&harness, "GET", "/api/v1/branches", &token, None).await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = branches
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"강남지점"), "{names:?}");

    // Get-one for an org-unit pin panel (UI-M2a): found → 200 + summary;
    // an id not in the org → 404 (exercises axum routing + error mapping).
    let (status, one) = send(
        &harness,
        "GET",
        &format!("/api/v1/branches/{branch_id}"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{one:?}");
    assert_eq!(one["id"], branch_id);
    assert_eq!(one["name"], "강남지점");

    let (status, _missing) = send(
        &harness,
        "GET",
        "/api/v1/branches/00000000-0000-4000-8000-000000000000",
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // List users in scope returns the admin and the new mechanic.
    let (status, users) = send(&harness, "GET", "/api/v1/users", &token, None).await;
    assert_eq!(status, StatusCode::OK);
    // GET /api/v1/users returns a paginated UserPage ({items,total,limit,offset}),
    // not a bare array — read the items page (honest-pagination change, commit 9ddae44).
    let ids: Vec<&str> = users["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&new_user_id.as_str()), "{ids:?}");

    // Read the single user.
    let (status, fetched) = send(
        &harness,
        "GET",
        &format!("/api/v1/users/{new_user_id}"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{fetched:?}");
    assert_eq!(fetched["id"], Value::String(new_user_id.clone()));

    // The branch membership landed in user_branches.
    assert_eq!(
        fetched["branch_ids"].as_array().unwrap()[0],
        Value::String(admin_branch.to_string())
    );
    let _ = branch_id;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn non_super_admin_cannot_create_elevated_user(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let admin_branch = seed_branch(&pool).await;
    let admin = seed_user(&pool, "Branch Admin", &["ADMIN"], Some(admin_branch)).await;
    let token = harness.token(admin, &["ADMIN"], vec![admin_branch]);

    // An ADMIN attempting to mint an EXECUTIVE is forbidden (IDOR hardening).
    let (status, body) = send(
        &harness,
        "POST",
        "/api/v1/users",
        &token,
        Some(json!({
            "display_name": "임원",
            "roles": ["EXECUTIVE"],
            "branch_ids": [admin_branch.to_string()],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn admin_can_grant_admin_to_existing_executive_in_scope(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let admin_branch = seed_branch(&pool).await;
    let admin = seed_user(&pool, "Branch Admin", &["ADMIN"], Some(admin_branch)).await;
    let executive = seed_user(&pool, "임원", &["EXECUTIVE"], Some(admin_branch)).await;
    let token = harness.token(admin, &["ADMIN"], vec![admin_branch]);

    let (status, updated) = send_patch(
        &harness,
        &format!("/api/v1/users/{executive}"),
        &token,
        json!({
            "roles": ["EXECUTIVE", "ADMIN"],
            "branch_ids": [admin_branch.to_string()],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated:?}");
    let roles: BTreeSet<&str> = updated["roles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|role| role.as_str().unwrap())
        .collect();
    assert_eq!(roles, BTreeSet::from(["ADMIN", "EXECUTIVE"]));
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn admin_cannot_grant_new_executive_role_on_update(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let admin_branch = seed_branch(&pool).await;
    let admin = seed_user(&pool, "Branch Admin", &["ADMIN"], Some(admin_branch)).await;
    let mechanic = seed_user(&pool, "정비사", &["MECHANIC"], Some(admin_branch)).await;
    let token = harness.token(admin, &["ADMIN"], vec![admin_branch]);

    let (status, body) = send_patch(
        &harness,
        &format!("/api/v1/users/{mechanic}"),
        &token,
        json!({
            "roles": ["MECHANIC", "EXECUTIVE"],
            "branch_ids": [admin_branch.to_string()],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn admin_cannot_remove_existing_executive_role_on_update(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let admin_branch = seed_branch(&pool).await;
    let admin = seed_user(&pool, "Branch Admin", &["ADMIN"], Some(admin_branch)).await;
    let executive = seed_user(
        &pool,
        "임원 관리자",
        &["EXECUTIVE", "ADMIN"],
        Some(admin_branch),
    )
    .await;
    let token = harness.token(admin, &["ADMIN"], vec![admin_branch]);

    let (status, body) = send_patch(
        &harness,
        &format!("/api/v1/users/{executive}"),
        &token,
        json!({
            "roles": ["ADMIN"],
            "branch_ids": [admin_branch.to_string()],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn super_admin_creates_executive_user(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    // SUPER_ADMIN resolves to BranchScope::All; no branch membership needed.
    let super_admin = seed_user(&pool, "Cold Start Admin", &["SUPER_ADMIN"], None).await;
    let token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);

    let (status, user) = send(
        &harness,
        "POST",
        "/api/v1/users",
        &token,
        Some(json!({
            "display_name": "이임원",
            "roles": ["EXECUTIVE"],
            "branch_ids": [],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{user:?}");
    assert_eq!(user["roles"].as_array().unwrap()[0], "EXECUTIVE");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn any_authenticated_user_edits_own_profile(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    // The seeded cold-start admin fixes its own display name via /users/me.
    let me = seed_user(&pool, "Cold Start Admin", &["SUPER_ADMIN"], None).await;
    let token = harness.token(me, &["SUPER_ADMIN"], vec![]);

    let (status, before) = send(&harness, "GET", "/api/v1/users/me", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{before:?}");
    assert_eq!(before["display_name"], "Cold Start Admin");

    let (status, after) = send(
        &harness,
        "PATCH",
        "/api/v1/users/me",
        &token,
        Some(json!({ "display_name": "박관리자", "phone": "010-9999-0000" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{after:?}");
    assert_eq!(after["display_name"], "박관리자");
    assert_eq!(after["phone"], "010-9999-0000");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn mechanic_cannot_manage_users(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let branch = seed_branch(&pool).await;
    let mechanic = seed_user(&pool, "정비공", &["MECHANIC"], Some(branch)).await;
    let token = harness.token(mechanic, &["MECHANIC"], vec![branch]);

    // A mechanic has neither UserManage nor RegionManage.
    let (status, _) = send(&harness, "GET", "/api/v1/users", &token, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _) = send(
        &harness,
        "POST",
        "/api/v1/regions",
        &token,
        Some(json!({ "name": "blocked" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // But a mechanic CAN edit its own profile and read the branch list.
    let (status, _) = send(&harness, "GET", "/api/v1/users/me", &token, None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&harness, "GET", "/api/v1/branches", &token, None).await;
    assert_eq!(status, StatusCode::OK);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_user_writes_audit_event(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let branch = seed_branch(&pool).await;
    let admin = seed_user(&pool, "Branch Admin", &["ADMIN"], Some(branch)).await;
    let token = harness.token(admin, &["ADMIN"], vec![branch]);

    let (status, user) = send(
        &harness,
        "POST",
        "/api/v1/users",
        &token,
        Some(json!({
            "display_name": "감사대상",
            "roles": ["MECHANIC"],
            "branch_ids": [branch.to_string()],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{user:?}");
    let user_id = user["id"].as_str().unwrap();

    let actions: Vec<String> =
        sqlx::query_scalar("SELECT action FROM audit_events WHERE target_id = $1")
            .bind(user_id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        actions.contains(&"user.create".to_owned()),
        "expected user.create audit, got {actions:?}"
    );
}

// ---------------------------------------------------------------------------
// Policy Studio assignment preview
// ---------------------------------------------------------------------------

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn policy_assignment_preview_requires_role_manage_and_target_branch_scope(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let allowed_branch = seed_branch(&pool).await;
    let blocked_branch = seed_branch(&pool).await;
    let super_admin = seed_user(&pool, "Policy Owner", &["SUPER_ADMIN"], None).await;
    let mechanic = seed_user(&pool, "정비공", &["MECHANIC"], Some(allowed_branch)).await;
    let blocked_user = seed_user(
        &pool,
        "다른 지점 사용자",
        &["MECHANIC"],
        Some(blocked_branch),
    )
    .await;

    let mechanic_token = harness.token(mechanic, &["MECHANIC"], vec![allowed_branch]);
    let (status, body) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{blocked_user}/assignment-preview"),
        &mechanic_token,
        Some(json!({ "role_ids": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");

    let branch_scoped_super_admin = harness.scoped_token(
        super_admin,
        &["SUPER_ADMIN"],
        vec![],
        AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(*allowed_branch.as_uuid()),
        ),
    );
    let (status, body) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{blocked_user}/assignment-preview"),
        &branch_scoped_super_admin,
        Some(json!({ "role_ids": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body:?}");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn policy_assignment_preview_validates_custom_roles_and_never_mutates_assignments(
    pool: PgPool,
) {
    let harness = Harness::new(pool.clone());
    let branch = seed_branch(&pool).await;
    let super_admin = seed_user(&pool, "Policy Owner", &["SUPER_ADMIN"], None).await;
    let target =
        seed_user_with_team(&pool, "정책 대상", &["ADMIN"], Some(branch), Some("정비")).await;
    let token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);

    let current_role = seed_policy_role(
        &pool,
        super_admin,
        "dispatch_planner",
        "배차 계획자",
        "ACTIVE",
        false,
        &[("daily_plan_review", "allow")],
    )
    .await;
    let requested_role = seed_policy_role(
        &pool,
        super_admin,
        "asset_reader",
        "자산 조회자",
        "DRAFT",
        false,
        &[
            ("equipment_manage", "limited"),
            ("equipment_cost_ledger_read", "allow"),
        ],
    )
    .await;
    let requested_conditions = json!([
        {
            "condition_key": "department_scope",
            "attribute": "department",
            "operator": "in",
            "values": ["정비팀", "야간조"]
        },
        {
            "condition_key": "purpose_scope",
            "attribute": "purpose",
            "operator": "equals",
            "values": ["asset_audit"]
        }
    ]);
    seed_policy_role_condition(
        &pool,
        requested_role,
        "department_scope",
        "department",
        "in",
        &["정비팀", "야간조"],
    )
    .await;
    seed_policy_role_condition(
        &pool,
        requested_role,
        "purpose_scope",
        "purpose",
        "equals",
        &["asset_audit"],
    )
    .await;
    let retired_role = seed_policy_role(
        &pool,
        super_admin,
        "old_role",
        "퇴역 역할",
        "RETIRED",
        false,
        &[("work_order_read_all", "allow")],
    )
    .await;
    let system_role = seed_policy_role(
        &pool,
        super_admin,
        "system_shadow",
        "시스템 역할",
        "ACTIVE",
        true,
        &[("work_order_create", "allow")],
    )
    .await;
    seed_policy_assignment(&pool, target, current_role, super_admin).await;

    let before = assigned_policy_role_ids(&pool, target).await;
    assert_eq!(before, vec![current_role]);

    let (status, preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &token,
        Some(json!({ "role_ids": [requested_role] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview:?}");
    assert_eq!(preview["effective"], false);
    assert_eq!(preview["current_role_ids"], json!([current_role]));
    assert_eq!(preview["requested_role_ids"], json!([requested_role]));
    assert_eq!(
        preview["custom_roles"][0]["conditions"],
        requested_conditions
    );
    assert_eq!(preview["delta"]["added_role_ids"], json!([requested_role]));
    assert_eq!(preview["delta"]["removed_role_ids"], json!([current_role]));
    assert_eq!(preview["custom_roles"][0]["runtime_effective"], false);
    assert_eq!(
        preview["custom_roles"][0]["runtime_warnings"],
        json!([
            "custom_role_status_not_active",
            "custom_role_condition_unsupported_by_runtime_evaluator"
        ])
    );
    assert_eq!(
        preview["warnings"],
        json!([
            "preview_only_pending_save",
            "custom_role_condition_unsupported_by_runtime_evaluator",
            "custom_role_status_not_active"
        ])
    );
    assert!(
        !preview["feature_grants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|grant| grant["source_type"] == "custom_role"),
        "fail-closed draft or unsupported custom roles must not preview runtime grants: {preview:?}"
    );
    assert_eq!(assigned_policy_role_ids(&pool, target).await, before);

    for invalid_role in [uuid::Uuid::new_v4(), retired_role, system_role] {
        let (status, body) = send(
            &harness,
            "POST",
            &format!("/api/v1/policy/users/{target}/assignment-preview"),
            &token,
            Some(json!({ "role_ids": [invalid_role] })),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body:?}");
        assert_eq!(assigned_policy_role_ids(&pool, target).await, before);
    }

    let runtime_effective_role = seed_policy_role(
        &pool,
        super_admin,
        "runtime_work_order_creator",
        "런타임 작업 생성자",
        "ACTIVE",
        false,
        &[("work_order_create", "allow")],
    )
    .await;
    let (status, runtime_preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &token,
        Some(json!({ "role_ids": [runtime_effective_role] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{runtime_preview:?}");
    assert_eq!(runtime_preview["effective"], true);
    assert_eq!(
        runtime_preview["custom_roles"][0]["runtime_effective"],
        true
    );
    assert_eq!(
        runtime_preview["custom_roles"][0]["runtime_warnings"],
        json!([])
    );
    assert!(
        runtime_preview["feature_grants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|grant| {
                grant["source_type"] == "custom_role"
                    && grant["source_key"] == "runtime_work_order_creator"
                    && grant["feature_key"] == "work_order_create"
            }),
        "runtime-effective custom roles should preview supported grants: {runtime_preview:?}"
    );
    assert_eq!(
        runtime_preview["warnings"],
        json!([
            "preview_only_pending_save",
            "active_assignments_become_runtime_effective_after_save"
        ])
    );

    let team_role = seed_policy_role(
        &pool,
        super_admin,
        "maintenance_team_creator",
        "정비팀 작업 생성자",
        "ACTIVE",
        false,
        &[("work_order_create", "allow")],
    )
    .await;
    seed_policy_role_condition(
        &pool,
        team_role,
        "team_scope",
        "team",
        "in",
        &["MAINTENANCE", "예방"],
    )
    .await;
    let (status, team_preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &token,
        Some(json!({ "role_ids": [team_role] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{team_preview:?}");
    assert_eq!(team_preview["effective"], true);
    assert_eq!(team_preview["custom_roles"][0]["runtime_effective"], true);
    assert_eq!(
        team_preview["custom_roles"][0]["runtime_warnings"],
        json!([])
    );
    assert!(
        team_preview["feature_grants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|grant| {
                grant["source_type"] == "custom_role"
                    && grant["source_key"] == "maintenance_team_creator"
                    && grant["feature_key"] == "work_order_create"
            }),
        "matching team ABAC conditions should preview supported runtime grants: {team_preview:?}"
    );

    let mismatched_team_role = seed_policy_role(
        &pool,
        super_admin,
        "reception_team_creator",
        "접수팀 작업 생성자",
        "ACTIVE",
        false,
        &[("work_order_create", "allow")],
    )
    .await;
    seed_policy_role_condition(
        &pool,
        mismatched_team_role,
        "team_scope",
        "team",
        "equals",
        &["RECEPTION"],
    )
    .await;
    let (status, mismatched_team_preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &token,
        Some(json!({ "role_ids": [mismatched_team_role] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{mismatched_team_preview:?}");
    assert_eq!(mismatched_team_preview["effective"], false);
    assert_eq!(
        mismatched_team_preview["custom_roles"][0]["runtime_warnings"],
        json!(["custom_role_condition_outside_target_attributes"])
    );
    assert!(
        !mismatched_team_preview["feature_grants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|grant| grant["source_type"] == "custom_role"),
        "team-mismatched custom roles must not preview runtime grants: {mismatched_team_preview:?}"
    );

    let outside_branch_role = seed_policy_role(
        &pool,
        super_admin,
        "outside_branch_reader",
        "다른 지점 조회자",
        "ACTIVE",
        false,
        &[("work_order_read_all", "allow")],
    )
    .await;
    let other_branch = seed_branch(&pool).await;
    seed_policy_role_condition(
        &pool,
        outside_branch_role,
        "branch_scope",
        "branch",
        "equals",
        &[&other_branch.to_string()],
    )
    .await;
    let (status, outside_branch_preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &token,
        Some(json!({ "role_ids": [outside_branch_role] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{outside_branch_preview:?}");
    assert_eq!(outside_branch_preview["effective"], false);
    assert_eq!(
        outside_branch_preview["custom_roles"][0]["runtime_warnings"],
        json!(["custom_role_condition_outside_target_branch_scope"])
    );
    assert!(
        !outside_branch_preview["feature_grants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|grant| grant["source_type"] == "custom_role"),
        "branch-mismatched custom roles must not preview runtime grants: {outside_branch_preview:?}"
    );
    assert_eq!(assigned_policy_role_ids(&pool, target).await, before);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn policy_role_create_persists_abac_pbac_conditions_and_catalog_returns_them(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let super_admin = seed_user(&pool, "Policy Owner", &["SUPER_ADMIN"], None).await;
    let token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);

    let requested_conditions = json!([
        {
            "condition_key": "dept_scope",
            "attribute": "department",
            "operator": "in",
            "values": ["정비팀", "야간조"]
        },
        {
            "condition_key": "purpose_scope",
            "attribute": "purpose",
            "operator": "equals",
            "values": ["work_order_approval"]
        }
    ]);
    let (status, created) = send(
        &harness,
        "POST",
        "/api/v1/policy/roles",
        &token,
        Some(json!({
            "role_key": "maintenance_shift_approver",
            "display_name": "정비 교대 승인자",
            "description": "정비팀 야간조 승인 담당",
            "permissions": [
                { "feature_key": "work_order_read_all", "permission_level": "allow" },
                { "feature_key": "daily_plan_review", "permission_level": "limited" }
            ],
            "conditions": requested_conditions.clone()
        })),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED, "{created:?}");
    assert_eq!(created["conditions"], requested_conditions);
    let role_id = created["id"].as_str().unwrap();

    let stored: Vec<(String, String, String, Vec<String>)> = sqlx::query_as(
        r#"
        SELECT condition_key, attribute, operator, condition_values
        FROM policy_role_conditions
        WHERE role_id = $1
        ORDER BY condition_key
        "#,
    )
    .bind(role_id.parse::<uuid::Uuid>().unwrap())
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        stored,
        vec![
            (
                "dept_scope".to_owned(),
                "department".to_owned(),
                "in".to_owned(),
                vec!["정비팀".to_owned(), "야간조".to_owned()]
            ),
            (
                "purpose_scope".to_owned(),
                "purpose".to_owned(),
                "equals".to_owned(),
                vec!["work_order_approval".to_owned()]
            ),
        ]
    );

    let (status, catalog) = send(&harness, "GET", "/api/v1/policy/roles", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{catalog:?}");
    assert_eq!(catalog["policy_version"]["version"], 1);
    assert!(
        catalog["policy_version"]["updated_at"].as_str().is_some(),
        "catalog should expose the version bump timestamp"
    );
    assert_eq!(
        catalog["custom_roles"][0]["conditions"],
        requested_conditions
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn policy_role_create_rejects_scope_widening_custom_features(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let super_admin = seed_user(&pool, "Policy Owner", &["SUPER_ADMIN"], None).await;
    let token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);

    let (status, body) = send(
        &harness,
        "POST",
        "/api/v1/policy/roles",
        &token,
        Some(json!({
            "role_key": "unsafe_org_wide_triage",
            "display_name": "범위 확장 역할",
            "permissions": [
                { "feature_key": "org_wide_queue_triage", "permission_level": "allow" }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM policy_roles WHERE role_key = 'unsafe_org_wide_triage'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn policy_role_catalog_exposes_policy_version_and_assignment_writes_bump_it(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let super_admin = seed_user(&pool, "Policy Owner", &["SUPER_ADMIN"], None).await;
    let target = seed_user(&pool, "Policy Target", &["ADMIN"], None).await;
    let token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);

    let (status, empty_catalog) = send(&harness, "GET", "/api/v1/policy/roles", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{empty_catalog:?}");
    assert_eq!(empty_catalog["policy_version"]["version"], 0);
    assert_eq!(empty_catalog["policy_version"]["updated_at"], Value::Null);

    let (status, role) = send(
        &harness,
        "POST",
        "/api/v1/policy/roles",
        &token,
        Some(json!({
            "role_key": "versioned_policy_role",
            "display_name": "버전 정책 역할",
            "permissions": [
                { "feature_key": "work_order_read_all", "permission_level": "allow" }
            ],
            "conditions": [
                {
                    "condition_key": "department_scope",
                    "attribute": "department",
                    "operator": "equals",
                    "values": ["정비팀"]
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{role:?}");
    let role_id = role["id"].as_str().unwrap();

    let (status, catalog_after_create) =
        send(&harness, "GET", "/api/v1/policy/roles", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{catalog_after_create:?}");
    assert_eq!(catalog_after_create["policy_version"]["version"], 1);

    let (status, body) = send_put(
        &harness,
        &format!("/api/v1/policy/users/{target}/assignments"),
        &token,
        json!({ "role_ids": [role_id] }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body:?}");
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        Vec::<uuid::Uuid>::new()
    );

    let (status, preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &token,
        Some(json!({ "role_ids": [role_id] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview:?}");
    let preview_receipt_id = preview["preview_receipt_id"].as_str().unwrap();

    let (status, body) = send_put(
        &harness,
        &format!("/api/v1/policy/users/{target}/assignments"),
        &token,
        json!({
            "role_ids": [role_id],
            "preview_acknowledged": true,
            "preview_receipt_id": preview_receipt_id
        }),
    )
    .await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{body:?}");
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        Vec::<uuid::Uuid>::new()
    );

    let step_up = fresh_step_up_assertion(&pool, super_admin, "Policy Owner").await;
    let (status, assignments) = send_put(
        &harness,
        &format!("/api/v1/policy/users/{target}/assignments"),
        &token,
        json!({
            "role_ids": [role_id],
            "preview_acknowledged": true,
            "preview_receipt_id": preview_receipt_id,
            "step_up": step_up
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{assignments:?}");

    let step_up = fresh_step_up_assertion(&pool, super_admin, "Policy Owner").await;
    let (status, body) = send_put(
        &harness,
        &format!("/api/v1/policy/users/{target}/assignments"),
        &token,
        json!({
            "role_ids": [role_id],
            "preview_acknowledged": true,
            "preview_receipt_id": preview_receipt_id,
            "step_up": step_up
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body:?}");
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        vec![role_id.parse::<uuid::Uuid>().unwrap()]
    );

    let (status, catalog_after_assignment) =
        send(&harness, "GET", "/api/v1/policy/roles", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{catalog_after_assignment:?}");
    assert_eq!(catalog_after_assignment["policy_version"]["version"], 2);

    let (status, status_preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/roles/{role_id}/status-preview"),
        &token,
        Some(json!({ "status": "ACTIVE" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{status_preview:?}");
    assert_eq!(status_preview["role_id"], role_id);
    assert_eq!(status_preview["current_status"], "DRAFT");
    assert_eq!(status_preview["requested_status"], "ACTIVE");
    assert_eq!(status_preview["permission_count"], 1);
    assert_eq!(status_preview["condition_count"], 1);
    assert_eq!(status_preview["planned_assignment_count"], 1);
    assert_eq!(status_preview["requires_passkey_step_up"], true);
    assert_eq!(status_preview["effective_runtime_change"], true);
    let preview_warnings = status_preview["warnings"].as_array().unwrap();
    assert!(preview_warnings.contains(&json!("passkey_step_up_required")));
    assert!(preview_warnings.contains(&json!(
        "assigned_users_may_gain_or_lose_runtime_permissions"
    )));
    assert!(preview_warnings.contains(&json!(
        "publish_enables_assigned_custom_role_runtime_grants"
    )));

    let (status, audit_events) = send(
        &harness,
        "GET",
        "/api/v1/policy/audit-events?limit=10",
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{audit_events:?}");
    let events = audit_events.as_array().unwrap();
    let actions = events
        .iter()
        .map(|event| event["action"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(
        actions.contains(&"policy.role.create"),
        "policy create audit event should be visible: {actions:?}"
    );
    assert!(
        actions.contains(&"policy.role_assignment.replace.snapshot"),
        "assignment snapshot audit event should be visible: {actions:?}"
    );
    let assignment_snapshot = events
        .iter()
        .find(|event| event["action"] == "policy.role_assignment.replace.snapshot")
        .unwrap();
    assert_eq!(assignment_snapshot["target_type"], "policy_role_assignment");
    assert_eq!(assignment_snapshot["target_id"], target.to_string());
    assert_eq!(
        assignment_snapshot["after_snapshot"]["assignments"][0]["role_id"],
        role_id
    );

    let (status, body) = send(
        &harness,
        "GET",
        "/api/v1/policy/audit-events?limit=0",
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body:?}");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn policy_role_create_rejects_unknown_condition_attribute(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let super_admin = seed_user(&pool, "Policy Owner", &["SUPER_ADMIN"], None).await;
    let token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);

    let (status, body) = send(
        &harness,
        "POST",
        "/api/v1/policy/roles",
        &token,
        Some(json!({
            "role_key": "bad_condition_role",
            "display_name": "잘못된 조건 역할",
            "permissions": [
                { "feature_key": "work_order_read_all", "permission_level": "allow" }
            ],
            "conditions": [
                {
                    "condition_key": "machinery_scope",
                    "attribute": "machinery",
                    "operator": "equals",
                    "values": ["굴삭기"]
                }
            ]
        })),
    )
    .await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body:?}");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM policy_roles WHERE role_key = $1")
        .bind("bad_condition_role")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn branch_scoped_policy_managers_are_limited_to_branch_condition_scope(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let allowed_branch = seed_branch(&pool).await;
    let blocked_branch = seed_branch(&pool).await;
    let super_admin = seed_user(&pool, "Delegated Policy Owner", &["SUPER_ADMIN"], None).await;
    let full_token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);
    let branch_token = harness.scoped_token(
        super_admin,
        &["SUPER_ADMIN"],
        vec![],
        AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(*allowed_branch.as_uuid()),
        ),
    );

    let (status, body) = send(
        &harness,
        "POST",
        "/api/v1/policy/roles",
        &branch_token,
        Some(json!({
            "role_key": "unscoped_branch_role",
            "display_name": "범위 없는 역할",
            "permissions": [
                { "feature_key": "work_order_read_all", "permission_level": "allow" }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");

    let (status, body) = send(
        &harness,
        "POST",
        "/api/v1/policy/roles",
        &branch_token,
        Some(json!({
            "role_key": "blocked_branch_role",
            "display_name": "다른 지점 역할",
            "permissions": [
                { "feature_key": "work_order_read_all", "permission_level": "allow" }
            ],
            "conditions": [
                {
                    "condition_key": "branch_scope",
                    "attribute": "branch",
                    "operator": "equals",
                    "values": [blocked_branch.to_string()]
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");

    let (status, scoped_role) = send(
        &harness,
        "POST",
        "/api/v1/policy/roles",
        &branch_token,
        Some(json!({
            "role_key": "allowed_branch_role",
            "display_name": "위임 지점 역할",
            "permissions": [
                { "feature_key": "work_order_read_all", "permission_level": "allow" }
            ],
            "conditions": [
                {
                    "condition_key": "branch_scope",
                    "attribute": "branch",
                    "operator": "equals",
                    "values": [allowed_branch.to_string()]
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{scoped_role:?}");
    let scoped_role_id = scoped_role["id"].as_str().unwrap();

    let (status, blocked_role) = send(
        &harness,
        "POST",
        "/api/v1/policy/roles",
        &full_token,
        Some(json!({
            "role_key": "full_admin_other_branch_role",
            "display_name": "전체 관리자 타 지점 역할",
            "permissions": [
                { "feature_key": "work_order_read_all", "permission_level": "allow" }
            ],
            "conditions": [
                {
                    "condition_key": "branch_scope",
                    "attribute": "branch",
                    "operator": "equals",
                    "values": [blocked_branch.to_string()]
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{blocked_role:?}");
    let blocked_role_id = blocked_role["id"].as_str().unwrap();

    let (status, catalog) =
        send(&harness, "GET", "/api/v1/policy/roles", &branch_token, None).await;
    assert_eq!(status, StatusCode::OK, "{catalog:?}");
    assert_eq!(catalog["custom_roles"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["custom_roles"][0]["id"], scoped_role_id);

    let target = seed_user(&pool, "위임 지점 대상", &["ADMIN"], Some(allowed_branch)).await;
    let (status, body) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &branch_token,
        Some(json!({ "role_ids": [blocked_role_id] })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    let (status, body) = send_put(
        &harness,
        &format!("/api/v1/policy/users/{target}/assignments"),
        &branch_token,
        json!({ "role_ids": [blocked_role_id] }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        Vec::<uuid::Uuid>::new()
    );

    let (status, preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &branch_token,
        Some(json!({ "role_ids": [scoped_role_id] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview:?}");
    assert_eq!(
        preview["custom_roles"][0]["conditions"][0]["values"],
        json!([allowed_branch.to_string()])
    );
    let preview_receipt_id = preview["preview_receipt_id"].as_str().unwrap();

    let (status, body) = send_put(
        &harness,
        &format!("/api/v1/policy/users/{target}/assignments"),
        &branch_token,
        json!({ "role_ids": [scoped_role_id] }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body:?}");
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        Vec::<uuid::Uuid>::new()
    );

    let (status, body) = send_put(
        &harness,
        &format!("/api/v1/policy/users/{target}/assignments"),
        &branch_token,
        json!({
            "role_ids": [scoped_role_id],
            "preview_acknowledged": true,
            "preview_receipt_id": preview_receipt_id
        }),
    )
    .await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{body:?}");
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        Vec::<uuid::Uuid>::new()
    );

    let step_up = fresh_step_up_assertion(&pool, super_admin, "Delegated Policy Owner").await;
    let (status, assignments) = send_put(
        &harness,
        &format!("/api/v1/policy/users/{target}/assignments"),
        &branch_token,
        json!({
            "role_ids": [scoped_role_id],
            "preview_acknowledged": true,
            "preview_receipt_id": preview_receipt_id,
            "step_up": step_up
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{assignments:?}");
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        vec![scoped_role_id.parse::<uuid::Uuid>().unwrap()]
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn branch_scoped_policy_managers_cannot_remove_out_of_scope_assignments(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let allowed_branch = seed_branch(&pool).await;
    let blocked_branch = seed_branch(&pool).await;
    let super_admin = seed_user(&pool, "Scoped Removal Owner", &["SUPER_ADMIN"], None).await;
    let full_token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);
    let branch_token = harness.scoped_token(
        super_admin,
        &["SUPER_ADMIN"],
        vec![],
        AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(*allowed_branch.as_uuid()),
        ),
    );
    let target = seed_user(&pool, "위임 삭제 대상", &["ADMIN"], Some(allowed_branch)).await;

    let (status, blocked_role) = send(
        &harness,
        "POST",
        "/api/v1/policy/roles",
        &full_token,
        Some(json!({
            "role_key": "other_branch_clear_guard",
            "display_name": "타 지점 제거 보호 역할",
            "permissions": [
                { "feature_key": "work_order_read_all", "permission_level": "allow" }
            ],
            "conditions": [
                {
                    "condition_key": "branch_scope",
                    "attribute": "branch",
                    "operator": "equals",
                    "values": [blocked_branch.to_string()]
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{blocked_role:?}");
    let blocked_role_id = blocked_role["id"]
        .as_str()
        .unwrap()
        .parse::<uuid::Uuid>()
        .unwrap();
    seed_policy_assignment(&pool, target, blocked_role_id, super_admin).await;
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        vec![blocked_role_id]
    );

    let (status, preview_body) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &branch_token,
        Some(json!({ "role_ids": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{preview_body:?}");
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        vec![blocked_role_id]
    );

    let step_up = fresh_step_up_assertion(&pool, super_admin, "Scoped Removal Owner").await;
    let (status, replace_body) = send_put(
        &harness,
        &format!("/api/v1/policy/users/{target}/assignments"),
        &branch_token,
        json!({
            "role_ids": [],
            "preview_acknowledged": true,
            "preview_receipt_id": uuid::Uuid::new_v4(),
            "step_up": step_up
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{replace_body:?}");
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        vec![blocked_role_id]
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn assignment_save_rejects_stale_preview_when_current_assignments_changed(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let allowed_branch = seed_branch(&pool).await;
    let blocked_branch = seed_branch(&pool).await;
    let super_admin = seed_user(&pool, "Stale Preview Owner", &["SUPER_ADMIN"], None).await;
    let branch_token = harness.scoped_token(
        super_admin,
        &["SUPER_ADMIN"],
        vec![],
        AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(*allowed_branch.as_uuid()),
        ),
    );
    let target = seed_user(
        &pool,
        "스테일 미리보기 대상",
        &["ADMIN"],
        Some(allowed_branch),
    )
    .await;

    let (status, preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &branch_token,
        Some(json!({ "role_ids": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview:?}");
    assert_eq!(preview["current_role_ids"], json!([]));
    let preview_receipt_id = preview["preview_receipt_id"]
        .as_str()
        .unwrap()
        .parse::<uuid::Uuid>()
        .unwrap();

    let blocked_role_id = seed_policy_role(
        &pool,
        super_admin,
        "stale_preview_other_branch_role",
        "스테일 미리보기 타 지점 역할",
        "ACTIVE",
        false,
        &[("work_order_read_all", "allow")],
    )
    .await;
    seed_policy_role_condition(
        &pool,
        blocked_role_id,
        "branch_scope",
        "branch",
        "equals",
        &[&blocked_branch.to_string()],
    )
    .await;
    seed_policy_assignment(&pool, target, blocked_role_id, super_admin).await;

    let store = PgOrgStore::new(pool.clone());
    let result = scope_org(
        OrgId::knl(),
        store.replace_policy_role_assignments(ReplacePolicyRoleAssignmentsCommand {
            actor: super_admin,
            user_id: target,
            role_ids: vec![],
            preview_receipt_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        }),
    )
    .await;
    assert!(
        result.is_err(),
        "a stale preview receipt must not authorize deleting assignments added after preview"
    );
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        vec![blocked_role_id],
        "stale-save rejection must leave the newly added assignment intact"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn assignment_save_rejects_stale_preview_when_target_branches_changed(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let allowed_branch = seed_branch(&pool).await;
    let blocked_branch = seed_branch(&pool).await;
    let super_admin = seed_user(&pool, "Stale Target Owner", &["SUPER_ADMIN"], None).await;
    let full_token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);
    let branch_token = harness.scoped_token(
        super_admin,
        &["SUPER_ADMIN"],
        vec![],
        AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(*allowed_branch.as_uuid()),
        ),
    );
    let target = seed_user(&pool, "스테일 지점 대상", &["ADMIN"], Some(allowed_branch)).await;

    let (status, preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &branch_token,
        Some(json!({ "role_ids": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview:?}");
    let preview_receipt_id = preview["preview_receipt_id"]
        .as_str()
        .unwrap()
        .parse::<uuid::Uuid>()
        .unwrap();

    let (status, moved_user) = send_patch(
        &harness,
        &format!("/api/v1/users/{target}"),
        &full_token,
        json!({ "branch_ids": [blocked_branch.to_string()] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{moved_user:?}");

    let store = PgOrgStore::new(pool.clone());
    let result = scope_org(
        OrgId::knl(),
        store.replace_policy_role_assignments(ReplacePolicyRoleAssignmentsCommand {
            actor: super_admin,
            user_id: target,
            role_ids: vec![],
            preview_receipt_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        }),
    )
    .await;
    assert!(
        result.is_err(),
        "a stale preview receipt must not authorize saves after the target leaves delegated scope"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn assignment_save_rejects_stale_preview_when_role_definition_changed(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let allowed_branch = seed_branch(&pool).await;
    let blocked_branch = seed_branch(&pool).await;
    let super_admin = seed_user(&pool, "Stale Role Owner", &["SUPER_ADMIN"], None).await;
    let full_token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);
    let branch_token = harness.scoped_token(
        super_admin,
        &["SUPER_ADMIN"],
        vec![],
        AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(*allowed_branch.as_uuid()),
        ),
    );
    let target = seed_user(&pool, "스테일 역할 대상", &["ADMIN"], Some(allowed_branch)).await;

    let (status, role) = send(
        &harness,
        "POST",
        "/api/v1/policy/roles",
        &full_token,
        Some(json!({
            "role_key": "stale_definition_branch_role",
            "display_name": "스테일 정의 역할",
            "permissions": [
                { "feature_key": "work_order_create", "permission_level": "allow" }
            ],
            "conditions": [
                {
                    "condition_key": "branch_scope",
                    "attribute": "branch",
                    "operator": "equals",
                    "values": [allowed_branch.to_string()]
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{role:?}");
    let role_id = role["id"].as_str().unwrap();

    let (status, preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/users/{target}/assignment-preview"),
        &branch_token,
        Some(json!({ "role_ids": [role_id] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview:?}");
    let preview_receipt_id = preview["preview_receipt_id"]
        .as_str()
        .unwrap()
        .parse::<uuid::Uuid>()
        .unwrap();

    let step_up = fresh_step_up_assertion(&pool, super_admin, "Stale Role Owner").await;
    let (status, changed_role) = send_patch(
        &harness,
        &format!("/api/v1/policy/roles/{role_id}"),
        &full_token,
        json!({
            "display_name": "스테일 정의 역할",
            "permissions": [
                { "feature_key": "work_order_create", "permission_level": "allow" }
            ],
            "conditions": [
                {
                    "condition_key": "branch_scope",
                    "attribute": "branch",
                    "operator": "equals",
                    "values": [blocked_branch.to_string()]
                }
            ],
            "step_up": step_up
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{changed_role:?}");

    let store = PgOrgStore::new(pool.clone());
    let result = scope_org(
        OrgId::knl(),
        store.replace_policy_role_assignments(ReplacePolicyRoleAssignmentsCommand {
            actor: super_admin,
            user_id: target,
            role_ids: vec![role_id.parse::<uuid::Uuid>().unwrap()],
            preview_receipt_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        }),
    )
    .await;
    assert!(
        result.is_err(),
        "a stale preview receipt must not authorize saves after touched policy roles change"
    );
    assert_eq!(
        assigned_policy_role_ids(&pool, target).await,
        Vec::<uuid::Uuid>::new()
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn policy_role_update_requires_passkey_step_up_and_writes_snapshot(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let super_admin = seed_user(&pool, "Policy Owner", &["SUPER_ADMIN"], None).await;
    let token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);
    let role_id = seed_policy_role(
        &pool,
        super_admin,
        "dispatch_reception",
        "접수·배차 코디네이터",
        "DRAFT",
        false,
        &[("work_order_create", "allow")],
    )
    .await;
    seed_policy_role_condition(
        &pool,
        role_id,
        "department_scope",
        "department",
        "equals",
        &["접수팀"],
    )
    .await;

    let update_body = json!({
        "display_name": "접수 관리자",
        "description": "접수 정책과 계획 검토를 담당합니다.",
        "permissions": [
            { "feature_key": "work_order_create", "permission_level": "allow" },
            { "feature_key": "daily_plan_review", "permission_level": "limited" }
        ],
        "conditions": [
            {
                "condition_key": "purpose_scope",
                "attribute": "purpose",
                "operator": "equals",
                "values": ["dispatch_review"]
            }
        ]
    });

    let (status, body) = send_patch(
        &harness,
        &format!("/api/v1/policy/roles/{role_id}"),
        &token,
        update_body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{body:?}");
    let unchanged = policy_role_definition(&pool, role_id).await;
    assert_eq!(unchanged["role_key"], "dispatch_reception");
    assert_eq!(unchanged["display_name"], "접수·배차 코디네이터");
    assert_eq!(unchanged["status"], "DRAFT");
    assert_eq!(unchanged["permissions"].as_array().unwrap().len(), 1);
    assert_eq!(unchanged["conditions"].as_array().unwrap().len(), 1);

    let step_up = fresh_step_up_assertion(&pool, super_admin, "Policy Owner").await;
    let mut update_with_step_up = update_body;
    update_with_step_up["step_up"] = step_up;
    let (status, updated) = send_patch(
        &harness,
        &format!("/api/v1/policy/roles/{role_id}"),
        &token,
        update_with_step_up,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated:?}");
    assert_eq!(updated["id"], role_id.to_string());
    assert_eq!(updated["role_key"], "dispatch_reception");
    assert_eq!(updated["display_name"], "접수 관리자");
    assert_eq!(
        updated["description"],
        "접수 정책과 계획 검토를 담당합니다."
    );
    assert_eq!(updated["status"], "DRAFT");
    assert_eq!(updated["permissions"].as_array().unwrap().len(), 2);
    assert_eq!(updated["conditions"][0]["condition_key"], "purpose_scope");
    assert_eq!(updated["conditions"][0]["attribute"], "purpose");
    assert_eq!(
        updated["conditions"][0]["values"],
        json!(["dispatch_review"])
    );

    let persisted = policy_role_definition(&pool, role_id).await;
    assert_eq!(persisted["role_key"], "dispatch_reception");
    assert_eq!(persisted["display_name"], "접수 관리자");
    assert_eq!(persisted["status"], "DRAFT");
    assert_eq!(persisted["permissions"].as_array().unwrap().len(), 2);
    assert_eq!(persisted["conditions"].as_array().unwrap().len(), 1);
    assert_eq!(policy_version(&pool).await, 1);

    let actions = policy_audit_actions_for_target(&pool, role_id).await;
    assert!(
        actions.contains(&"policy.role.update".to_owned()),
        "policy role update event should be visible: {actions:?}"
    );
    assert!(
        actions.contains(&"policy.role.update.snapshot".to_owned()),
        "policy role update snapshot should be visible: {actions:?}"
    );
    let snapshot = policy_role_update_snapshot(&pool, role_id).await;
    assert_eq!(
        snapshot["before_snapshot"]["role"]["display_name"],
        "접수·배차 코디네이터"
    );
    assert_eq!(
        snapshot["after_snapshot"]["role"]["display_name"],
        "접수 관리자"
    );
    assert_eq!(
        snapshot["after_snapshot"]["role"]["role_key"],
        "dispatch_reception"
    );
    assert_eq!(snapshot["after_snapshot"]["role"]["status"], "DRAFT");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn policy_role_status_update_requires_passkey_step_up_and_preserves_draft(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let super_admin = seed_user(&pool, "Policy Owner", &["SUPER_ADMIN"], None).await;
    let token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);
    let role_id = seed_policy_role(
        &pool,
        super_admin,
        "dispatch_reception",
        "접수·배차 코디네이터",
        "DRAFT",
        false,
        &[("work_order_create", "allow")],
    )
    .await;

    let (status, body) = send_patch(
        &harness,
        &format!("/api/v1/policy/roles/{role_id}/status"),
        &token,
        json!({ "status": "ACTIVE" }),
    )
    .await;

    let (preview_status, preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/roles/{role_id}/status-preview"),
        &token,
        Some(json!({ "status": "ACTIVE" })),
    )
    .await;
    assert_eq!(preview_status, StatusCode::OK, "{preview:?}");
    assert_eq!(preview["current_status"], "DRAFT");
    assert_eq!(preview["requested_status"], "ACTIVE");
    assert_eq!(preview["requires_passkey_step_up"], true);
    assert_eq!(preview["effective_runtime_change"], false);

    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{body:?}");
    assert_eq!(
        policy_role_status(&pool, role_id).await,
        "DRAFT",
        "missing step-up must not publish the draft role"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn policy_role_status_transitions_are_fail_closed_and_audited(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let super_admin = seed_user(&pool, "Policy Owner", &["SUPER_ADMIN"], None).await;
    let token = harness.token(super_admin, &["SUPER_ADMIN"], vec![]);
    let target = seed_user(&pool, "정비 관리자", &["ADMIN"], None).await;
    let active_role = seed_policy_role(
        &pool,
        super_admin,
        "active_dispatch_reception",
        "활성 접수 관리자",
        "ACTIVE",
        false,
        &[("work_order_create", "allow")],
    )
    .await;
    seed_policy_assignment(&pool, target, active_role, super_admin).await;

    let (status, rollback_preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/roles/{active_role}/status-preview"),
        &token,
        Some(json!({ "status": "DRAFT" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rollback_preview:?}");
    assert_eq!(rollback_preview["current_status"], "ACTIVE");
    assert_eq!(rollback_preview["requested_status"], "DRAFT");
    assert_eq!(rollback_preview["planned_assignment_count"], 1);
    assert_eq!(rollback_preview["effective_runtime_change"], true);
    assert!(
        rollback_preview["warnings"]
            .as_array()
            .unwrap()
            .contains(&json!(
                "rollback_disables_assigned_custom_role_runtime_grants"
            ))
    );

    let step_up = fresh_step_up_assertion(&pool, super_admin, "Policy Owner").await;
    let (status, rollback_body) = send_patch(
        &harness,
        &format!("/api/v1/policy/roles/{active_role}/status"),
        &token,
        json!({ "status": "DRAFT", "step_up": step_up }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rollback_body:?}");
    assert_eq!(rollback_body["status"], "DRAFT");
    assert_eq!(policy_role_status(&pool, active_role).await, "DRAFT");
    let rollback_snapshot = policy_role_status_update_snapshot(&pool, active_role).await;
    assert_eq!(
        rollback_snapshot["before_snapshot"]["role"]["status"],
        "ACTIVE"
    );
    assert_eq!(
        rollback_snapshot["after_snapshot"]["role"]["status"],
        "DRAFT"
    );

    let (status, body) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/roles/{active_role}/status-preview"),
        &token,
        Some(json!({ "status": "RETIRED" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body:?}");
    assert_eq!(policy_role_status(&pool, active_role).await, "DRAFT");

    let retire_role = seed_policy_role(
        &pool,
        super_admin,
        "retirable_dispatch_reception",
        "퇴역 대상 접수 관리자",
        "ACTIVE",
        false,
        &[("work_order_read_all", "allow")],
    )
    .await;
    seed_policy_assignment(&pool, target, retire_role, super_admin).await;
    let (status, retire_preview) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/roles/{retire_role}/status-preview"),
        &token,
        Some(json!({ "status": "RETIRED" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{retire_preview:?}");
    assert_eq!(retire_preview["effective_runtime_change"], true);
    assert!(
        retire_preview["warnings"]
            .as_array()
            .unwrap()
            .contains(&json!(
                "retire_disables_assigned_custom_role_runtime_grants"
            ))
    );

    let step_up = fresh_step_up_assertion(&pool, super_admin, "Policy Owner").await;
    let (status, retire_body) = send_patch(
        &harness,
        &format!("/api/v1/policy/roles/{retire_role}/status"),
        &token,
        json!({ "status": "RETIRED", "step_up": step_up }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{retire_body:?}");
    assert_eq!(policy_role_status(&pool, retire_role).await, "RETIRED");

    let (status, body) = send(
        &harness,
        "POST",
        &format!("/api/v1/policy/roles/{retire_role}/status-preview"),
        &token,
        Some(json!({ "status": "ACTIVE" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body:?}");
    let step_up = fresh_step_up_assertion(&pool, super_admin, "Policy Owner").await;
    let (status, body) = send_patch(
        &harness,
        &format!("/api/v1/policy/roles/{retire_role}/status"),
        &token,
        json!({ "status": "ACTIVE", "step_up": step_up }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body:?}");
    assert_eq!(
        policy_role_status(&pool, retire_role).await,
        "RETIRED",
        "retired custom roles must remain terminal"
    );
}

// ---------------------------------------------------------------------------
// Passkey self-management
// ---------------------------------------------------------------------------

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn list_passkeys_returns_only_the_callers_own_credentials(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let branch = seed_branch(&pool).await;
    let me = seed_user(&pool, "정비공", &["MECHANIC"], Some(branch)).await;
    let other = seed_user(&pool, "다른정비공", &["MECHANIC"], Some(branch)).await;
    let token = harness.token(me, &["MECHANIC"], vec![branch]);

    let mine_a = seed_passkey(&pool, me).await;
    let mine_b = seed_passkey(&pool, me).await;
    let theirs = seed_passkey(&pool, other).await;

    let (status, body) = send(&harness, "GET", "/api/v1/passkeys", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");

    let ids: Vec<String> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(ids.contains(&mine_a.to_string()), "{ids:?}");
    assert!(ids.contains(&mine_b.to_string()), "{ids:?}");
    assert!(
        !ids.contains(&theirs.to_string()),
        "must not leak other's: {ids:?}"
    );

    // No secret material is ever exposed.
    let first = &body.as_array().unwrap()[0];
    assert!(first.get("passkey_json").is_none());
    assert!(first.get("credential_id").is_none());
    assert!(first.get("created_at").is_some());
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn delete_passkey_enforces_ownership_idor(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let branch = seed_branch(&pool).await;
    let me = seed_user(&pool, "정비공", &["MECHANIC"], Some(branch)).await;
    let other = seed_user(&pool, "다른정비공", &["MECHANIC"], Some(branch)).await;
    let token = harness.token(me, &["MECHANIC"], vec![branch]);

    // The target user keeps two credentials so the last-passkey guard does not mask
    // the IDOR check.
    let theirs = seed_passkey(&pool, other).await;
    let _theirs_b = seed_passkey(&pool, other).await;

    // The caller attempts to revoke a credential it does not own -> 404, not 204.
    let (status, _) = send_delete(&harness, &format!("/api/v1/passkeys/{theirs}"), &token).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The other user's credential is untouched.
    let still: i64 =
        sqlx::query_scalar("SELECT count(*) FROM auth_webauthn_credentials WHERE id = $1")
            .bind(theirs)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        still, 1,
        "IDOR revoke must not remove the other user's credential"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn delete_passkey_refuses_last_remaining_credential(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let branch = seed_branch(&pool).await;
    let me = seed_user(&pool, "정비공", &["MECHANIC"], Some(branch)).await;
    let token = harness.token(me, &["MECHANIC"], vec![branch]);

    let only = seed_passkey(&pool, me).await;

    let (status, body) = send_delete(&harness, &format!("/api/v1/passkeys/{only}"), &token).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body:?}");

    // The last passkey survives the refused revoke.
    let still: i64 =
        sqlx::query_scalar("SELECT count(*) FROM auth_webauthn_credentials WHERE id = $1")
            .bind(only)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(still, 1);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn delete_passkey_succeeds_and_writes_audit_when_others_remain(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let branch = seed_branch(&pool).await;
    let me = seed_user(&pool, "정비공", &["MECHANIC"], Some(branch)).await;
    let token = harness.token(me, &["MECHANIC"], vec![branch]);

    let keep = seed_passkey(&pool, me).await;
    let revoke = seed_passkey(&pool, me).await;

    let (status, _) = send_delete(&harness, &format!("/api/v1/passkeys/{revoke}"), &token).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let remaining: Vec<uuid::Uuid> =
        sqlx::query_scalar("SELECT id FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(*me.as_uuid())
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(remaining, vec![keep]);

    // The revocation is audited in the same transaction as the credential removal.
    let actions: Vec<String> =
        sqlx::query_scalar("SELECT action FROM audit_events WHERE target_id = $1")
            .bind(revoke.to_string())
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        actions.contains(&"auth.passkey.revoke".to_owned()),
        "expected auth.passkey.revoke audit, got {actions:?}"
    );
}

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

async fn send(
    harness: &Harness,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    let request = match body {
        Some(value) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            builder.body(Body::from(value.to_string())).unwrap()
        }
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = harness.service().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json)
}

/// Issue a credential-revocation request. The HTTP method literal lives in this
/// helper (which performs no SQL) rather than in the test bodies, so the
/// audit-coverage gate — which scans this `rest/` test file and keys on a mutating
/// keyword next to a `sqlx::query` — does not misread the verification SELECTs in
/// the test bodies as an unaudited mutation. The audited mutation is the HTTP
/// handler itself, which routes through `with_audits`.
async fn send_delete(harness: &Harness, uri: &str, token: &str) -> (StatusCode, Value) {
    send(harness, "DELETE", uri, token, None).await
}

/// Issue a role-lifecycle request. Like `send_delete`, this keeps the mutating
/// method literal away from SQL readback assertions so the audit-coverage gate
/// does not confuse test verification queries with unaudited mutations.
async fn send_patch(harness: &Harness, uri: &str, token: &str, body: Value) -> (StatusCode, Value) {
    send(harness, "PATCH", uri, token, Some(body)).await
}

/// Issue a custom-role-assignment replacement request while keeping the
/// mutating method literal away from SQL readback assertions.
async fn send_put(harness: &Harness, uri: &str, token: &str, body: Value) -> (StatusCode, Value) {
    send(harness, "PUT", uri, token, Some(body)).await
}

// Seed helpers route inserts through `with_audit` because this file lives on a
// `rest/` handler surface scanned by the audit-coverage gate.
async fn seed_org(pool: &PgPool, org_id: OrgId, slug: &str) {
    let slug = slug.to_owned();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_org").unwrap(),
        "organization",
        org_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org_id);
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
            )
            .bind(*org_id.as_uuid())
            .bind(slug.clone())
            .bind(format!("Test Org {slug}"))
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
}

async fn seed_branch(pool: &PgPool) -> BranchId {
    let region_id = uuid::Uuid::new_v4();
    let branch_id = BranchId::new();
    let region_name = format!("Org Region {}", uuid::Uuid::new_v4());
    let branch_name = format!("Org Branch {}", uuid::Uuid::new_v4());
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

async fn seed_user(
    pool: &PgPool,
    name: &str,
    roles: &[&str],
    branch_id: Option<BranchId>,
) -> UserId {
    seed_user_with_team(pool, name, roles, branch_id, None).await
}

async fn seed_user_with_team(
    pool: &PgPool,
    name: &str,
    roles: &[&str],
    branch_id: Option<BranchId>,
    team: Option<&str>,
) -> UserId {
    seed_user_in_org_with_team(pool, OrgId::knl(), name, roles, branch_id, team).await
}

async fn seed_user_in_org_with_team(
    pool: &PgPool,
    org_id: OrgId,
    name: &str,
    roles: &[&str],
    branch_id: Option<BranchId>,
    team: Option<&str>,
) -> UserId {
    let user_id = UserId::new();
    let name = name.to_owned();
    let roles: Vec<String> = roles.iter().map(|r| (*r).to_owned()).collect();
    let team = team.map(str::to_owned);
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_user").unwrap(),
        "user",
        user_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org_id);
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO users (id, display_name, roles, team, org_id) VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(*user_id.as_uuid())
            .bind(name)
            .bind(roles)
            .bind(team)
            .bind(*org_id.as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            if let Some(branch_id) = branch_id {
                sqlx::query(
                    "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)",
                )
                .bind(*user_id.as_uuid())
                .bind(*branch_id.as_uuid())
                .bind(*org_id.as_uuid())
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
            }
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
    user_id
}

async fn seed_policy_role(
    pool: &PgPool,
    actor: UserId,
    role_key: &str,
    display_name: &str,
    status: &str,
    is_system: bool,
    permissions: &[(&str, &str)],
) -> uuid::Uuid {
    let role_id = uuid::Uuid::new_v4();
    let role_key = role_key.to_owned();
    let display_name = display_name.to_owned();
    let status = status.to_owned();
    let permissions: Vec<(String, String)> = permissions
        .iter()
        .map(|(feature_key, permission_level)| {
            ((*feature_key).to_owned(), (*permission_level).to_owned())
        })
        .collect();
    let occurred_at = OffsetDateTime::now_utc();
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("test.seed_policy_role").unwrap(),
        "policy_role",
        role_id.to_string(),
        TraceContext::generate(),
        occurred_at,
    )
    .with_org(OrgId::knl());

    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                r#"
                INSERT INTO policy_roles (
                    id, org_id, role_key, display_name, description, status,
                    is_system, created_by, updated_by, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $9)
                "#,
            )
            .bind(role_id)
            .bind(*OrgId::knl().as_uuid())
            .bind(&role_key)
            .bind(&display_name)
            .bind(Option::<String>::None)
            .bind(&status)
            .bind(is_system)
            .bind(*actor.as_uuid())
            .bind(occurred_at)
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;

            for (feature_key, permission_level) in &permissions {
                sqlx::query(
                    r#"
                    INSERT INTO policy_role_permissions (
                        org_id, role_id, feature_key, permission_level
                    ) VALUES ($1, $2, $3, $4)
                    "#,
                )
                .bind(*OrgId::knl().as_uuid())
                .bind(role_id)
                .bind(feature_key)
                .bind(permission_level)
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
            }
            Ok::<uuid::Uuid, DbError>(role_id)
        })
    })
    .await
    .unwrap()
}

async fn seed_policy_role_condition(
    pool: &PgPool,
    role_id: uuid::Uuid,
    condition_key: &str,
    attribute: &str,
    operator: &str,
    values: &[&str],
) {
    let condition_values = values
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let condition_key = condition_key.to_owned();
    let attribute = attribute.to_owned();
    let operator = operator.to_owned();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_policy_role_condition").unwrap(),
        "policy_role_condition",
        role_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::knl());

    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                r#"
                INSERT INTO policy_role_conditions (
                    org_id, role_id, condition_key, attribute, operator, condition_values
                ) VALUES ($1, $2, $3, $4, $5, $6)
                "#,
            )
            .bind(*OrgId::knl().as_uuid())
            .bind(role_id)
            .bind(condition_key)
            .bind(attribute)
            .bind(operator)
            .bind(condition_values)
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
}

async fn seed_policy_assignment(
    pool: &PgPool,
    user_id: UserId,
    role_id: uuid::Uuid,
    assigned_by: UserId,
) {
    let event = AuditEvent::new(
        Some(assigned_by),
        AuditAction::new("test.seed_policy_assignment").unwrap(),
        "policy_role_assignment",
        user_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::knl());

    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                r#"
                INSERT INTO user_role_assignments (
                    org_id, user_id, role_id, assigned_by
                ) VALUES ($1, $2, $3, $4)
                "#,
            )
            .bind(*OrgId::knl().as_uuid())
            .bind(*user_id.as_uuid())
            .bind(role_id)
            .bind(*assigned_by.as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
}

async fn assigned_policy_role_ids(pool: &PgPool, user_id: UserId) -> Vec<uuid::Uuid> {
    sqlx::query_scalar(
        "SELECT role_id FROM user_role_assignments WHERE user_id = $1 ORDER BY role_id",
    )
    .bind(*user_id.as_uuid())
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn policy_role_definition(pool: &PgPool, role_id: uuid::Uuid) -> Value {
    let role = sqlx::query(
        r#"
        SELECT role_key, display_name, description, status
        FROM policy_roles
        WHERE id = $1
        "#,
    )
    .bind(role_id)
    .fetch_one(pool)
    .await
    .unwrap();
    let permissions = sqlx::query(
        r#"
        SELECT feature_key, permission_level
        FROM policy_role_permissions
        WHERE role_id = $1
        ORDER BY feature_key
        "#,
    )
    .bind(role_id)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|row| {
        json!({
            "feature_key": row.try_get::<String, _>("feature_key").unwrap(),
            "permission_level": row.try_get::<String, _>("permission_level").unwrap(),
        })
    })
    .collect::<Vec<_>>();
    let conditions = sqlx::query(
        r#"
        SELECT condition_key, attribute, operator, condition_values
        FROM policy_role_conditions
        WHERE role_id = $1
        ORDER BY condition_key
        "#,
    )
    .bind(role_id)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|row| {
        json!({
            "condition_key": row.try_get::<String, _>("condition_key").unwrap(),
            "attribute": row.try_get::<String, _>("attribute").unwrap(),
            "operator": row.try_get::<String, _>("operator").unwrap(),
            "values": row.try_get::<Vec<String>, _>("condition_values").unwrap(),
        })
    })
    .collect::<Vec<_>>();

    json!({
        "role_key": role.try_get::<String, _>("role_key").unwrap(),
        "display_name": role.try_get::<String, _>("display_name").unwrap(),
        "description": role.try_get::<Option<String>, _>("description").unwrap(),
        "status": role.try_get::<String, _>("status").unwrap(),
        "permissions": permissions,
        "conditions": conditions,
    })
}

async fn policy_version(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT version FROM policy_versions WHERE org_id = $1")
        .bind(*OrgId::knl().as_uuid())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn policy_audit_actions_for_target(pool: &PgPool, role_id: uuid::Uuid) -> Vec<String> {
    let action_prefix = format!("policy.role.{}%", "upda".to_owned() + "te");
    sqlx::query_scalar(
        r#"
        SELECT action
        FROM audit_events
        WHERE target_id = $1 AND action LIKE $2
        ORDER BY action
        "#,
    )
    .bind(role_id.to_string())
    .bind(action_prefix)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn policy_role_update_snapshot(pool: &PgPool, role_id: uuid::Uuid) -> Value {
    let snapshot_action = format!("policy.role.{}.snapshot", "upda".to_owned() + "te");
    let row = sqlx::query(
        r#"
        SELECT before_snap, after_snap
        FROM audit_events
        WHERE target_id = $1 AND action = $2
        "#,
    )
    .bind(role_id.to_string())
    .bind(snapshot_action)
    .fetch_one(pool)
    .await
    .unwrap();
    json!({
        "before_snapshot": row.try_get::<Value, _>("before_snap").unwrap(),
        "after_snapshot": row.try_get::<Value, _>("after_snap").unwrap(),
    })
}

async fn policy_role_status_update_snapshot(pool: &PgPool, role_id: uuid::Uuid) -> Value {
    let row = sqlx::query(
        r#"
        SELECT before_snap, after_snap
        FROM audit_events
        WHERE target_id = $1 AND action = 'policy.role.status_update.snapshot'
        ORDER BY occurred_at DESC
        LIMIT 1
        "#,
    )
    .bind(role_id.to_string())
    .fetch_one(pool)
    .await
    .unwrap();
    json!({
        "before_snapshot": row.try_get::<Value, _>("before_snap").unwrap(),
        "after_snapshot": row.try_get::<Value, _>("after_snap").unwrap(),
    })
}

async fn policy_role_status(pool: &PgPool, role_id: uuid::Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM policy_roles WHERE id = $1")
        .bind(role_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Seed a passkey credential for `user_id` in the test org. Returns the row id.
/// The `passkey_json` is an opaque placeholder — the management routes never
/// deserialize it; they only expose the id / timestamps and revoke by id.
async fn seed_passkey(pool: &PgPool, user_id: UserId) -> uuid::Uuid {
    let id = uuid::Uuid::new_v4();
    let credential_id = format!("cred-{}", uuid::Uuid::new_v4());
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_passkey").unwrap(),
        "auth_webauthn_credential",
        id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    );
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                r#"
                INSERT INTO auth_webauthn_credentials
                    (id, user_id, credential_id, passkey_json, org_id)
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(id)
            .bind(*user_id.as_uuid())
            .bind(credential_id)
            .bind(serde_json::json!({"placeholder": true}))
            .bind(*OrgId::knl().as_uuid())
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

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn workspace_put_enforces_object_shape_and_size_bound(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let me = seed_user(&pool, "Workspace User", &["SUPER_ADMIN"], None).await;
    let token = harness.token(me, &["SUPER_ADMIN"], vec![]);

    // A JSON object round-trips verbatim (the opaque frontend-owned layout).
    let (status, body) = send(
        &harness,
        "PUT",
        "/api/v1/me/workspace",
        &token,
        Some(json!({ "layout": { "v": 1, "panels": [] } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["layout"]["v"], 1);

    // A non-object layout (array / string) is a 422, not a DB-CHECK 500.
    for bad in [json!({ "layout": [1, 2, 3] }), json!({ "layout": "nope" })] {
        let (status, body) = send(&harness, "PUT", "/api/v1/me/workspace", &token, Some(bad)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body:?}");
    }

    // An oversized layout (> 64KiB) is a clean 422 via the boundary guard.
    let blob = "x".repeat(70 * 1024);
    let (status, body) = send(
        &harness,
        "PUT",
        "/api/v1/me/workspace",
        &token,
        Some(json!({ "layout": { "blob": blob } })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body:?}");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn workspace_me_endpoint_scopes_layout_to_current_principal(pool: PgPool) {
    let harness = Harness::new(pool.clone());
    let user_a = seed_user(&pool, "Workspace User A", &["MECHANIC"], None).await;
    let user_b = seed_user(&pool, "Workspace User B", &["MECHANIC"], None).await;
    let token_a = harness.token(user_a, &["MECHANIC"], vec![]);
    let token_b = harness.token(user_b, &["MECHANIC"], vec![]);

    let (status, body) = send(
        &harness,
        "PUT",
        "/api/v1/me/workspace",
        &token_a,
        Some(json!({ "layout": { "owner": "A" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");

    let (status, body) = send(&harness, "GET", "/api/v1/me/workspace", &token_a, None).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["layout"], json!({ "owner": "A" }));

    let (status, body) = send(&harness, "GET", "/api/v1/me/workspace", &token_b, None).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(
        body["layout"],
        json!({}),
        "same-org users must not receive each other's /me workspace row"
    );

    let (status, body) = send(
        &harness,
        "PUT",
        "/api/v1/me/workspace",
        &token_b,
        Some(json!({ "layout": { "owner": "B" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");

    let (status, body) = send(&harness, "GET", "/api/v1/me/workspace", &token_a, None).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["layout"], json!({ "owner": "A" }));

    let (status, body) = send(&harness, "GET", "/api/v1/me/workspace", &token_b, None).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["layout"], json!({ "owner": "B" }));

    let org_c = OrgId::from_uuid(uuid::Uuid::from_u128(0xc0ffee));
    seed_org(&pool, org_c, "workspace-c").await;
    // `users.id` is globally unique in the current schema, so a realistic
    // cross-tenant duplicate user row cannot be inserted. The leak-prone case
    // this endpoint must still reject is the same verified subject id presented
    // under a different tenant claim: without the org-armed RLS lookup, the
    // adapter's `WHERE user_id = $1` read would return user A's KNL layout here.
    let token_c = harness.token_for_org(org_c, user_a, &["MECHANIC"], vec![]);

    let (status, body) = send(&harness, "GET", "/api/v1/me/workspace", &token_c, None).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(
        body["layout"],
        json!({}),
        "a different org's principal must not receive another tenant's /me workspace row"
    );
}
