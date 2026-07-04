#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Instance / task REST surface E2E (engine-gen spike §"Instance/Task REST Surface").
//!
//! Drives the REAL router on a genuine non-owner `mnt_rt` pool (RLS actually
//! enforced, never a BYPASSRLS superuser) exactly as `workflow_runtime_finalize_api`
//! does, covering the spike's closing matrix items:
//!   * start idempotency replay (same key → same run; mismatched key → 409),
//!   * decision comment-required 422 (reject/return need a non-empty comment),
//!   * deny-by-omission inbox listing (a persona without the policy sees an EMPTY
//!     list, not a 403), plus the core claim/decide/advance + submission-box paths.

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{BranchId, OrgId, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
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

struct Keys {
    private_pem: String,
    public_pem: String,
}

struct JsonResponse {
    status: StatusCode,
    json: Value,
}

// ===========================================================================
// 1. Start: parks the first approval task, and replays idempotently.
// ===========================================================================
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn start_run_parks_first_task_and_replays_idempotently(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool).await;
    let initiator = UserId::new();
    seed_user(&pool, initiator, "SUPER_ADMIN", branch).await;
    let definition_id = seed_approval_definition(&pool, "approval.instance.start").await;
    let other_definition_id = seed_approval_definition(&pool, "approval.instance.other").await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&keys, initiator, "SUPER_ADMIN", branch);

    let object_id = Uuid::new_v4();
    let body = json!({
        "definition_id": definition_id,
        "object_type": "approval_document",
        "object_id": object_id,
        "trigger_type": "MANUAL",
        "idempotency_key": "instance-start-key-000001",
        "input_payload": { "reason": "annual" }
    });

    let first = post(
        service.clone(),
        "/api/v1/workflow-runs",
        &token,
        body.clone(),
    )
    .await;
    assert_eq!(first.status, StatusCode::OK, "{:?}", first.json);
    assert_eq!(first.json["run"]["status"], "WAITING");
    assert_eq!(first.json["run"]["initiated_by"], initiator.to_string());
    assert_eq!(first.json["next_task"]["waiting_key"], "review.hr");
    assert_eq!(first.json["next_task"]["assignee_role_key"], "hr_reviewer");
    let run_id = first.json["run"]["id"].as_str().unwrap().to_owned();

    // Replay with the SAME idempotency_key returns the existing run, no second run.
    let replay = post(service.clone(), "/api/v1/workflow-runs", &token, body).await;
    assert_eq!(replay.status, StatusCode::OK);
    assert_eq!(replay.json["run"]["id"], run_id);
    let run_count = count_runs(&pool).await;
    assert_eq!(run_count, 1, "replay must NOT create a second run");

    // Same key, different definition (mismatch) → 409.
    let mismatch = post(
        service,
        "/api/v1/workflow-runs",
        &token,
        json!({
            "definition_id": other_definition_id,
            "object_type": "approval_document",
            "object_id": object_id,
            "trigger_type": "MANUAL",
            "idempotency_key": "instance-start-key-000001",
            "input_payload": {}
        }),
    )
    .await;
    assert_eq!(mismatch.status, StatusCode::CONFLICT);
    assert_eq!(mismatch.json["error"]["code"], "conflict");
}

