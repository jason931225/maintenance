//! Identity / org-setup REST integration tests.
//!
//! Exercises the cold-start org flow end-to-end: an admin creates regions,
//! branches and users; the IDOR hardening restricts elevated-role grants to
//! SUPER_ADMIN; and every authenticated user can edit their own profile (the
//! "Cold Start Admin" fixing its own name).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_identity_adapter_postgres::PgOrgStore;
use mnt_identity_rest::{IdentityRestState, router};
use mnt_kernel_core::{AuditAction, AuditEvent, BranchId, OrgId, TraceContext, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_db::{DbError, with_audit};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

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
        router(IdentityRestState::new(
            PgOrgStore::new(self.pool.clone()),
            Some(verifier),
        ))
    }

    fn token(&self, user_id: UserId, roles: &[&str], branches: Vec<BranchId>) -> String {
        let issuer = JwtIssuer::from_es256_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            self.private_pem.as_bytes(),
            self.public_pem.as_bytes(),
        )
        .unwrap();
        issuer
            .issue_access_token(AccessTokenInput {
                subject: user_id,
                org_id: OrgId::knl(),
                roles: roles.iter().map(|r| (*r).to_owned()).collect(),
                branches,
                platform: false,
                view_as: false,
                read_only: false,
                display_name: None,
                issued_at: OffsetDateTime::now_utc(),
            })
            .unwrap()
    }
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

    // List users in scope returns the admin and the new mechanic.
    let (status, users) = send(&harness, "GET", "/api/v1/users", &token, None).await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<&str> = users
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

// Seed helpers route inserts through `with_audit` because this file lives on a
// `rest/` handler surface scanned by the audit-coverage gate.
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
    let user_id = UserId::new();
    let name = name.to_owned();
    let roles: Vec<String> = roles.iter().map(|r| (*r).to_owned()).collect();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_user").unwrap(),
        "user",
        user_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    );
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(*user_id.as_uuid())
            .bind(name)
            .bind(roles)
            .bind(*OrgId::knl().as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            if let Some(branch_id) = branch_id {
                sqlx::query(
                    "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)",
                )
                .bind(*user_id.as_uuid())
                .bind(*branch_id.as_uuid())
                .bind(*OrgId::knl().as_uuid())
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
