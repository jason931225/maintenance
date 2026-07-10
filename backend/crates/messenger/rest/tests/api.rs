#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, OrgId, TraceContext, UserId,
};
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
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
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
        let outsider = UserId::new();
        seed_user_with_branch(&pool, sender, "MECHANIC", branch_id).await;
        seed_user_with_branch(&pool, recipient, "ADMIN", branch_id).await;
        seed_user_with_branch(&pool, outsider, "MECHANIC", other_branch_id).await;
        let store = PgMessengerStore::new(pool.clone());
        let thread = store
            .create_thread(CreateThreadCommand {
                actor: sender,
                branch_scope: BranchScope::single(branch_id),
                branch_id,
                kind: ThreadKind::Team,
                visibility: None,
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

        let members = get_json(
            service.clone(),
            &format!("/api/messenger/members?branch_id={branch_id}&limit=10"),
            &token,
        )
        .await;
        assert_eq!(members.status, StatusCode::OK, "{:?}", members.json);
        let member_ids = members.json["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|member| member["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert!(member_ids.contains(&sender.to_string()));
        assert!(member_ids.contains(&recipient.to_string()));
        assert!(!member_ids.contains(&outsider.to_string()));

        let denied_members = get_json(
            service.clone(),
            &format!("/api/messenger/members?branch_id={other_branch_id}&limit=10"),
            &token,
        )
        .await;
        assert_eq!(
            denied_members.status,
            StatusCode::FORBIDDEN,
            "{:?}",
            denied_members.json
        );

        let invalid_thread = post_json(
            service.clone(),
            "/api/messenger/threads",
            &token,
            json!({
                "branch_id": branch_id,
                "kind": "dm",
                "title": "cross-branch should fail",
                "member_ids": [outsider],
            }),
        )
        .await;
        assert_eq!(
            invalid_thread.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{:?}",
            invalid_thread.json
        );

        revoke_user_branch(&pool, sender, branch_id).await;
        let denied = post_json(
            service.clone(),
            &format!("/api/messenger/threads/{}/messages", thread.id),
            &token,
            json!({ "body": "revoked branch should fail closed" }),
        )
        .await;
        assert_eq!(denied.status, StatusCode::FORBIDDEN, "{:?}", denied.json);
        grant_user_branch(&pool, sender, branch_id).await;

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
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn messenger_rest_exposes_channel_ack_presence_quote_and_mute_parity(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let signing_key = SigningKey::random(&mut OsRng);
        let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let public_key_pem = signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        let branch_id =
            seed_branch(&pool, "Messenger Parity Region", "Messenger Parity Branch").await;
        let sender = UserId::new();
        let recipient = UserId::new();
        seed_user_with_branch(&pool, sender, "MECHANIC", branch_id).await;
        seed_user_with_branch(&pool, recipient, "ADMIN", branch_id).await;
        let token = issue_token(
            private_pem.as_bytes(),
            public_key_pem.as_bytes(),
            sender,
            vec!["MECHANIC".to_owned()],
            vec![branch_id],
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
        let service = router(MessengerRestState::new(
            PgMessengerStore::new(pool.clone()),
            Some(verifier),
        ));

        let channel = post_json(
            service.clone(),
            "/api/messenger/threads",
            &token,
            json!({
                "branch_id": branch_id,
                "kind": "team",
                "visibility": "channel",
                "title": "배차 관제",
                "member_ids": [sender],
            }),
        )
        .await;
        assert_eq!(channel.status, StatusCode::CREATED, "{:?}", channel.json);
        assert_eq!(channel.json["visibility"], "channel");
        assert_eq!(channel.json["muted"], false);
        let channel_id = channel.json["id"].as_str().unwrap().to_owned();

        let direct = post_json(
            service.clone(),
            "/api/messenger/threads",
            &token,
            json!({
                "branch_id": branch_id,
                "kind": "dm",
                "member_ids": [recipient],
            }),
        )
        .await;
        assert_eq!(direct.status, StatusCode::CREATED, "{:?}", direct.json);
        assert_eq!(direct.json["visibility"], "direct");

        let channels = get_json(service.clone(), "/api/messenger/channels?limit=10", &token).await;
        assert_eq!(channels.status, StatusCode::OK, "{:?}", channels.json);
        assert!(
            channels.json["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["id"] == channel_id && item["visibility"] == "channel"),
            "{:?}",
            channels.json
        );

        let joined = post_json(
            service.clone(),
            &format!("/api/messenger/threads/{channel_id}/join"),
            &token,
            json!({}),
        )
        .await;
        assert_eq!(joined.status, StatusCode::OK, "{:?}", joined.json);
        assert_eq!(joined.json["id"], channel_id);

        let base = post_json(
            service.clone(),
            &format!("/api/messenger/threads/{channel_id}/messages"),
            &token,
            json!({ "body": "WO-2643 배차 확인 부탁" }),
        )
        .await;
        assert_eq!(base.status, StatusCode::CREATED, "{:?}", base.json);
        assert_eq!(base.json["ack_count"], 0);
        assert_eq!(base.json["acked_by_me"], false);
        let base_id = base.json["id"].as_str().unwrap().to_owned();

        let quote = post_json(
            service.clone(),
            &format!("/api/messenger/threads/{channel_id}/messages"),
            &token,
            json!({ "body": "확인했습니다", "quoted_message_id": base_id }),
        )
        .await;
        assert_eq!(quote.status, StatusCode::CREATED, "{:?}", quote.json);
        assert_eq!(quote.json["quoted_message_id"], base_id);
        assert_eq!(quote.json["quoted_body"], "WO-2643 배차 확인 부탁");

        let ack = post_json(
            service.clone(),
            &format!("/api/messenger/messages/{base_id}/ack"),
            &token,
            json!({}),
        )
        .await;
        assert_eq!(ack.status, StatusCode::OK, "{:?}", ack.json);
        assert_eq!(ack.json["acked"], true);
        assert_eq!(ack.json["ack_count"], 1);

        let page = get_json(
            service.clone(),
            &format!("/api/messenger/threads/{channel_id}/messages?limit=20"),
            &token,
        )
        .await;
        assert_eq!(page.status, StatusCode::OK, "{:?}", page.json);
        let base_message = page.json["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["id"] == base_id)
            .unwrap();
        assert_eq!(base_message["ack_count"], 1);
        assert_eq!(base_message["acked_by_me"], true);

        let presence = get_json(
            service.clone(),
            &format!("/api/messenger/threads/{channel_id}/presence"),
            &token,
        )
        .await;
        assert_eq!(presence.status, StatusCode::OK, "{:?}", presence.json);
        assert!(
            presence.json["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["user_id"] == sender.to_string() && item["status"] == "online"),
            "{:?}",
            presence.json
        );

        let mute = put_json(
            service.clone(),
            &format!("/api/messenger/threads/{channel_id}/mute"),
            &token,
            json!({ "muted": true }),
        )
        .await;
        assert_eq!(mute.status, StatusCode::OK, "{:?}", mute.json);
        assert_eq!(mute.json["muted"], true);

        let threads = get_json(service, "/api/messenger/threads?limit=10", &token).await;
        assert_eq!(threads.status, StatusCode::OK, "{:?}", threads.json);
        assert!(
            threads.json["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["id"] == channel_id && item["muted"] == true),
            "{:?}",
            threads.json
        );
    })
    .await;
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

async fn revoke_user_branch(pool: &PgPool, user_id: UserId, branch_id: BranchId) {
    let event = AuditEvent::new(
        Some(user_id),
        AuditAction::new("test.revoke_user_branch").unwrap(),
        "user_branch",
        format!("{user_id}:{branch_id}"),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_branch(branch_id)
    .with_org(OrgId::knl());
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "DELETE FROM user_branches WHERE user_id = $1 AND branch_id = $2 AND org_id = $3",
            )
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

async fn grant_user_branch(pool: &PgPool, user_id: UserId, branch_id: BranchId) {
    let event = AuditEvent::new(
        Some(user_id),
        AuditAction::new("test.grant_user_branch").unwrap(),
        "user_branch",
        format!("{user_id}:{branch_id}"),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_branch(branch_id)
    .with_org(OrgId::knl());
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                r#"
                INSERT INTO user_branches (user_id, branch_id, org_id)
                VALUES ($1, $2, $3)
                ON CONFLICT (user_id, branch_id) DO NOTHING
                "#,
            )
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
            sqlx::query(
                "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(*user_id.as_uuid())
            .bind(format!("Messenger REST {role}"))
            .bind(Vec::from([role]))
            .bind(*OrgId::knl().as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            sqlx::query(
                "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)",
            )
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