// ===========================================================================
// 2. Decide: reject/return require a non-empty comment (422); reject cancels run.
// ===========================================================================
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn decision_reject_requires_comment_and_cancels_run(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool).await;
    let initiator = UserId::new();
    seed_user(&pool, initiator, "SUPER_ADMIN", branch).await;
    let definition_id = seed_approval_definition(&pool, "approval.instance.reject").await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&keys, initiator, "SUPER_ADMIN", branch);

    let started = post(
        service.clone(),
        "/api/v1/workflow-runs",
        &token,
        json!({
            "definition_id": definition_id,
            "trigger_type": "MANUAL",
            "idempotency_key": "instance-reject-key-000001",
            "input_payload": {}
        }),
    )
    .await;
    assert_eq!(started.status, StatusCode::OK, "{:?}", started.json);
    let task_id = started.json["next_task"]["task_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let run_id = started.json["run"]["id"].as_str().unwrap().to_owned();

    // reject WITHOUT a comment → 422.
    let no_comment = post(
        service.clone(),
        &format!("/api/v1/workflow-tasks/{task_id}/decide"),
        &token,
        json!({ "decision": "reject", "idempotency_key": "reject-no-comment-000001" }),
    )
    .await;
    assert_eq!(no_comment.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(no_comment.json["error"]["code"], "validation");
    assert!(
        no_comment.json["error"]["message"]
            .as_str()
            .unwrap()
            .contains("comment")
    );

    // return with only whitespace → still 422.
    let blank_comment = post(
        service.clone(),
        &format!("/api/v1/workflow-tasks/{task_id}/decide"),
        &token,
        json!({ "decision": "return", "comment": "   ", "idempotency_key": "return-blank-000001" }),
    )
    .await;
    assert_eq!(blank_comment.status, StatusCode::UNPROCESSABLE_ENTITY);

    // reject WITH a comment → task REJECTED, run CANCELLED (no reopen).
    let rejected = post(
        service,
        &format!("/api/v1/workflow-tasks/{task_id}/decide"),
        &token,
        json!({ "decision": "reject", "comment": "insufficient evidence", "idempotency_key": "reject-with-comment-01" }),
    )
    .await;
    assert_eq!(rejected.status, StatusCode::OK, "{:?}", rejected.json);
    assert_eq!(rejected.json["task"]["status"], "REJECTED");
    assert_eq!(rejected.json["run"]["status"], "CANCELLED");
    assert_eq!(
        rejected.json["task"]["decision_payload"]["comment"],
        "insufficient evidence"
    );

    let run_status = run_status(&pool, &run_id).await;
    assert_eq!(run_status, "CANCELLED");
}

// ===========================================================================
// 3. Decide approve advances the approval line to the next human task.
// ===========================================================================
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn decision_approve_advances_the_line(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool).await;
    let initiator = UserId::new();
    seed_user(&pool, initiator, "SUPER_ADMIN", branch).await;
    let definition_id = seed_approval_definition(&pool, "approval.instance.advance").await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&keys, initiator, "SUPER_ADMIN", branch);

    let started = post(
        service.clone(),
        "/api/v1/workflow-runs",
        &token,
        json!({
            "definition_id": definition_id,
            "trigger_type": "MANUAL",
            "idempotency_key": "instance-advance-key-00001",
            "input_payload": {}
        }),
    )
    .await;
    let task_id = started.json["next_task"]["task_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let approved = post(
        service,
        &format!("/api/v1/workflow-tasks/{task_id}/decide"),
        &token,
        json!({ "decision": "approve", "idempotency_key": "approve-review-000001" }),
    )
    .await;
    assert_eq!(approved.status, StatusCode::OK, "{:?}", approved.json);
    assert_eq!(approved.json["task"]["status"], "APPROVED");
    assert_eq!(approved.json["run"]["status"], "WAITING");
    assert_eq!(approved.json["next_task"]["waiting_key"], "approve.manager");
    assert_eq!(
        approved.json["next_task"]["assignee_role_key"],
        "manager_approver"
    );
}

// ===========================================================================
// 4. Deny-by-omission: a persona without the policy sees an EMPTY list (not 403).
// ===========================================================================
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn role_inbox_denies_by_omission(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool).await;
    let initiator = UserId::new();
    seed_user(&pool, initiator, "SUPER_ADMIN", branch).await;
    let definition_id = seed_approval_definition(&pool, "approval.instance.inbox").await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let starter_token = bearer(&keys, initiator, "SUPER_ADMIN", branch);

    // Park a review.hr task (required_policy approval_review → completion_review).
    let started = post(
        service.clone(),
        "/api/v1/workflow-runs",
        &starter_token,
        json!({
            "definition_id": definition_id,
            "trigger_type": "MANUAL",
            "idempotency_key": "instance-inbox-key-000001",
            "input_payload": {}
        }),
    )
    .await;
    assert_eq!(started.status, StatusCode::OK, "{:?}", started.json);

    // MECHANIC is DENIED completion_review → sees an empty list (deny-by-omission).
    let mechanic = UserId::new();
    seed_user(&pool, mechanic, "MECHANIC", branch).await;
    let denied = get(
        service.clone(),
        "/api/v1/workflow-tasks?role_key=hr_reviewer&status=OPEN",
        &bearer(&keys, mechanic, "MECHANIC", branch),
    )
    .await;
    assert_eq!(
        denied.status,
        StatusCode::OK,
        "deny-by-omission is 200 empty, never 403"
    );
    assert_eq!(denied.json["items"].as_array().unwrap().len(), 0);

    // ADMIN is ALLOWED completion_review → sees the row.
    let reviewer = UserId::new();
    seed_user(&pool, reviewer, "SUPER_ADMIN", branch).await;
    let allowed = get(
        service,
        "/api/v1/workflow-tasks?role_key=hr_reviewer&status=OPEN",
        &bearer(&keys, reviewer, "SUPER_ADMIN", branch),
    )
    .await;
    assert_eq!(allowed.status, StatusCode::OK);
    let items = allowed.json["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["waiting_key"], "review.hr");
}

