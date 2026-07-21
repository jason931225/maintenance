#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! HTTP composition proof for object-type key CAS.
//!
//! Every request traverses the real ontology router, signed-JWT request context,
//! and a genuine `mnt_rt` pool so RLS and the transactional audit path are part
//! of the proof rather than mocked away.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use mnt_governance_adapter_postgres::PgGovernanceStore;
use mnt_kernel_core::{OrgId, UserId};
use mnt_ontology_adapter_postgres::PgOntologyStore;
use mnt_ontology_adapter_postgres::instances::PgInstanceStore;
use mnt_ontology_rest::{OntologyRestState, router};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";
const KEY: &str = "cas.http.proof";

struct TestAuth {
    token: String,
    verifier: JwtVerifier,
}

struct HttpResponse {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Value,
}

#[derive(Debug, PartialEq, Eq)]
struct StoredState {
    title: String,
    object_type_rows: i64,
    key_revision: i64,
    stage_audits: i64,
}

async fn command_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_ontology_cmd")
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn object_type_cas_is_enforced_by_the_real_router(owner_pool: PgPool) {
    let org = OrgId::knl();
    let actor = seed_org_and_super_admin(&owner_pool, *org.as_uuid(), "ontology-cas-http").await;
    let auth = test_auth(actor, org);
    let runtime_pool = runtime_role_pool(&owner_pool).await;
    let service = router(OntologyRestState::new(
        PgOntologyStore::new(runtime_pool.clone())
            .with_command_pool(command_role_pool(&owner_pool).await),
        PgInstanceStore::new(runtime_pool.clone()),
        PgGovernanceStore::new(runtime_pool),
        Some(auth.verifier),
    ));

    let created = request_json(
        service.clone(),
        "POST",
        "/api/v1/ontology/object-types",
        &auth.token,
        None,
        draft("Initial title"),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);

    let get = request_json(
        service.clone(),
        "GET",
        &format!("/api/v1/ontology/object-types/{KEY}"),
        &auth.token,
        None,
        Value::Null,
    )
    .await;
    assert_eq!(get.status, StatusCode::OK, "{:?}", get.body);
    let first_etag = get
        .headers
        .get(header::ETAG)
        .expect("GET must return ETag")
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        first_etag.starts_with("\"ont-object-type-key:") && first_etag.ends_with(":r1\""),
        "GET returned a non-strong or unexpected validator: {first_etag}"
    );

    let winner = request_json(
        service.clone(),
        "PUT",
        &format!("/api/v1/ontology/object-types/{KEY}"),
        &auth.token,
        Some(&[first_etag.as_str()]),
        draft("Winning title"),
    )
    .await;
    assert_eq!(winner.status, StatusCode::CREATED, "{:?}", winner.body);
    let current_etag = winner
        .headers
        .get(header::ETAG)
        .expect("successful PUT must return the advanced ETag")
        .to_str()
        .unwrap()
        .to_owned();
    assert_ne!(current_etag, first_etag);
    assert!(current_etag.ends_with(":r2\""), "{current_etag}");

    let after_winner = stored_state(&owner_pool, org).await;
    assert_eq!(after_winner.title, "Winning title");
    assert_eq!(after_winner.object_type_rows, 1);
    assert_eq!(after_winner.key_revision, 2);
    assert_eq!(after_winner.stage_audits, 1);

    let loser = request_json(
        service.clone(),
        "PUT",
        &format!("/api/v1/ontology/object-types/{KEY}"),
        &auth.token,
        Some(&[first_etag.as_str()]),
        draft("Losing stale title"),
    )
    .await;
    assert_eq!(loser.status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(
        loser.headers.get(header::ETAG).unwrap().to_str().unwrap(),
        current_etag
    );
    assert_eq!(
        loser.headers.get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    assert_eq!(
        loser.body["error"]["current_key_write_revision"].as_i64(),
        Some(2)
    );
    assert_eq!(
        stored_state(&owner_pool, org).await,
        after_winner,
        "the stale loser must change no content, revision, row, or audit count"
    );

    let missing = request_json(
        service.clone(),
        "PUT",
        &format!("/api/v1/ontology/object-types/{KEY}"),
        &auth.token,
        None,
        draft("Missing precondition"),
    )
    .await;
    assert_eq!(missing.status, StatusCode::PRECONDITION_REQUIRED);

    for malformed in [
        vec![format!("W/{current_etag}")],
        vec![format!("{current_etag}, {current_etag}")],
        vec![current_etag.clone(), current_etag.clone()],
        vec!["not-an-etag".to_owned()],
    ] {
        let values: Vec<&str> = malformed.iter().map(String::as_str).collect();
        let rejected = request_json(
            service.clone(),
            "PUT",
            &format!("/api/v1/ontology/object-types/{KEY}"),
            &auth.token,
            Some(&values),
            draft("Malformed precondition"),
        )
        .await;
        assert_eq!(
            rejected.status,
            StatusCode::BAD_REQUEST,
            "validator {malformed:?} was not rejected: {:?}",
            rejected.body
        );
    }
    assert_eq!(stored_state(&owner_pool, org).await, after_winner);
}

fn draft(title: &str) -> Value {
    json!({
        "stable_key": KEY,
        "title": title,
        "backing_kind": "instance",
        "properties": [],
        "links": [],
        "actions": [],
        "analytics": []
    })
}

fn test_auth(user_id: UserId, org: OrgId) -> TestAuth {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let settings = JwtSettings {
        issuer: TEST_ISSUER.to_owned(),
        audience: TEST_AUDIENCE.to_owned(),
        access_token_ttl: Duration::minutes(15),
    };
    let verifier =
        JwtVerifier::from_es256_public_pem(settings.clone(), public_pem.as_bytes()).unwrap();
    let issuer =
        JwtIssuer::from_es256_pem(settings, private_pem.as_bytes(), public_pem.as_bytes()).unwrap();
    let token = issuer
        .issue_access_token(AccessTokenInput {
            subject: user_id,
            org_id: org,
            roles: vec!["SUPER_ADMIN".to_owned()],
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
        .unwrap();
    TestAuth { token, verifier }
}

async fn request_json(
    service: axum::Router,
    method: &str,
    uri: &str,
    token: &str,
    if_match: Option<&[&str]>,
    body: Value,
) -> HttpResponse {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    if body != Value::Null {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    if let Some(values) = if_match {
        for value in values {
            builder = builder.header(header::IF_MATCH, *value);
        }
    }
    let body = if body == Value::Null {
        Body::empty()
    } else {
        Body::from(serde_json::to_vec(&body).unwrap())
    };
    let response = service.oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    HttpResponse {
        status,
        headers,
        body,
    }
}

async fn stored_state(owner_pool: &PgPool, org: OrgId) -> StoredState {
    let title: String = sqlx::query_scalar(
        "SELECT title FROM ont_object_types WHERE org_id = $1 AND stable_key = $2",
    )
    .bind(*org.as_uuid())
    .bind(KEY)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    let object_type_rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ont_object_types WHERE org_id = $1 AND stable_key = $2",
    )
    .bind(*org.as_uuid())
    .bind(KEY)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    let key_revision: i64 = sqlx::query_scalar(
        "SELECT revision FROM ont_object_type_key_revisions WHERE org_id = $1 AND stable_key = $2",
    )
    .bind(*org.as_uuid())
    .bind(KEY)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    let stage_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND action = 'ontology.object_type.stage_revision'",
    )
    .bind(*org.as_uuid())
    .fetch_one(owner_pool)
    .await
    .unwrap();
    StoredState {
        title,
        object_type_rows,
        key_revision,
        stage_audits,
    }
}
