#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BE-AUTO slice 2 E2E — four-eyes definition publish (pendingRev) over the REAL
//! router on a genuine non-owner `mnt_rt` pool (RLS enforced), JWT-authed, with a
//! REAL passkey step-up (SoftPasskey) satisfying the sensitive-publish gate.
//!
//! Proves:
//!   * a NEW definition (no active version) publishes DIRECTLY (activates);
//!   * publishing a revision to an ALREADY-ACTIVE definition STAGES it (the
//!     active version keeps serving; pending_version is set) instead of applying;
//!   * a SECOND, distinct actor's approve APPLIES the revision (active flips,
//!     pending cleared) and writes NO self-approval finding;
//!   * an exempt (SUPER_ADMIN) publisher self-approving is allowed but records an
//!     `anomaly.self_approval` governance finding (#205 semantics);
//!   * withdraw discards the staged revision (pending cleared, active unchanged).
//!
//! Only SUPER_ADMIN holds RoleManage (the publish/approve authority), and
//! SUPER_ADMIN is the self-approval-exempt tier — so the two reachable paths are
//! "distinct approver (clean)" and "same exempt actor (finding)". The hard 403
//! self-approval block is unit-covered by `enforce_revision_self_approval`'s
//! non-exempt branch (no non-exempt role can reach it under the current matrix).

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{BranchId, OrgId, UserId};
use mnt_platform_auth::{
    AccessTokenInput, JwtIssuer, JwtSettings, PasskeyRegistrationStart, PasskeyService,
    WebauthnSettings,
};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use url::Url;
use webauthn_authenticator_rs::prelude::{RequestChallengeResponse, WebauthnAuthenticator};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";
const RP_ID: &str = "localhost";
const RP_ORIGIN: &str = "http://localhost";

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

fn passkey_service() -> PasskeyService {
    PasskeyService::new(WebauthnSettings {
        rp_id: RP_ID.to_owned(),
        rp_origin: Url::parse(RP_ORIGIN).unwrap(),
        rp_name: "MNT".to_owned(),
        extra_allowed_origins: vec![],
        ceremony_ttl: Duration::minutes(5),
    })
    .unwrap()
}

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(6)
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