// ===========================================================================
// 5. Claim: OPEN → CLAIMED, same-user replay 200, other-user 409.
// ===========================================================================
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn claim_transitions_open_to_claimed_with_replay_and_conflict(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool).await;
    let initiator = UserId::new();
    seed_user(&pool, initiator, "SUPER_ADMIN", branch).await;
    let definition_id = seed_approval_definition(&pool, "approval.instance.claim").await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());

    let started = post(
        service.clone(),
        "/api/v1/workflow-runs",
        &bearer(&keys, initiator, "SUPER_ADMIN", branch),
        json!({
            "definition_id": definition_id,
            "trigger_type": "MANUAL",
            "idempotency_key": "instance-claim-key-000001",
            "input_payload": {}
        }),
    )
    .await;
    let task_id = started.json["next_task"]["task_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let claimer = UserId::new();
    seed_user(&pool, claimer, "SUPER_ADMIN", branch).await;
    let claimer_token = bearer(&keys, claimer, "SUPER_ADMIN", branch);

    let claimed = post(
        service.clone(),
        &format!("/api/v1/workflow-tasks/{task_id}/claim"),
        &claimer_token,
        json!({ "idempotency_key": "claim-key-first-000001" }),
    )
    .await;
    assert_eq!(claimed.status, StatusCode::OK, "{:?}", claimed.json);
    assert_eq!(claimed.json["task"]["status"], "CLAIMED");
    assert_eq!(claimed.json["task"]["claimed_by"], claimer.to_string());

    // Same-user replay → 200.
    let replay = post(
        service.clone(),
        &format!("/api/v1/workflow-tasks/{task_id}/claim"),
        &claimer_token,
        json!({ "idempotency_key": "claim-key-replay-00001" }),
    )
    .await;
    assert_eq!(replay.status, StatusCode::OK);
    assert_eq!(replay.json["task"]["status"], "CLAIMED");

    // A different user → 409.
    let other = UserId::new();
    seed_user(&pool, other, "SUPER_ADMIN", branch).await;
    let conflict = post(
        service,
        &format!("/api/v1/workflow-tasks/{task_id}/claim"),
        &bearer(&keys, other, "SUPER_ADMIN", branch),
        json!({ "idempotency_key": "claim-key-other-000001" }),
    )
    .await;
    assert_eq!(conflict.status, StatusCode::CONFLICT);
    assert_eq!(conflict.json["error"]["code"], "conflict");
}

// ===========================================================================
// 6. Submission box lists the runs the principal initiated.
// ===========================================================================
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn submission_box_lists_initiated_runs(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool).await;
    let initiator = UserId::new();
    seed_user(&pool, initiator, "SUPER_ADMIN", branch).await;
    let definition_id = seed_approval_definition(&pool, "approval.instance.mine").await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&keys, initiator, "SUPER_ADMIN", branch);

    post(
        service.clone(),
        "/api/v1/workflow-runs",
        &token,
        json!({
            "definition_id": definition_id,
            "object_type": "approval_document",
            "object_id": Uuid::new_v4(),
            "trigger_type": "MANUAL",
            "idempotency_key": "instance-mine-key-0000001",
            "input_payload": {}
        }),
    )
    .await;

    let mine = get(service.clone(), "/api/v1/workflow-runs/mine", &token).await;
    assert_eq!(mine.status, StatusCode::OK);
    let items = mine.json["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    // A WAITING (final-approved-but-not-finalized-style non-terminal) run stays visible.
    assert_eq!(items[0]["status"], "WAITING");
    assert_eq!(items[0]["object_type"], "approval_document");

    // A different principal's submission box is empty (initiated_by scoping).
    let stranger = UserId::new();
    seed_user(&pool, stranger, "SUPER_ADMIN", branch).await;
    let empty = get(
        service,
        "/api/v1/workflow-runs/mine",
        &bearer(&keys, stranger, "SUPER_ADMIN", branch),
    )
    .await;
    assert_eq!(empty.status, StatusCode::OK);
    assert_eq!(empty.json["items"].as_array().unwrap().len(), 0);
}

