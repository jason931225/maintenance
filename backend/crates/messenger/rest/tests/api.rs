#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_kernel_core::{AuditAction, AuditEvent, BranchId, BranchScope, OrgId, TraceContext, UserId};
use mnt_messenger_adapter_postgres::PgMessengerStore;
use mnt_messenger_application::CreateThreadCommand;
use mnt_messenger_domain::ThreadKind;
use mnt_messenger_rest::{MessengerRestState, router};
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

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn messenger_rest_polling_send_read_and_search_are_authorized(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Messenger REST Region", "Messenger REST Branch").await;
    let other_branch_id = seed_branch(
        &pool,
        "Messenger REST Other Region",
        "Messenger REST Other Branch",
    )
    .await;
    let sender = UserId::new();
    let recipient = UserId::new();
    seed_user_with_branch(&pool, sender, "MECHANIC", branch_id).await;
    seed_user_with_branch(&pool, recipient, "ADMIN", branch_id).await;
    let store = PgMessengerStore::new(pool.clone());
    let thread = store
        .create_thread(CreateThreadCommand {
            actor: sender,
            branch_scope: BranchScope::single(branch_id),
            branch_id,
            kind: ThreadKind::Team,
            title: Some("정비팀".to_owned()),
            work_order_id: None,
            member_ids: vec![sender, recipient],
            trace: mnt_kernel_core::TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    let token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        sender,
        vec!["MECHANIC".to_owned()],
        vec![branch_id],
    )
    .unwrap();
    let wrong_branch_token = issue_token(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        sender,
        vec!["MECHANIC".to_owned()],
        vec![other_branch_id],
    )
    .unwrap();
    let verifier = JwtVerifier::from_es256_public_pem(
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        public_key_pem.as_bytes(),
    )
    .unwrap();
    let service = router(MessengerRestState::new(store, Some(verifier)));

    let denied = post_json(
        service.clone(),
        &format!("/api/messenger/threads/{}/messages", thread.id),
        &wrong_branch_token,
        json!({ "body": "wrong scope" }),
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN, "{:?}", denied.json);

    let sent = post_json(
        service.clone(),
        &format!("/api/messenger/threads/{}/messages", thread.id),
        &token,
        json!({ "body": "긴급 누유 확인" }),
    )
    .await;
    assert_eq!(sent.status, StatusCode::CREATED, "{:?}", sent.json);
    let message_id = sent.json["id"].as_str().unwrap().to_owned();

    let page = get_json(
        service.clone(),
        &format!("/api/messenger/threads/{}/messages?limit=20", thread.id),
        &token,
    )
    .await;
    assert_eq!(page.status, StatusCode::OK, "{:?}", page.json);
    assert_eq!(page.json["items"][0]["id"], message_id);

    let read = put_json(
        service.clone(),
        &format!("/api/messenger/threads/{}/read-receipt", thread.id),
        &token,
        json!({ "last_read_message_id": message_id }),
    )
    .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.json);
    assert_eq!(read.json["last_read_message_id"], message_id);

    let search = get_json(service, "/api/messenger/search?q=누유&limit=10", &token).await;
    assert_eq!(search.status, StatusCode::OK, "{:?}", search.json);
    assert_eq!(search.json["items"][0]["id"], message_id);
}

#[derive(Debug)]
struct JsonResponse {
    status: StatusCode,
    json: Value,
}

async fn get_json(service: axum::Router, uri: &str, token: &str) -> JsonResponse {
    request_json(service, "GET", uri, token, None).await
}

async fn post_json(service: axum::Router, uri: &str, token: &str, body: Value) -> JsonResponse {
    request_json(service, "POST", uri, token, Some(body)).await
}

async fn put_json(service: axum::Router, uri: &str, token: &str, body: Value) -> JsonResponse {
    request_json(service, "PUT", uri, token, Some(body)).await
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
    let request_body = match body {
        Some(body) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = service
        .oneshot(builder.body(request_body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    JsonResponse { status, json }
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
        roles,
        branches,
        issued_at: OffsetDateTime::now_utc(),
    })?)
}

async fn seed_branch(pool: &PgPool, region_name: &str, branch_name: &str) -> BranchId {
    let region_id = uuid::Uuid::new_v4();
    let branch_id = BranchId::new();
    let region_name = format!("{region_name} {}", uuid::Uuid::new_v4());
    let branch_name = format!("{branch_name} {}", uuid::Uuid::new_v4());
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
            sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
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

async fn seed_user_with_branch(pool: &PgPool, user_id: UserId, role: &str, branch_id: BranchId) {
    let role = role.to_owned();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_user").unwrap(),
        "user",
        user_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_branch(branch_id);
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
                .bind(*user_id.as_uuid())
                .bind(format!("Messenger REST {role}"))
                .bind(Vec::from([role]))
                .bind(*OrgId::knl().as_uuid())
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
            sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
                .bind(*user_id.as_uuid())
                .bind(*branch_id.as_uuid())
                .bind(*OrgId::knl().as_uuid())
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
}
