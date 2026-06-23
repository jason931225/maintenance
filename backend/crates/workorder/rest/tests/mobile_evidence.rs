#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::future::Future;
use std::pin::Pin;

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_kernel_core::{BranchId, OrgId, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_storage::{
    CopyObjectRequest, EvidenceService, ObjectHead, PresignPutRequest, PresignedUpload,
    RetentionInfo, S3ObjectStore, StorageError, StorageFuture,
};
use mnt_workorder_adapter_postgres::PgWorkOrderStore;
use mnt_workorder_rest::{MobileRestState, mobile_router};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

#[path = "../../../../test_support/mobile_evidence_fixtures.rs"]
#[allow(dead_code)]
mod mobile_evidence_fixtures;

use mobile_evidence_fixtures::{
    seed_assigned_work_order, seed_branch, seed_equipment, seed_terminal_work_order,
    seed_user_with_branch,
};

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";

#[derive(Debug, Clone)]
struct StaticObjectStore;

impl S3ObjectStore for StaticObjectStore {
    fn presign_put(&self, request: PresignPutRequest) -> StorageFuture<'_, PresignedUpload> {
        Box::pin(async move {
            Ok(PresignedUpload {
                method: "PUT".to_owned(),
                url: format!("http://storage.local/{}/{}", request.bucket, request.key),
                headers: vec![
                    ("content-type".to_owned(), request.content_type),
                    ("content-length".to_owned(), request.size_bytes.to_string()),
                ],
                expires_in_secs: request.expires_in.as_secs(),
            })
        })
    }

    fn copy_object(&self, _request: CopyObjectRequest) -> StorageFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn head_object(&self, _bucket: String, _key: String) -> StorageFuture<'_, ObjectHead> {
        Box::pin(async {
            Ok(ObjectHead {
                size_bytes: 1024,
                e_tag: Some("\"etag\"".to_owned()),
                checksum_sha256: None,
                object_lock_mode: Some("COMPLIANCE".to_owned()),
                retain_until: Some("2026-06-13T00:00:00Z".to_owned()),
            })
        })
    }

    fn get_object_retention(
        &self,
        _bucket: String,
        _key: String,
    ) -> Pin<Box<dyn Future<Output = Result<RetentionInfo, StorageError>> + Send + '_>> {
        Box::pin(async {
            Ok(RetentionInfo {
                mode: Some("COMPLIANCE".to_owned()),
                retain_until: Some("2026-06-13T00:00:00Z".to_owned()),
            })
        })
    }
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn evidence_presign_confirm_flow_is_authorized_and_audited(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let signing_key = SigningKey::random(&mut OsRng);
        let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let public_key_pem = signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        let branch_id =
            seed_branch(&pool, "Evidence Mobile Region", "Evidence Mobile Branch").await;
        let mechanic = UserId::new();
        let receptionist = UserId::new();
        seed_user_with_branch(&pool, mechanic, "MECHANIC", branch_id).await;
        seed_user_with_branch(&pool, receptionist, "RECEPTIONIST", branch_id).await;
        let equipment_id = seed_equipment(&pool, branch_id, "291").await;
        let work_order_id =
            seed_assigned_work_order(&pool, branch_id, equipment_id, receptionist, mechanic).await;
        let token = issue_token(
            private_pem.as_bytes(),
            public_key_pem.as_bytes(),
            mechanic,
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
        let evidence = EvidenceService::new(
            pool.clone(),
            StaticObjectStore,
            "primary".to_owned(),
            "replica".to_owned(),
        );
        let service = mobile_router(MobileRestState::new(
            pool.clone(),
            PgWorkOrderStore::new(pool.clone()),
            Some(verifier),
            Some(evidence),
        ));

        let presign = post_json(
            service.clone(),
            "/api/v1/evidence/presign",
            &token,
            json!({
                "work_order_id": work_order_id,
                "stage": "AFTER",
                "content_type": "image/jpeg",
                "size_bytes": 1024
            }),
        )
        .await;
        assert_eq!(presign.status, StatusCode::OK, "{:?}", presign.json);
        assert_eq!(presign.json["stage"], "AFTER");
        assert_eq!(presign.json["upload"]["method"], "PUT");
        let evidence_id = presign.json["id"].as_str().unwrap();

        let confirm = post_json(
            service,
            &format!("/api/v1/evidence/{evidence_id}/confirm"),
            &token,
            json!({}),
        )
        .await;
        assert_eq!(confirm.status, StatusCode::OK, "{:?}", confirm.json);
        assert_eq!(confirm.json["worm_replica_status"], "VERIFIED");

        let actions: Vec<String> = sqlx::query_scalar(
            "SELECT action FROM audit_events WHERE target_id = $1 ORDER BY occurred_at, created_at",
        )
        .bind(evidence_id)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(actions.contains(&"evidence.upload".to_owned()));
        assert!(actions.contains(&"evidence.presign".to_owned()));
        assert!(actions.contains(&"evidence.confirm".to_owned()));
        assert!(actions.contains(&"evidence.verify".to_owned()));

        let confirmed_at: Option<OffsetDateTime> =
            sqlx::query_scalar("SELECT upload_confirmed_at FROM evidence_media WHERE id = $1")
                .bind(uuid::Uuid::parse_str(evidence_id).unwrap())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(confirmed_at.is_some());
    })
    .await;
}

