//! REST-level tests for the unauthenticated customer intake endpoint:
//! rate-limit 429 past cap, and a successful 202 acknowledgement.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use mnt_platform_test_support::runtime_role_pool;
use mnt_support_adapter_postgres::{MAX_BODY_CHARS, PgSupportStore};
use mnt_support_rest::{SupportRestState, router};
use sqlx::PgPool;
use tower::ServiceExt;

async fn build(owner_pool: &PgPool) -> Router {
    // No JWT verifier and no push notifier: the intake endpoint is
    // unauthenticated, and notifications degrade gracefully.
    router(SupportRestState::new(
        PgSupportStore::new(runtime_role_pool(owner_pool).await),
        None,
        None,
    ))
}

fn intake_request(ip: &str) -> Request<Body> {
    let body = serde_json::json!({
        "category": "COMPLAINT",
        "priority": "MEDIUM",
        "title": "Late delivery",
        "body": "The forklift never arrived",
        "requester_name": "Customer",
        "requester_contact": "010-0000-0000"
    })
    .to_string();
    Request::builder()
        .method("POST")
        .uri("/api/v1/support/intake")
        .header("content-type", "application/json")
        .header("x-forwarded-for", ip)
        .body(Body::from(body))
        .unwrap()
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn intake_succeeds_then_rate_limits_past_cap(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let app = build(&pool).await;
        let ip = "203.0.113.42";
        // Per-IP cap is 5; the 6th request in the window must be 429.
        let cap = 5;

        for i in 0..cap {
            let response = app.clone().oneshot(intake_request(ip)).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::ACCEPTED,
                "request {i} should be accepted"
            );
        }

        let limited = app.clone().oneshot(intake_request(ip)).await.unwrap();
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);

        // A different IP is independent and still accepted.
        let other = app
            .clone()
            .oneshot(intake_request("198.51.100.1"))
            .await
            .unwrap();
        assert_eq!(other.status(), StatusCode::ACCEPTED);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn intake_rejects_missing_fields_generically(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let app = build(&pool).await;
        let body = serde_json::json!({
            "category": "OTHER",
            "priority": "LOW",
            "title": "   ",
            "body": "x",
            "requester_name": "Cust",
            "requester_contact": "c@example.com"
        })
        .to_string();
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/support/intake")
            .header("content-type", "application/json")
            .header("x-forwarded-for", "203.0.113.99")
            .body(Body::from(body))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn intake_rejects_over_length_fields_generically(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let app = build(&pool).await;
        // One scalar past the store-side body bound: must be rejected at the edge
        // with a generic 400, before any persistence.
        let body = serde_json::json!({
            "category": "OTHER",
            "priority": "LOW",
            "title": "Late delivery",
            "body": "x".repeat(MAX_BODY_CHARS + 1),
            "requester_name": "Cust",
            "requester_contact": "c@example.com"
        })
        .to_string();
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/support/intake")
            .header("content-type", "application/json")
            .header("x-forwarded-for", "203.0.113.77")
            .body(Body::from(body))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    })
    .await;
}
