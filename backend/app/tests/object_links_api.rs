#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BE-OBJ object_links: HTTP contract round-trip + a RUNTIME-role RLS proof.
//!
//! The round-trip test drives the real router (create/list/delete, duplicate
//! rejection, unknown-kind rejection, audit emission). The isolation test runs
//! as the genuine non-owner `mnt_rt` role (NOBYPASSRLS, FORCE RLS) — NOT the
//! default `#[sqlx::test]` BYPASSRLS superuser, which would see every row and
//! green-light a broken tenant filter — to prove org B cannot see org A's link.

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{OrgId, UserId};
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
const OTHER_ORG: Uuid = Uuid::from_u128(0x0b1e_0b1e_0b1e_0b1e_0b1e_0b1e_0b1e_0b1e);

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn create_list_delete_roundtrip_and_audit_events(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let user_id = UserId::new();
    seed_user(&pool, user_id, "ADMIN").await;
    let token = issue_token(private_pem.as_bytes(), public_key_pem.as_bytes(), user_id);

    // Create: work_order wo-1 --authorized_by--> approval_run ar-1.
    let created = request(
        &pool,
        &public_key_pem,
        Request::builder()
            .method("POST")
            .uri("/api/v1/object-links")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({
                    "src_kind": "work_order",
                    "src_id": "wo-1",
                    "dst_kind": "approval_run",
                    "dst_id": "ar-1",
                    "link_type": "authorized_by"
                })
                .to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(created.0, StatusCode::OK, "create body: {}", created.1);
    let link_id = created.1["id"].as_str().unwrap().to_owned();

    // List by source end: one outgoing, no incoming.
    let src_list = request(
        &pool,
        &public_key_pem,
        get("/api/v1/object-links?kind=work_order&id=wo-1", &token),
    )
    .await;
    assert_eq!(src_list.0, StatusCode::OK);
    assert_eq!(src_list.1["outgoing"].as_array().unwrap().len(), 1);
    assert_eq!(src_list.1["incoming"].as_array().unwrap().len(), 0);

    // List by destination end: same link appears as incoming.
    let dst_list = request(
        &pool,
        &public_key_pem,
        get("/api/v1/object-links?kind=approval_run&id=ar-1", &token),
    )
    .await;
    assert_eq!(dst_list.1["incoming"].as_array().unwrap().len(), 1);
    assert_eq!(dst_list.1["outgoing"].as_array().unwrap().len(), 0);
    assert_eq!(dst_list.1["incoming"][0]["id"], link_id);

    // Duplicate is rejected (409), not silently doubled.
    let dup = request(
        &pool,
        &public_key_pem,
        Request::builder()
            .method("POST")
            .uri("/api/v1/object-links")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({
                    "src_kind": "work_order", "src_id": "wo-1",
                    "dst_kind": "approval_run", "dst_id": "ar-1",
                    "link_type": "authorized_by"
                })
                .to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(dup.0, StatusCode::CONFLICT);

    // Unknown kind is rejected (422).
    let unknown = request(
        &pool,
        &public_key_pem,
        Request::builder()
            .method("POST")
            .uri("/api/v1/object-links")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({
                    "src_kind": "work_order", "src_id": "wo-1",
                    "dst_kind": "not_a_real_kind", "dst_id": "x-1",
                    "link_type": "relates_to"
                })
                .to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(unknown.0, StatusCode::UNPROCESSABLE_ENTITY);

    // Delete: 204, then the object has no links.
    let del = request(
        &pool,
        &public_key_pem,
        Request::builder()
            .method("DELETE")
            .uri(format!("/api/v1/object-links/{link_id}"))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(del.0, StatusCode::NO_CONTENT);

    let after = request(
        &pool,
        &public_key_pem,
        get("/api/v1/object-links?kind=work_order&id=wo-1", &token),
    )
    .await;
    assert_eq!(after.1["outgoing"].as_array().unwrap().len(), 0);

    // Deleting an unknown id is 404 (deny-by-omission).
    let missing = request(
        &pool,
        &public_key_pem,
        Request::builder()
            .method("DELETE")
            .uri(format!("/api/v1/object-links/{}", Uuid::new_v4()))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(missing.0, StatusCode::NOT_FOUND);

    // Audit: create + delete each emitted exactly one event; the delete carries
    // the removed edge as its before-snapshot.
    let create_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = 'object_link.create'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(create_count, 1);
    let delete_before: Option<Value> = sqlx::query_scalar(
        "SELECT before_snap FROM audit_events WHERE action = 'object_link.delete'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let before = delete_before.expect("delete audit has a before-snapshot");
    assert_eq!(before["link_type"], "authorized_by");
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn rls_cross_org_isolation_as_runtime_role(owner_pool: PgPool) {
    let knl = *OrgId::knl().as_uuid();
    seed_org(&owner_pool, OTHER_ORG, "Other").await;

    // Owner (BYPASSRLS) plants an org-A (KNL) link directly.
    let link_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO object_links (id, org_id, src_kind, src_id, dst_kind, dst_id, link_type)
        VALUES ($1, $2, 'work_order', 'wo-1', 'equipment', 'eq-1', 'uses')
        "#,
    )
    .bind(link_id)
    .bind(knl)
    .execute(&owner_pool)
    .await
    .unwrap();

    let rt_pool = runtime_role_pool(&owner_pool).await;

    // As mnt_rt under org B's GUC: A's link is invisible (FORCE RLS).
    let seen_by_other = count_links_scoped(&rt_pool, OTHER_ORG).await;
    assert_eq!(seen_by_other, 0, "org B must not see org A's link");

    // As mnt_rt under org A's GUC: the link is visible.
    let seen_by_owner = count_links_scoped(&rt_pool, knl).await;
    assert_eq!(seen_by_owner, 1, "org A sees its own link");
}

/// B2: a link is an audited edge, so deletion is restricted to its creator or a
/// UserManage-tier admin — NOT open to every Login member the way create/list
/// are. A non-creator, non-manager member gets 403; the creator can still
/// delete (proving the guard denies the outsider, not the owner).
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn delete_link_denied_for_non_creator_non_manager(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();

    // Creator (ADMIN, holds UserManage) plants a link; created_by = creator.
    let creator = UserId::new();
    seed_user(&pool, creator, "ADMIN").await;
    let creator_token = issue_token(private_pem.as_bytes(), public_key_pem.as_bytes(), creator);
    let created = request(
        &pool,
        &public_key_pem,
        Request::builder()
            .method("POST")
            .uri("/api/v1/object-links")
            .header(header::AUTHORIZATION, format!("Bearer {creator_token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({
                    "src_kind": "work_order", "src_id": "wo-1",
                    "dst_kind": "equipment", "dst_id": "eq-1",
                    "link_type": "uses"
                })
                .to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(created.0, StatusCode::OK, "create body: {}", created.1);
    let link_id = created.1["id"].as_str().unwrap().to_owned();

    // A different MEMBER: holds Login (can create/list) but not UserManage, and
    // is not the creator -> delete is 403, not a silent success.
    let outsider = UserId::new();
    seed_user(&pool, outsider, "MEMBER").await;
    let outsider_token = issue_token_with_roles(
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        outsider,
        vec!["MEMBER".to_owned()],
    );
    let denied = request(
        &pool,
        &public_key_pem,
        Request::builder()
            .method("DELETE")
            .uri(format!("/api/v1/object-links/{link_id}"))
            .header(header::AUTHORIZATION, format!("Bearer {outsider_token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(
        denied.0,
        StatusCode::FORBIDDEN,
        "non-creator non-manager must be denied delete: {}",
        denied.1
    );

    // The link still exists: its creator can delete it -> 204.
    let by_creator = request(
        &pool,
        &public_key_pem,
        Request::builder()
            .method("DELETE")
            .uri(format!("/api/v1/object-links/{link_id}"))
            .header(header::AUTHORIZATION, format!("Bearer {creator_token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(by_creator.0, StatusCode::NO_CONTENT);
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

fn get(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

async fn request(pool: &PgPool, public_key_pem: &str, req: Request<Body>) -> (StatusCode, Value) {
    let service = build_router(app_state(pool.clone(), public_key_pem.to_owned()).unwrap());
    let response = service.oneshot(req).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap_or(Value::Null)
    };
    (status, json)
}

async fn count_links_scoped(rt_pool: &PgPool, org: Uuid) -> i64 {
    mnt_platform_db::with_org_conn::<_, i64, mnt_platform_db::DbError>(
        rt_pool,
        OrgId::from_uuid(org),
        move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar("SELECT COUNT(*) FROM object_links")
                    .fetch_one(tx.as_mut())
                    .await?)
            })
        },
    )
    .await
    .unwrap()
}

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    for grant in [
        "GRANT SELECT, INSERT, DELETE ON object_links TO mnt_rt",
        "GRANT SELECT ON object_types TO mnt_rt",
    ] {
        sqlx::query(grant).execute(owner_pool).await.unwrap();
    }
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

async fn seed_org(owner_pool: &PgPool, org: Uuid, tag: &str) {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind(format!("org-{}", tag.to_lowercase()))
    .bind(format!("Org {tag}"))
    .execute(owner_pool)
    .await
    .unwrap();
}

async fn seed_user(pool: &PgPool, user_id: UserId, role: &str) {
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("User {role} {}", Uuid::new_v4()))
        .bind(Vec::from([role]))
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

fn issue_token(private_key_pem: &[u8], public_key_pem: &[u8], user_id: UserId) -> String {
    issue_token_with_roles(
        private_key_pem,
        public_key_pem,
        user_id,
        vec!["ADMIN".to_owned()],
    )
}

fn issue_token_with_roles(
    private_key_pem: &[u8],
    public_key_pem: &[u8],
    user_id: UserId,
    roles: Vec<String>,
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
            roles,
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
