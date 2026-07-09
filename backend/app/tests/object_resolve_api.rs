#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BE-OBJ object resolve endpoint (GET /api/objects/{kind}/{id}).
//!
//! Proves the resolver framework and both authorization modes end-to-end:
//! org-scoped (person), branch-scoped deny-by-omission (org_unit), and
//! initiator-scoped (approval_run). Cross-scope and absent objects both resolve
//! to `exists: false` (indistinguishable — the deny-by-omission guarantee); a
//! well-formed but unregistered kind is 404. The work_order / equipment /
//! support_ticket resolvers reuse the identical branch_visible + org-RLS read
//! machinery proven here.

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{BranchId, OrgId, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn resolves_kinds_and_denies_by_omission(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();

    let caller = UserId::new();
    let branch_x = seed_branch(&pool, "Region X", "Branch X").await;
    let branch_y = seed_branch(&pool, "Region Y", "Branch Y").await;
    seed_user_in_branch(&pool, caller, "ADMIN", branch_x).await;
    // The caller's branch scope is exactly {branch_x}.
    let token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        caller,
        vec![branch_x],
    );

    // person (org-scoped): a seeded user resolves with its display name.
    let subject = UserId::new();
    seed_user_in_branch(&pool, subject, "MECHANIC", branch_x).await;
    let person = resolve(
        &pool,
        &public_key_pem,
        &token,
        "person",
        &subject.as_uuid().to_string(),
    )
    .await;
    assert_eq!(person.0, StatusCode::OK);
    assert_eq!(person.1["exists"], true, "person resolves: {}", person.1);
    assert!(
        person.1["title"]
            .as_str()
            .unwrap()
            .starts_with("User MECHANIC")
    );
    assert_eq!(
        person.1["url_path"],
        format!("/settings/employees?person={}", subject.as_uuid())
    );

    // person absent: a random id resolves to exists=false (not an error).
    let absent = resolve(
        &pool,
        &public_key_pem,
        &token,
        "person",
        &Uuid::new_v4().to_string(),
    )
    .await;
    assert_eq!(absent.0, StatusCode::OK);
    assert_eq!(absent.1["exists"], false);

    // Auth gate before kind-specific resolution: even an otherwise valid,
    // in-scope person id must be rejected before `resolve_person` runs when the
    // principal has no Login-authorizing role/grant.
    let no_login_caller = UserId::new();
    seed_user_in_branch(&pool, no_login_caller, "MECHANIC", branch_x).await;
    let no_login_token = issue_token_with_roles(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        no_login_caller,
        vec![branch_x],
        Vec::new(),
    );
    let forbidden = resolve(
        &pool,
        &public_key_pem,
        &no_login_token,
        "person",
        &subject.as_uuid().to_string(),
    )
    .await;
    assert_eq!(forbidden.0, StatusCode::FORBIDDEN);

    // person cross-branch: a user who belongs ONLY to branch_y (not the caller's
    // scope) must resolve exists=false — no cross-branch PII/existence leak.
    let branch_b_user = UserId::new();
    seed_user_in_branch(&pool, branch_b_user, "MECHANIC", branch_y).await;
    let cross = resolve(
        &pool,
        &public_key_pem,
        &token,
        "person",
        &branch_b_user.as_uuid().to_string(),
    )
    .await;
    assert_eq!(
        cross.1["exists"], false,
        "branch-B-only user must be denied by omission: {}",
        cross.1
    );

    // person inactive: a deactivated user in the caller's own branch must also
    // resolve exists=false (no deactivation oracle).
    let inactive = UserId::new();
    seed_user_in_branch(&pool, inactive, "MECHANIC", branch_x).await;
    sqlx::query("UPDATE users SET is_active = false WHERE id = $1")
        .bind(*inactive.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let inactive_res = resolve(
        &pool,
        &public_key_pem,
        &token,
        "person",
        &inactive.as_uuid().to_string(),
    )
    .await;
    assert_eq!(
        inactive_res.1["exists"], false,
        "inactive user must be denied by omission: {}",
        inactive_res.1
    );

    // org_unit in scope: branch_x is in the caller's scope -> exists=true.
    let unit_in = resolve(
        &pool,
        &public_key_pem,
        &token,
        "org_unit",
        &branch_x.as_uuid().to_string(),
    )
    .await;
    assert_eq!(
        unit_in.1["exists"], true,
        "in-scope org_unit: {}",
        unit_in.1
    );
    assert_eq!(unit_in.1["title"], "Branch X");

    // org_unit cross-branch: branch_y exists but is NOT in the caller's scope ->
    // exists=false, identical to a missing id (deny-by-omission).
    let unit_out = resolve(
        &pool,
        &public_key_pem,
        &token,
        "org_unit",
        &branch_y.as_uuid().to_string(),
    )
    .await;
    assert_eq!(unit_out.0, StatusCode::OK);
    assert_eq!(
        unit_out.1["exists"], false,
        "cross-branch org_unit must be denied by omission: {}",
        unit_out.1
    );

    // approval_run initiator-scoped: the caller's own run resolves; another
    // initiator's run does not.
    let other = UserId::new();
    seed_user_in_branch(&pool, other, "MECHANIC", branch_x).await;
    let mine = seed_workflow_run(&pool, Some(caller)).await;
    let theirs = seed_workflow_run(&pool, Some(other)).await;
    let run_mine = resolve(
        &pool,
        &public_key_pem,
        &token,
        "approval_run",
        &mine.to_string(),
    )
    .await;
    assert_eq!(
        run_mine.1["exists"], true,
        "own run resolves: {}",
        run_mine.1
    );
    assert_eq!(run_mine.1["status"], "RUNNING");
    let run_theirs = resolve(
        &pool,
        &public_key_pem,
        &token,
        "approval_run",
        &theirs.to_string(),
    )
    .await;
    assert_eq!(
        run_theirs.1["exists"], false,
        "another initiator's run is denied by omission: {}",
        run_theirs.1
    );

    // approver-on-the-line: once the caller has CLAIMED a task on theirs, they
    // resolve the run (widened beyond initiator to the inbox's scoping).
    seed_claimed_task(&pool, theirs, caller).await;
    let run_claimed = resolve(
        &pool,
        &public_key_pem,
        &token,
        "approval_run",
        &theirs.to_string(),
    )
    .await;
    assert_eq!(
        run_claimed.1["exists"], true,
        "a claimer on the line resolves the run: {}",
        run_claimed.1
    );

    // Unknown (well-formed but unregistered) kind -> 404.
    let unknown = resolve(
        &pool,
        &public_key_pem,
        &token,
        "banana",
        &Uuid::new_v4().to_string(),
    )
    .await;
    assert_eq!(unknown.0, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async fn resolve(
    pool: &PgPool,
    public_key_pem: &str,
    token: &str,
    kind: &str,
    id: &str,
) -> (StatusCode, Value) {
    let service = build_router(app_state(pool.clone(), public_key_pem.to_owned()).unwrap());
    let response = service
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/objects/{kind}/{id}"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap_or(Value::Null)
    };
    (status, json)
}

async fn seed_branch(pool: &PgPool, region: &str, branch: &str) -> BranchId {
    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(region)
            .bind(*OrgId::knl().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(branch)
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user_in_branch(pool: &PgPool, user_id: UserId, role: &str, branch: BranchId) {
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("User {role} {}", Uuid::new_v4()))
        .bind(Vec::from([role]))
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_workflow_run(pool: &PgPool, initiated_by: Option<UserId>) -> Uuid {
    // workflow_runs.(definition_id, org_id) FKs to workflow_definitions, so seed
    // a definition first (unique workflow_key per call).
    let definition_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO workflow_definitions (id, org_id, workflow_key, display_name, object_type)
        VALUES ($1, $2, $3, 'Test Approval', 'work_order')
        "#,
    )
    .bind(definition_id)
    .bind(*OrgId::knl().as_uuid())
    .bind(format!("test.wf_{}", definition_id.simple()))
    .execute(pool)
    .await
    .unwrap();
    // The run also FKs (definition_id, definition_version) -> version rows.
    sqlx::query(
        r#"
        INSERT INTO workflow_definition_versions (id, org_id, definition_id, version, status)
        VALUES ($1, $2, $3, 1, 'PUBLISHED')
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(*OrgId::knl().as_uuid())
    .bind(definition_id)
    .execute(pool)
    .await
    .unwrap();

    let id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO workflow_runs (
            id, org_id, definition_id, definition_version, status, trigger_type,
            idempotency_key, correlation_id, initiated_by
        )
        VALUES ($1, $2, $3, 1, 'RUNNING', 'MANUAL', $4, $5, $6)
        "#,
    )
    .bind(id)
    .bind(*OrgId::knl().as_uuid())
    .bind(definition_id)
    .bind(format!("idem-{}", Uuid::new_v4()))
    .bind(format!("corr-{}", Uuid::new_v4()))
    .bind(initiated_by.map(|u| *u.as_uuid()))
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn seed_claimed_task(pool: &PgPool, run_id: Uuid, claimed_by: UserId) {
    sqlx::query(
        r#"
        INSERT INTO workflow_waiting_tasks (
            id, org_id, run_id, waiting_key, title, status, required_policy, claimed_by
        )
        VALUES ($1, $2, $3, 'approval_step', 'Approve', 'CLAIMED', 'approval_finalize', $4)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(*OrgId::knl().as_uuid())
    .bind(run_id)
    .bind(*claimed_by.as_uuid())
    .execute(pool)
    .await
    .unwrap();
}

fn issue_token(
    private_key_pem: &[u8],
    public_key_pem: &[u8],
    user_id: UserId,
    branches: Vec<BranchId>,
) -> String {
    issue_token_with_roles(
        private_key_pem,
        public_key_pem,
        user_id,
        branches,
        vec!["ADMIN".to_owned()],
    )
}

fn issue_token_with_roles(
    private_key_pem: &[u8],
    public_key_pem: &[u8],
    user_id: UserId,
    branches: Vec<BranchId>,
    roles: Vec<String>,
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
