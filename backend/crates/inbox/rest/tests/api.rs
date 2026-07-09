#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! HTTP-level person-scoping + passkey-gated receipt confirmation for the
//! statutory-notice vault.
//!
//! Proves over the real router that:
//!   * the recipient is bound from the JWT, never the request (B gets 404
//!     reading/confirming A's legal notice — deny-by-omission, not a leak);
//!   * a locked legal notice's body is withheld until receipt is confirmed;
//!   * confirm-receipt without a fresh passkey step-up is 428 (precondition
//!     required), and a valid step-up confirms + unlocks + is idempotent.

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_inbox_adapter_postgres::PgInboxStore;
use mnt_inbox_application::EmitInboxDocCommand;
use mnt_inbox_domain::{InboxDocKind, NewInboxDoc};
use mnt_inbox_rest::{InboxRestState, router};
use mnt_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use mnt_platform_auth::{
    AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier, PasskeyRegistrationStart,
    PasskeyService, WebauthnSettings,
};
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_test_support::runtime_role_pool;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use url::Url;
use webauthn_authenticator_rs::prelude::{RequestChallengeResponse, WebauthnAuthenticator};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";

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

/// Register a passkey for `user_id`, then start + finish an authentication
/// ceremony, returning the `{ ceremony_id, credential }` step-up body.
async fn fresh_step_up(pool: &PgPool, user_id: UserId, display_name: &str) -> Value {
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
    let stored = service
        .finish_registration(pool, OrgId::knl(), registration.ceremony_id, credential)
        .await
        .unwrap();

    let authentication = service.start_authentication(pool).await.unwrap();
    let challenge = inject_allow_credential(authentication.challenge, &stored.credential_id);
    let assertion = authenticator
        .do_authentication(Url::parse("https://auth.example.com").unwrap(), challenge)
        .unwrap();
    json!({ "ceremony_id": authentication.ceremony_id, "credential": assertion })
}

