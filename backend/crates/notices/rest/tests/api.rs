#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! HTTP-level authz + recipient-scoping for the notice board.
//!
//! Proves over the real router: draft creation/publish/progress require the
//! publish tier (a plain ADMIN gets 403, not a silent 200); a published
//! notice is readable by anyone; 수령확인 is recipient-scoped from the JWT.

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use mnt_notices_adapter_postgres::PgNoticeStore;
use mnt_notices_rest::{NoticeRestState, router};
use mnt_notifications_adapter_postgres::PgNotificationStore;
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_test_support::{grant_mnt_rt, runtime_role_pool};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn notice_board_rest_is_publish_tier_gated_and_recipient_scoped(pool: PgPool) {
    mnt_platform_request_context::scope_org(OrgId::knl(), async move {
        let signing_key = SigningKey::random(&mut OsRng);
        let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let public_key_pem = signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();

        let manager = UserId::new();
        let plain_admin = UserId::new();
        seed_user(&pool, manager, "Manager").await;
        seed_user(&pool, plain_admin, "Plain Admin").await;

        let verifier = JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            public_key_pem.as_bytes(),
        )
        .unwrap();

        grant_mnt_rt(
            &pool,
            &[
                "GRANT SELECT, INSERT, UPDATE ON notices TO mnt_rt",
                "GRANT SELECT, INSERT, UPDATE ON notice_receipts TO mnt_rt",
                "GRANT SELECT, INSERT, UPDATE ON notifications TO mnt_rt",
                "GRANT SELECT, INSERT, UPDATE ON object_code_counters TO mnt_rt",
                "GRANT SELECT ON object_types TO mnt_rt",
            ],
        )
        .await;
        let rt_pool = runtime_role_pool(&pool).await;
        let notifications = PgNotificationStore::new(rt_pool.clone());
        let store =
            PgNoticeStore::new(rt_pool.clone()).with_notification_sink(Arc::new(notifications));
        let service = router(NoticeRestState::new(store, Some(verifier)));

        let manager_token = issue_token(
            private_pem.as_bytes(),
            public_key_pem.as_bytes(),
            manager,
            &["SUPER_ADMIN"],
        );
        let plain_token = issue_token(
            private_pem.as_bytes(),
            public_key_pem.as_bytes(),
            plain_admin,
            &["ADMIN"],
        );

        // A plain ADMIN cannot create a draft: 403, not a silent success.
        let denied = post_json(
            service.clone(),
            "/api/v1/notices",
            &plain_token,
            serde_json::json!({"title": "전사 공지", "body": "본문"}),
        )
        .await;
        assert_eq!(denied.status, StatusCode::FORBIDDEN, "{:?}", denied.json);

        // The publish-tier manager creates a draft.
        let created = post_json(
            service.clone(),
            "/api/v1/notices",
            &manager_token,
            serde_json::json!({"title": "전사 공지", "body": "본문"}),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.json);
        let notice_id = created.json["id"].as_str().unwrap().to_owned();
        assert_eq!(created.json["status"].as_str(), Some("draft"));

        // A plain ADMIN cannot see the draft (get -> 404, list excludes it).
        let hidden = get_json(
            service.clone(),
            &format!("/api/v1/notices/{notice_id}"),
            &plain_token,
        )
        .await;
        assert_eq!(hidden.status, StatusCode::NOT_FOUND);

        let plain_list = get_json(service.clone(), "/api/v1/notices", &plain_token).await;
        assert!(plain_list.json.as_array().unwrap().is_empty());

        // A plain ADMIN cannot publish: 403.
        let publish_denied = post_json_empty(
            service.clone(),
            &format!("/api/v1/notices/{notice_id}/publish"),
            &plain_token,
        )
        .await;
        assert_eq!(publish_denied.status, StatusCode::FORBIDDEN);

        // The manager publishes.
        let published = post_json_empty(
            service.clone(),
            &format!("/api/v1/notices/{notice_id}/publish"),
            &manager_token,
        )
        .await;
        assert_eq!(published.status, StatusCode::OK, "{:?}", published.json);
        assert_eq!(published.json["status"].as_str(), Some("published"));
        assert!(published.json["code"].as_str().unwrap().starts_with("NT-"));

        // Now the plain ADMIN can read it (published notices are open).
        let visible = get_json(
            service.clone(),
            &format!("/api/v1/notices/{notice_id}"),
            &plain_token,
        )
        .await;
        assert_eq!(visible.status, StatusCode::OK);

        // Both manager + plain admin were snapshotted as recipients (every
        // active org member); each can acknowledge exactly their own receipt.
        let ack = post_json_empty(
            service.clone(),
            &format!("/api/v1/notices/{notice_id}/ack"),
            &plain_token,
        )
        .await;
        assert_eq!(ack.status, StatusCode::NO_CONTENT, "{:?}", ack.json);

        // Progress-read requires the publish tier: plain admin -> 403.
        let progress_denied = get_json(
            service.clone(),
            &format!("/api/v1/notices/{notice_id}/progress"),
            &plain_token,
        )
        .await;
        assert_eq!(progress_denied.status, StatusCode::FORBIDDEN);

        let progress = get_json(
            service.clone(),
            &format!("/api/v1/notices/{notice_id}/progress"),
            &manager_token,
        )
        .await;
        assert_eq!(progress.status, StatusCode::OK, "{:?}", progress.json);
        assert_eq!(progress.json["total"].as_i64(), Some(2));
        assert_eq!(progress.json["acknowledged"].as_i64(), Some(1));

        // Unauthenticated request is rejected.
        let anon = service
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/notices")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);
    })
    .await;
}

struct JsonResponse {
    status: StatusCode,
    json: Value,
}

async fn get_json(service: axum::Router, uri: &str, token: &str) -> JsonResponse {
    request(service, "GET", uri, Some(token), None).await
}

async fn post_json_empty(service: axum::Router, uri: &str, token: &str) -> JsonResponse {
    request(service, "POST", uri, Some(token), None).await
}

async fn post_json(service: axum::Router, uri: &str, token: &str, body: Value) -> JsonResponse {
    request(service, "POST", uri, Some(token), Some(body)).await
}

async fn request(
    service: axum::Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> JsonResponse {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let request_body = match body {
        Some(value) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&value).unwrap())
        }
        None => Body::empty(),
    };
    let response = service
        .oneshot(builder.body(request_body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    JsonResponse { status, json }
}

fn issue_token(
    private_key_pem: &[u8],
    public_key_pem: &[u8],
    user_id: UserId,
    roles: &[&str],
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
            roles: roles.iter().map(|r| (*r).to_owned()).collect(),
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
                "INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, $2, $3, $4, true)",
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