// ---------------------------------------------------------------------------
// Fixtures + helpers.
// ---------------------------------------------------------------------------

/// A linear approval definition: submit (gate) → review.hr → approve.manager →
/// finalize.author. Seeded ACTIVE with one PUBLISHED wf.exec.v1 version.
async fn seed_approval_definition(pool: &PgPool, workflow_key: &str) -> Uuid {
    let org = OrgId::knl();
    let definition = json!({
        "schema_version": "wf.exec.v1",
        "workflow_key": workflow_key,
        "nodes": [
            { "node_key": "submit", "node_type": "object_gate", "title": "Submit" },
            { "node_key": "review.hr", "node_type": "human_task", "title": "HR review",
              "assignee_role_key": "hr_reviewer", "required_policy": "approval_review" },
            { "node_key": "approve.manager", "node_type": "human_task", "title": "Manager approval",
              "assignee_role_key": "manager_approver", "required_policy": "approval_decide" },
            { "node_key": "finalize.author", "node_type": "human_task", "title": "Author finalize",
              "assignee_role_key": "initiator", "required_policy": "approval_finalize" }
        ],
        "edges": [
            { "from": "submit", "to": "review.hr" },
            { "from": "review.hr", "to": "approve.manager" },
            { "from": "approve.manager", "to": "finalize.author" }
        ]
    });
    let definition_id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_definitions \
             (org_id, workflow_key, display_name, object_type, status, latest_version, active_version) \
         VALUES ($1, $2, 'Instance Approval', 'approval_document', 'ACTIVE', 1, 1) \
         RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(workflow_key)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_definition_versions \
             (org_id, definition_id, version, status, definition, required_approval_line, required_payment_line) \
         VALUES ($1, $2, 1, 'PUBLISHED', $3, TRUE, FALSE)",
    )
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(definition)
    .execute(pool)
    .await
    .unwrap();
    definition_id
}

async fn count_runs(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM workflow_runs")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn run_status(pool: &PgPool, run_id: &str) -> String {
    sqlx::query_scalar("SELECT status FROM workflow_runs WHERE id = $1")
        .bind(Uuid::parse_str(run_id).unwrap())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn post(service: axum::Router, uri: &str, token: &str, body: Value) -> JsonResponse {
    send(service, "POST", uri, token, Some(body)).await
}

async fn get(service: axum::Router, uri: &str, token: &str) -> JsonResponse {
    send(service, "GET", uri, token, None).await
}

async fn send(
    service: axum::Router,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> JsonResponse {
    let mut builder = Request::builder()
        .uri(uri)
        .method(method)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    let request = if let Some(body) = body {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        builder.body(Body::from(body.to_string())).unwrap()
    } else {
        builder.body(Body::empty()).unwrap()
    };
    let response = service.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    JsonResponse { status, json }
}

async fn seed_branch(pool: &PgPool) -> BranchId {
    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind("Instance Region")
            .bind(*OrgId::knl().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind("Instance Branch")
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user(pool: &PgPool, user_id: UserId, role: &str, _branch_id: BranchId) {
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("instance-{role}-{}", user_id.as_uuid()))
        .bind(vec![role])
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
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

fn bearer(keys: &Keys, user_id: UserId, role: &str, branch: BranchId) -> String {
    issue_token(
        keys.private_pem.as_bytes(),
        keys.public_pem.as_bytes(),
        user_id,
        vec![role.to_owned()],
        vec![branch],
    )
    .unwrap()
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
        org_id: OrgId::knl(),
        roles,
        branches,
        platform: false,
        view_as: false,
        read_only: false,
        display_name: None,
        feature_grants: Vec::new(),
        issued_at: OffsetDateTime::now_utc(),
    })?)
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