fn inject_allow_credential(
    challenge: RequestChallengeResponse,
    credential_id: &str,
) -> RequestChallengeResponse {
    let mut value = serde_json::to_value(&challenge).unwrap();
    let allow = value
        .get_mut("publicKey")
        .and_then(|pk| pk.get_mut("allowCredentials"))
        .and_then(Value::as_array_mut)
        .expect("authentication challenge must have an allowCredentials array");
    allow.push(json!({ "type": "public-key", "id": credential_id }));
    serde_json::from_value(value).unwrap()
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn inbox_receipt_flow_is_person_scoped_and_passkey_gated(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();

    let user_a = UserId::new();
    let user_b = UserId::new();
    seed_user(&pool, user_a, "Employee A").await;
    seed_user(&pool, user_b, "Employee B").await;

    // Seed a legal notice for A via the write port (owner pool, scoped to knl).
    let doc = mnt_platform_request_context::scope_org(OrgId::knl(), async {
        PgInboxStore::new(pool.clone())
            .emit_inbox_doc(legal_notice_to(user_a))
            .await
    })
    .await
    .expect("emit legal notice to A");

    let verifier = JwtVerifier::from_es256_public_pem(
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        public_key_pem.as_bytes(),
    )
    .unwrap();
    let rt_pool = runtime_role_pool(&pool).await;
    let service = router(
        InboxRestState::new(PgInboxStore::new(rt_pool), Some(verifier))
            .with_passkey_step_up(Some(passkey_service())),
    );
    let token_a = issue_token(private_pem.as_bytes(), public_key_pem.as_bytes(), user_a);
    let token_b = issue_token(private_pem.as_bytes(), public_key_pem.as_bytes(), user_b);

    // A lists action-required: sees exactly its own locked legal notice.
    let list = get_json(
        service.clone(),
        "/api/v1/me/inbox-docs?filter=action",
        &token_a,
    )
    .await;
    assert_eq!(list.status, StatusCode::OK, "{:?}", list.json);
    let items = list.json["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"].as_str().unwrap(), doc.id.to_string());
    assert_eq!(items[0]["locked"].as_bool(), Some(true));

    // A reads the locked doc: metadata yes, body withheld, not auto-confirmed.
    let locked = get_json(
        service.clone(),
        &format!("/api/v1/me/inbox-docs/{}", doc.id),
        &token_a,
    )
    .await;
    assert_eq!(locked.status, StatusCode::OK, "{:?}", locked.json);
    assert_eq!(locked.json["locked"].as_bool(), Some(true));
    assert!(
        locked.json.get("payload").is_none(),
        "a locked legal notice must not disclose its body"
    );

    // B cannot read A's doc -> 404 (deny-by-omission).
    let cross_read = get_json(
        service.clone(),
        &format!("/api/v1/me/inbox-docs/{}", doc.id),
        &token_b,
    )
    .await;
    assert_eq!(cross_read.status, StatusCode::NOT_FOUND);

    // Confirm without a step-up -> 428 precondition required.
    let no_stepup = post_json(
        service.clone(),
        &format!("/api/v1/me/inbox-docs/{}/confirm-receipt", doc.id),
        &token_a,
        json!({}),
    )
    .await;
    assert_eq!(
        no_stepup.status,
        StatusCode::PRECONDITION_REQUIRED,
        "{:?}",
        no_stepup.json
    );
    assert_eq!(no_stepup.json["error"]["code"], "passkey_step_up_required");

    // B cannot confirm A's receipt even WITH B's own valid step-up -> 404.
    let b_stepup = fresh_step_up(&pool, user_b, "Employee B").await;
    let cross_confirm = post_json(
        service.clone(),
        &format!("/api/v1/me/inbox-docs/{}/confirm-receipt", doc.id),
        &token_b,
        json!({ "step_up": b_stepup }),
    )
    .await;
    assert_eq!(
        cross_confirm.status,
        StatusCode::NOT_FOUND,
        "B cannot forge A's legal receipt: {:?}",
        cross_confirm.json
    );

    // A confirms its own receipt with a fresh step-up -> 200, unlocked.
    let a_stepup = fresh_step_up(&pool, user_a, "Employee A").await;
    let confirmed = post_json(
        service.clone(),
        &format!("/api/v1/me/inbox-docs/{}/confirm-receipt", doc.id),
        &token_a,
        json!({ "step_up": a_stepup }),
    )
    .await;
    assert_eq!(confirmed.status, StatusCode::OK, "{:?}", confirmed.json);
    assert_eq!(confirmed.json["locked"].as_bool(), Some(false));
    assert_eq!(
        confirmed.json["confirmed_by"].as_str().unwrap(),
        user_a.to_string()
    );

    // Body is now disclosed on read.
    let unlocked = get_json(
        service.clone(),
        &format!("/api/v1/me/inbox-docs/{}", doc.id),
        &token_a,
    )
    .await;
    assert!(
        unlocked.json.get("payload").is_some(),
        "body is disclosed after receipt: {:?}",
        unlocked.json
    );

    // Idempotent re-confirm with a new step-up -> 200, same stamp.
    let a_stepup2 = fresh_step_up(&pool, user_a, "Employee A").await;
    let again = post_json(
        service.clone(),
        &format!("/api/v1/me/inbox-docs/{}/confirm-receipt", doc.id),
        &token_a,
        json!({ "step_up": a_stepup2 }),
    )
    .await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(again.json["confirmed_at"], confirmed.json["confirmed_at"]);

    // Unauthenticated request is rejected.
    let anon = service
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/v1/me/inbox-docs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);
}

fn legal_notice_to(recipient: UserId) -> EmitInboxDocCommand {
    EmitInboxDocCommand {
        actor: None,
        recipient,
        doc: NewInboxDoc::new(
            InboxDocKind::LegalNotice,
            "연차 사용 촉진 통지 (1차)",
            Some("연차촉진"),
            Some("근로기준법 §61"),
            Some("workflow_run"),
            Some("AP-3111"),
            json!({ "paragraphs": ["귀하의 미사용 연차 사용을 촉진합니다."] }),
        )
        .unwrap(),
        dedup_key: None,
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    }
}

struct JsonResponse {
    status: StatusCode,
    json: Value,
}

async fn get_json(service: axum::Router, uri: &str, token: &str) -> JsonResponse {
    let response = service
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    into_json(response).await
}

async fn post_json(service: axum::Router, uri: &str, token: &str, body: Value) -> JsonResponse {
    let response = service
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    into_json(response).await
}

async fn into_json(response: axum::response::Response) -> JsonResponse {
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    JsonResponse { status, json }
}

fn issue_token(private_key_pem: &[u8], public_key_pem: &[u8], user_id: UserId) -> String {
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
            roles: vec!["ADMIN".to_owned()],
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

async fn seed_user(pool: &PgPool, user_id: UserId, name: &str) {
    let name = name.to_owned();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_user").unwrap(),
        "user",
        user_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::knl());
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(user_id.as_uuid())
            .bind(format!("{name} {}", uuid::Uuid::new_v4()))
            .bind(Vec::from(["ADMIN"]))
            .bind(OrgId::knl().as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
}