// FIX 3 (REST layer): a presign request for AFTER evidence on a terminal work
// order is rejected with a 409-class error and no evidence/audit rows persist.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn presign_after_evidence_rejected_on_final_completed_work_order(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let signing_key = SigningKey::random(&mut OsRng);
        let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let public_key_pem = signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        let branch_id = seed_branch(&pool, "Terminal WORM Region", "Terminal WORM Branch").await;
        let mechanic = UserId::new();
        let receptionist = UserId::new();
        seed_user_with_branch(&pool, mechanic, "MECHANIC", branch_id).await;
        seed_user_with_branch(&pool, receptionist, "RECEPTIONIST", branch_id).await;
        let equipment_id = seed_equipment(&pool, branch_id, "292").await;
        let work_order_id = seed_terminal_work_order(
            &pool,
            branch_id,
            equipment_id,
            receptionist,
            mechanic,
            "FINAL_COMPLETED",
        )
        .await;
        let token = issue_token(
            private_pem.as_bytes(),
            public_key_pem.as_bytes(),
            mechanic,
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
        let evidence = EvidenceService::new(
            pool.clone(),
            StaticObjectStore,
            "primary".to_owned(),
            "replica".to_owned(),
        );
        let service = mobile_router(MobileRestState::new(
            pool.clone(),
            PgWorkOrderStore::new(pool.clone()),
            Some(verifier),
            Some(evidence),
        ));

        let presign = post_json(
            service,
            "/api/v1/evidence/presign",
            &token,
            json!({
                "work_order_id": work_order_id,
                "stage": "AFTER",
                "content_type": "image/jpeg",
                "size_bytes": 1024
            }),
        )
        .await;
        assert_eq!(presign.status, StatusCode::CONFLICT, "{:?}", presign.json);
        assert_eq!(presign.json["error"]["code"], "conflict");
        assert!(
            presign.json["error"]["message"]
                .as_str()
                .unwrap()
                .contains("terminal"),
            "{:?}",
            presign.json
        );

        let media_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM evidence_media WHERE work_order_id = $1")
                .bind(*work_order_id.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(media_count, 0);
    })
    .await;
}

struct JsonResponse {
    status: StatusCode,
    json: Value,
}

async fn post_json(service: axum::Router, uri: &str, token: &str, body: Value) -> JsonResponse {
    let response = service
        .oneshot(
            Request::builder()
                .uri(uri)
                .method("POST")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
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
        issued_at: OffsetDateTime::now_utc(),
    })?)
}
