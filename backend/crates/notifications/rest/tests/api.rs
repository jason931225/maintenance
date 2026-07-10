#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! HTTP-level person-scoping for the notification center.
//!
//! Proves over the real router that the recipient is bound from the JWT, never
//! the request: user A lists only A's notifications; user B gets 404 (not a
//! silent success) marking A's notification read, and never sees it in a list.

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use mnt_notifications_adapter_postgres::PgNotificationStore;
use mnt_notifications_application::EmitNotificationCommand;
use mnt_notifications_domain::NotificationLink;
use mnt_notifications_rest::{NotificationRestState, router};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_test_support::runtime_role_pool;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn notifications_rest_is_recipient_scoped(pool: PgPool) {
    mnt_platform_request_context::scope_org(OrgId::knl(), async move {
        let signing_key = SigningKey::random(&mut OsRng);
        let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let public_key_pem = signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();

        let user_a = UserId::new();
        let user_b = UserId::new();
        seed_user(&pool, user_a, "Approver A").await;
        seed_user(&pool, user_b, "Approver B").await;

        let store = PgNotificationStore::new(pool.clone());
        // Seed one notification for each user via the write port.
        let a_notif = store
            .emit_notification(emit_to(user_a))
            .await
            .expect("emit to A");
        store
            .emit_notification(emit_to(user_b))
            .await
            .expect("emit to B");

        let verifier = JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            public_key_pem.as_bytes(),
        )
        .unwrap();
        let service = router(NotificationRestState::new(
            PgNotificationStore::new(runtime_role_pool(&pool).await),
            Some(verifier),
        ));
        let token_a = issue_token(private_pem.as_bytes(), public_key_pem.as_bytes(), user_a);
        let token_b = issue_token(private_pem.as_bytes(), public_key_pem.as_bytes(), user_b);

        // A lists: sees exactly A's notification.
        let a_list = get_json(
            service.clone(),
            "/api/v1/me/notifications?unread=true&limit=10",
            &token_a,
        )
        .await;
        assert_eq!(a_list.status, StatusCode::OK, "{:?}", a_list.json);
        let a_items = a_list.json["items"].as_array().unwrap();
        assert_eq!(a_items.len(), 1);
        assert_eq!(a_items[0]["id"].as_str().unwrap(), a_notif.id.to_string());
        assert_eq!(
            a_items[0]["text"].as_str().unwrap(),
            "결재 문서가 도착했습니다"
        );

        // B lists: sees only B's, never A's.
        let b_list = get_json(
            service.clone(),
            "/api/v1/me/notifications?unread=true&limit=10",
            &token_b,
        )
        .await;
        assert_eq!(b_list.status, StatusCode::OK);
        let b_items = b_list.json["items"].as_array().unwrap();
        assert_eq!(b_items.len(), 1);
        assert_ne!(b_items[0]["id"].as_str().unwrap(), a_notif.id.to_string());

        // Unread-count is recipient-scoped: each sees exactly their own one.
        let a_count = get_json(
            service.clone(),
            "/api/v1/me/notifications/unread-count",
            &token_a,
        )
        .await;
        assert_eq!(a_count.status, StatusCode::OK, "{:?}", a_count.json);
        assert_eq!(a_count.json["unread"].as_i64(), Some(1));
        let b_count = get_json(
            service.clone(),
            "/api/v1/me/notifications/unread-count",
            &token_b,
        )
        .await;
        assert_eq!(b_count.json["unread"].as_i64(), Some(1), "B's own count");

        // B marking A's notification read -> 404 (recipient scoping).
        let cross = post_empty(
            service.clone(),
            &format!("/api/v1/me/notifications/{}/read", a_notif.id),
            &token_b,
        )
        .await;
        assert_eq!(
            cross.status,
            StatusCode::NOT_FOUND,
            "B must get 404 marking A's notification, got {:?}",
            cross.json
        );

        // A marks its own read -> 200, unread=false.
        let ok = post_empty(
            service.clone(),
            &format!("/api/v1/me/notifications/{}/read", a_notif.id),
            &token_a,
        )
        .await;
        assert_eq!(ok.status, StatusCode::OK, "{:?}", ok.json);
        assert_eq!(ok.json["unread"].as_bool(), Some(false));

        // A marks-all read -> 200 with a count.
        let all = post_empty(
            service.clone(),
            "/api/v1/me/notifications/read-all",
            &token_a,
        )
        .await;
        assert_eq!(all.status, StatusCode::OK);
        assert!(all.json["marked"].as_u64().is_some());

        // After marking all read, A's unread-count is zero.
        let a_count_after = get_json(
            service.clone(),
            "/api/v1/me/notifications/unread-count",
            &token_a,
        )
        .await;
        assert_eq!(a_count_after.json["unread"].as_i64(), Some(0));

        // Unauthenticated request is rejected.
        let anon = service
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/me/notifications")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);
    })
    .await;
}

fn emit_to(recipient: UserId) -> EmitNotificationCommand {
    EmitNotificationCommand {
        actor: None,
        recipient,
        category: "결재".to_owned(),
        text: "결재 문서가 도착했습니다".to_owned(),
        link: NotificationLink::Screen {
            screen: "approvals".to_owned(),
        },
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
    request(service, "GET", uri, Some(token)).await
}

async fn post_empty(service: axum::Router, uri: &str, token: &str) -> JsonResponse {
    request(service, "POST", uri, Some(token)).await
}

async fn request(
    service: axum::Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
) -> JsonResponse {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = service
        .oneshot(builder.body(Body::empty()).unwrap())
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
    // Wrapped in with_audit so the audit-coverage gate (which scans rest-crate
    // handler surfaces, tests included) sees a mutation routed through the
    // transactional audit wrapper, matching the messenger REST test seed.
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