fn app_state(pool: PgPool, keys: &Keys) -> AppState {
    let config = AppConfig::from_pairs([
        ("MNT_APP_ROLE", AppRole::Api.to_string()),
        ("MNT_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("MNT_JWT_ISSUER", TEST_ISSUER.to_owned()),
        ("MNT_JWT_AUDIENCE", TEST_AUDIENCE.to_owned()),
        ("MNT_JWT_PUBLIC_KEY_PEM", keys.public_pem.clone()),
        ("MNT_JWT_PRIVATE_KEY_PEM", keys.private_pem.clone()),
        ("MNT_WEBAUTHN_RP_ID", RP_ID.to_owned()),
        ("MNT_WEBAUTHN_RP_ORIGIN", RP_ORIGIN.to_owned()),
    ])
    .unwrap();
    AppState::new(config, DatabaseDependency::Postgres(pool)).unwrap()
}

async fn seed_super_admin(pool: &PgPool, user_id: UserId, label: &str) {
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("four-eyes-{label}"))
        .bind(vec!["SUPER_ADMIN"])
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

fn bearer(keys: &Keys, user_id: UserId) -> String {
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
            org_id: OrgId::knl(),
            roles: vec!["SUPER_ADMIN".to_owned()],
            branches: Vec::<BranchId>::new(),
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

/// Inject one allowCredentials entry so the resident-key-less SoftPasskey can
/// locate its key (copied from the auth crate's ceremony harness).
fn inject_allow_credential(
    challenge: RequestChallengeResponse,
    credential_id: &str,
) -> RequestChallengeResponse {
    let mut value = serde_json::to_value(&challenge).unwrap();
    value
        .get_mut("publicKey")
        .and_then(|pk| pk.get_mut("allowCredentials"))
        .and_then(Value::as_array_mut)
        .expect("discoverable challenge must have an allowCredentials array")
        .push(json!({ "type": "public-key", "id": credential_id }));
    serde_json::from_value(value).unwrap()
}

/// Register a discoverable passkey for `user_id`; returns the authenticator (kept
/// for later step-up assertions) and the stored credential id.
async fn register_passkey(
    owner_pool: &PgPool,
    svc: &PasskeyService,
    user_id: UserId,
    username: &str,
) -> (WebauthnAuthenticator<SoftPasskey>, String) {
    let reg = svc
        .start_registration(
            owner_pool,
            OrgId::knl(),
            PasskeyRegistrationStart {
                user_id: *user_id.as_uuid(),
                username: username.to_owned(),
                display_name: username.to_owned(),
            },
        )
        .await
        .unwrap();
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential = authenticator
        .do_registration(Url::parse(RP_ORIGIN).unwrap(), reg.challenge)
        .unwrap();
    let stored = svc
        .finish_registration(owner_pool, OrgId::knl(), reg.ceremony_id, credential)
        .await
        .unwrap();
    (authenticator, stored.credential_id)
}

/// Produce a fresh step-up assertion body `{ step_up: { ceremony_id, credential } }`
/// for a request that requires passkey step-up.
async fn step_up(
    owner_pool: &PgPool,
    svc: &PasskeyService,
    authenticator: &mut WebauthnAuthenticator<SoftPasskey>,
    credential_id: &str,
) -> Value {
    let auth = svc.start_authentication(owner_pool).await.unwrap();
    let challenge = inject_allow_credential(auth.challenge, credential_id);
    let assertion = authenticator
        .do_authentication(Url::parse(RP_ORIGIN).unwrap(), challenge)
        .unwrap();
    json!({ "step_up": { "ceremony_id": auth.ceremony_id, "credential": assertion } })
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

fn exec_definition() -> Value {
    json!({
        "schema_version": "wf.exec.v1",
        "object_kinds": ["work_order"],
        "nodes": [{ "node_key": "gate", "node_type": "object_gate" }],
        "edges": []
    })
}

async fn create_and_activate(
    service: &axum::Router,
    owner_pool: &PgPool,
    svc: &PasskeyService,
    token: &str,
    authenticator: &mut WebauthnAuthenticator<SoftPasskey>,
    cred_id: &str,
    workflow_key: &str,
) -> String {
    let created = send(
        service.clone(),
        "POST",
        "/api/v1/workflow-studio/definitions",
        token,
        Some(json!({
            "workflow_key": workflow_key,
            "display_name": "Four eyes",
            "object_type": "work_order",
            "definition": exec_definition()
        })),
    )
    .await;
    assert_eq!(created.status, StatusCode::OK, "{:?}", created.json);
    let id = created.json["id"].as_str().unwrap().to_owned();

    // Direct activate (never-published definition).
    let body = step_up(owner_pool, svc, authenticator, cred_id).await;
    let published = send(
        service.clone(),
        "POST",
        &format!("/api/v1/workflow-studio/definitions/{id}/publish"),
        token,
        Some(body),
    )
    .await;
    assert_eq!(published.status, StatusCode::OK, "{:?}", published.json);
    assert_eq!(published.json["status"], "ACTIVE");
    assert!(published.json["active_version"].as_i64().unwrap() >= 1);
    assert!(published.json["pending_version"].is_null());
    id
}

async fn edit_and_stage(
    service: &axum::Router,
    owner_pool: &PgPool,
    svc: &PasskeyService,
    token: &str,
    authenticator: &mut WebauthnAuthenticator<SoftPasskey>,
    cred_id: &str,
    id: &str,
) -> (i64, i64) {
    // Edit the live definition → stages a DRAFT revision, active keeps serving.
    let edited = send(
        service.clone(),
        "PATCH",
        &format!("/api/v1/workflow-studio/definitions/{id}"),
        token,
        Some(json!({ "display_name": "Four eyes (revised)" })),
    )
    .await;
    assert_eq!(edited.status, StatusCode::OK, "{:?}", edited.json);
    assert_eq!(
        edited.json["status"], "ACTIVE",
        "editing a live def must not take it out of service"
    );
    let active_before = edited.json["active_version"].as_i64().unwrap();

    // Publish → STAGE (does not apply).
    let body = step_up(owner_pool, svc, authenticator, cred_id).await;
    let staged = send(
        service.clone(),
        "POST",
        &format!("/api/v1/workflow-studio/definitions/{id}/publish"),
        token,
        Some(body),
    )
    .await;
    assert_eq!(staged.status, StatusCode::OK, "{:?}", staged.json);
    assert_eq!(staged.json["status"], "ACTIVE");
    assert_eq!(
        staged.json["active_version"].as_i64().unwrap(),
        active_before,
        "staging must NOT change the active version"
    );
    let pending = staged.json["pending_version"].as_i64().unwrap();
    assert!(
        pending > active_before,
        "the staged pending revision is a newer version"
    );
    (active_before, pending)
}

async fn finding_count(owner_pool: &PgPool, definition_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM governance_findings \
         WHERE detector_id = 'anomaly.self_approval' \
           AND entity_type = 'workflow_definition' AND entity_id = $1",
    )
    .bind(definition_id)
    .fetch_one(owner_pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn distinct_approver_applies_staged_revision_without_finding(owner_pool: PgPool) {
    let keys = keys();
    let svc = passkey_service();
    let publisher = UserId::new();
    let approver = UserId::new();
    seed_super_admin(&owner_pool, publisher, "publisher").await;
    seed_super_admin(&owner_pool, approver, "approver").await;
    let (mut pub_auth, pub_cred) =
        register_passkey(&owner_pool, &svc, publisher, "publisher").await;
    let (mut app_auth, app_cred) = register_passkey(&owner_pool, &svc, approver, "approver").await;
    let service = build_router(app_state(runtime_role_pool(&owner_pool).await, &keys));
    let pub_token = bearer(&keys, publisher);
    let app_token = bearer(&keys, approver);

    let id = create_and_activate(
        &service,
        &owner_pool,
        &svc,
        &pub_token,
        &mut pub_auth,
        &pub_cred,
        "four.eyes.distinct",
    )
    .await;
    let (active_before, pending) = edit_and_stage(
        &service,
        &owner_pool,
        &svc,
        &pub_token,
        &mut pub_auth,
        &pub_cred,
        &id,
    )
    .await;

    // A DISTINCT actor approves → applies (active flips, pending cleared).
    let body = step_up(&owner_pool, &svc, &mut app_auth, &app_cred).await;
    let approved = send(
        service.clone(),
        "POST",
        &format!("/api/v1/workflow-studio/definitions/{id}/revisions/{pending}/approve"),
        &app_token,
        Some(body),
    )
    .await;
    assert_eq!(approved.status, StatusCode::OK, "{:?}", approved.json);
    assert_eq!(approved.json["status"], "ACTIVE");
    assert!(
        approved.json["active_version"].as_i64().unwrap() > active_before,
        "approval must flip the active version to the applied revision"
    );
    assert!(approved.json["pending_version"].is_null());
    assert_eq!(
        finding_count(&owner_pool, &id).await,
        0,
        "a distinct approver is not a self-approval — no governance finding"
    );
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn exempt_self_approval_is_allowed_and_recorded(owner_pool: PgPool) {
    let keys = keys();
    let svc = passkey_service();
    let publisher = UserId::new();
    seed_super_admin(&owner_pool, publisher, "solo").await;
    let (mut auth, cred) = register_passkey(&owner_pool, &svc, publisher, "solo").await;
    let service = build_router(app_state(runtime_role_pool(&owner_pool).await, &keys));
    let token = bearer(&keys, publisher);

    let id = create_and_activate(
        &service,
        &owner_pool,
        &svc,
        &token,
        &mut auth,
        &cred,
        "four.eyes.solo",
    )
    .await;
    let (_active, pending) =
        edit_and_stage(&service, &owner_pool, &svc, &token, &mut auth, &cred, &id).await;

    // Same SUPER_ADMIN self-approves: allowed (exempt) but recorded as a finding.
    let body = step_up(&owner_pool, &svc, &mut auth, &cred).await;
    let approved = send(
        service.clone(),
        "POST",
        &format!("/api/v1/workflow-studio/definitions/{id}/revisions/{pending}/approve"),
        &token,
        Some(body),
    )
    .await;
    assert_eq!(approved.status, StatusCode::OK, "{:?}", approved.json);
    assert!(approved.json["pending_version"].is_null());
    assert_eq!(
        finding_count(&owner_pool, &id).await,
        1,
        "an exempt self-approval must record an anomaly.self_approval governance finding"
    );
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn withdraw_discards_staged_revision(owner_pool: PgPool) {
    let keys = keys();
    let svc = passkey_service();
    let publisher = UserId::new();
    seed_super_admin(&owner_pool, publisher, "withdrawer").await;
    let (mut auth, cred) = register_passkey(&owner_pool, &svc, publisher, "withdrawer").await;
    let service = build_router(app_state(runtime_role_pool(&owner_pool).await, &keys));
    let token = bearer(&keys, publisher);

    let id = create_and_activate(
        &service,
        &owner_pool,
        &svc,
        &token,
        &mut auth,
        &cred,
        "four.eyes.withdraw",
    )
    .await;
    let (active_before, pending) =
        edit_and_stage(&service, &owner_pool, &svc, &token, &mut auth, &cred, &id).await;

    // Withdraw (no step-up) clears the pending pointer; active stays put.
    let withdrawn = send(
        service.clone(),
        "POST",
        &format!("/api/v1/workflow-studio/definitions/{id}/revisions/{pending}/withdraw"),
        &token,
        None,
    )
    .await;
    assert_eq!(withdrawn.status, StatusCode::OK, "{:?}", withdrawn.json);
    assert!(withdrawn.json["pending_version"].is_null());
    assert_eq!(
        withdrawn.json["active_version"].as_i64().unwrap(),
        active_before,
        "withdraw must not change the active version"
    );
}
