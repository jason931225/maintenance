//! PLATFORM "view as" (read-only impersonation) tests.
//!
//! Proves the security-critical invariants of the troubleshooting impersonation:
//!   (a) a view_as token READS the TARGET tenant's rows — RLS is armed to the
//!       acting org and a role-appropriate read returns that tenant's data;
//!   (b) a view_as token CANNOT mutate — POST/PATCH/PUT/DELETE to ANY tenant route
//!       returns 403 `view_as_read_only`, blocked by the blanket method gate
//!       BEFORE any handler runs;
//!   (c) a NON-platform (tenant) token cannot START — 403;
//!   (d) cross-tenant isolation — a view_as token pinned to org A cannot read org
//!       B's rows (RLS makes them invisible);
//!   (e) START and EXIT write the audit events with the REAL operator id;
//!   (f) the minted token's TTL is short (≤30 min).
//!
//! Everything DB-backed runs against a pool whose connections `SET ROLE mnt_rt`,
//! so RLS is exercised as the production runtime role (NOBYPASSRLS, FORCE RLS) —
//! a superuser pool would mask a broken read path (rls-verify-as-runtime-role).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use http::{Request, StatusCode, header};
use mnt_kernel_core::{OrgId, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_db::with_org_conn;
use mnt_platform_provisioning::PlatformProvisioner;
use mnt_platform_request_context::{current_org, with_request_context};
use mnt_platform_rest::{
    PLATFORM_VIEW_AS_EXIT_PATH, PLATFORM_VIEW_AS_START_PATH, PlatformRestState,
    VIEW_AS_READ_ONLY_CODE, router, with_view_as_read_only_gate,
};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";

/// A tenant probe route the read-only gate is exercised against. The GET handler
/// counts the users RLS lets the request see (so a view_as token armed to the
/// acting org reads exactly that tenant), and the mutating handlers exist only to
/// be PROVEN unreachable under a view_as token.
const PROBE_USERS_PATH: &str = "/api/v1/view-as-probe/users";

struct Harness {
    private_pem: String,
    public_pem: String,
    /// The runtime-role pool every router uses (each connection is `mnt_rt`).
    rt_pool: PgPool,
}

impl Harness {
    async fn new(owner_pool: &PgPool) -> Self {
        let signing_key = SigningKey::random(&mut OsRng);
        let private_pem = signing_key
            .to_pkcs8_pem(LineEnding::LF)
            .unwrap()
            .to_string();
        let public_pem = signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        Self {
            private_pem,
            public_pem,
            rt_pool: runtime_role_pool(owner_pool).await,
        }
    }

    fn jwt_settings(&self) -> JwtSettings {
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        }
    }

    fn verifier(&self) -> JwtVerifier {
        JwtVerifier::from_es256_public_pem(self.jwt_settings(), self.public_pem.as_bytes()).unwrap()
    }

    fn issuer(&self) -> JwtIssuer {
        JwtIssuer::from_es256_pem(
            self.jwt_settings(),
            self.private_pem.as_bytes(),
            self.public_pem.as_bytes(),
        )
        .unwrap()
    }

    /// The PLATFORM router (START + EXIT + orgs), with the view-as issuer wired so
    /// START can mint impersonation tokens.
    fn platform_service(&self) -> Router {
        router(
            PlatformRestState::new(
                self.rt_pool.clone(),
                Some(self.verifier()),
                PlatformProvisioner::new(Duration::minutes(15)),
            )
            .with_view_as_issuer(Some(self.issuer())),
        )
    }

    /// A TENANT router that mirrors production: the per-request tenant org
    /// middleware arms `app.current_org`, and the blanket view-as read-only gate
    /// wraps the whole thing (exactly as the app composition root applies it).
    fn tenant_service(&self) -> Router {
        let inner = Router::new()
            .route(
                PROBE_USERS_PATH,
                get(probe_count_users)
                    .post(probe_mutation)
                    .patch(probe_mutation)
                    .put(probe_mutation)
                    .delete(probe_mutation),
            )
            .with_state(self.rt_pool.clone());
        let inner = with_request_context(inner, Some(self.verifier()), self.rt_pool.clone());
        with_view_as_read_only_gate(inner, Some(self.verifier()))
    }

    /// Mint an ordinary (non-view_as) token for `user`/`org`.
    fn token(&self, user_id: UserId, org_id: OrgId, platform: bool, role: &str) -> String {
        self.issuer()
            .issue_access_token(AccessTokenInput {
                subject: user_id,
                org_id,
                roles: vec![role.to_owned()],
                branches: vec![],
                platform,
                view_as: false,
                read_only: false,
                issued_at: OffsetDateTime::now_utc(),
            })
            .unwrap()
    }
}

/// A pool whose every connection runs `SET ROLE mnt_rt` (NOBYPASSRLS, FORCE RLS).
async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
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

// ---------------------------------------------------------------------------
// Probe handlers (tenant tier)
// ---------------------------------------------------------------------------

/// GET probe: count the users RLS lets THIS request see. A view_as token armed to
/// the acting org sees exactly that tenant's users; a different org's users are
/// invisible. Proves RLS scoping + cross-tenant isolation through the real
/// tenant middleware.
async fn probe_count_users(State(pool): State<PgPool>) -> impl IntoResponse {
    let org = current_org().expect("tenant middleware must have armed the org");
    let count = with_org_conn::<_, i64, mnt_platform_db::DbError>(&pool, org, |tx| {
        Box::pin(async move {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
                .fetch_one(tx.as_mut())
                .await
                .map_err(mnt_platform_db::DbError::Sqlx)
        })
    })
    .await
    .unwrap_or(-1);
    Json(serde_json::json!({ "count": count, "org": org.as_uuid().to_string() })).into_response()
}

/// A mutation handler that MUST be unreachable under a view_as token. If the
/// read-only gate ever failed open, this would return 200 and the test would
/// catch it.
async fn probe_mutation() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "mutated": true }))).into_response()
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async fn request(
    service: &Router,
    method: &str,
    path: &str,
    token: &str,
    body: Option<String>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    if body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    let request = builder
        .body(body.map_or(Body::empty(), Body::from))
        .unwrap();
    let response = service.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    (status, json)
}

/// Call START on the platform service and return (status, body).
async fn start_view_as(
    platform: &Router,
    token: &str,
    org_id: Uuid,
    role: &str,
) -> (StatusCode, Value) {
    let body = format!(r#"{{"org_id":"{org_id}","role":"{role}"}}"#);
    request(
        platform,
        "POST",
        PLATFORM_VIEW_AS_START_PATH,
        token,
        Some(body),
    )
    .await
}

// ---------------------------------------------------------------------------
// Seeding (owner pool, RLS off)
// ---------------------------------------------------------------------------

/// Seed the platform sentinel org + a platform-admin user (the operator). The
/// audit actor FK references this user.
async fn seed_platform_admin(owner_pool: &PgPool) -> UserId {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name, status) VALUES ($1, 'platform', 'Platform', 'ARCHIVED') ON CONFLICT (id) DO NOTHING",
    )
    .bind(*OrgId::platform().as_uuid())
    .execute(owner_pool)
    .await
    .unwrap();
    let id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*id.as_uuid())
        .bind("Platform Admin")
        .bind(vec!["SUPER_ADMIN".to_owned()])
        .bind(*OrgId::platform().as_uuid())
        .execute(owner_pool)
        .await
        .unwrap();
    id
}

/// Seed an ACTIVE tenant org with `user_count` users, returning its id. Owner
/// pool with RLS off so the WITH CHECK + org constraints accept the inserts.
async fn seed_tenant(owner_pool: &PgPool, slug: &str, user_count: usize) -> Uuid {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let org_id: Uuid = sqlx::query_scalar(
        "INSERT INTO organizations (slug, name, status) VALUES ($1, $2, 'ACTIVE') RETURNING id",
    )
    .bind(slug)
    .bind(format!("Tenant {slug}"))
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    for i in 0..user_count {
        sqlx::query("INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3)")
            .bind(format!("User {i}"))
            .bind(vec!["MECHANIC".to_owned()])
            .bind(org_id)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    org_id
}

/// Set a tenant's status (e.g. to SUSPENDED) via the owner pool, RLS off.
async fn set_org_status(owner_pool: &PgPool, org_id: Uuid, status: &str) {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE organizations SET status = $2 WHERE id = $1")
        .bind(org_id)
        .bind(status)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

/// Count audit rows for one action AND one actor (owner pool, RLS off).
async fn audit_count(owner_pool: &PgPool, action: &str, actor: UserId) -> i64 {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = $1 AND actor = $2")
            .bind(action)
            .bind(*actor.as_uuid())
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    count
}

// ===========================================================================
// (c) A non-platform token cannot START — 403.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn tenant_token_cannot_start_view_as(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let _ = seed_platform_admin(&owner_pool).await;
    let target = seed_tenant(&owner_pool, "acme", 3).await;
    let platform = harness.platform_service();

    // A TENANT token (platform = false) must be rejected by the platform extractor.
    let tenant_user = UserId::new();
    let tenant_token = harness.token(tenant_user, OrgId::from_uuid(target), false, "SUPER_ADMIN");
    let (status, _body) = start_view_as(&platform, &tenant_token, target, "ADMIN").await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a tenant token must not be able to START view-as",
    );
}

// ===========================================================================
// (a)+(e)+(f) A platform operator STARTs; the token is a short-lived read-only
// view_as token pinned to the target org/role; START is audited with the real
// operator id.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn start_mints_short_lived_read_only_token_and_audits(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let operator = seed_platform_admin(&owner_pool).await;
    let target = seed_tenant(&owner_pool, "acme", 4).await;
    let platform = harness.platform_service();
    let platform_token = harness.token(operator, OrgId::platform(), true, "SUPER_ADMIN");

    let (status, body) = start_view_as(&platform, &platform_token, target, "ADMIN").await;
    assert_eq!(status, StatusCode::OK, "{body:?}");

    let access_token = body["access_token"].as_str().unwrap();
    assert_eq!(body["acting_org_id"].as_str().unwrap(), target.to_string());
    assert_eq!(body["acting_role"].as_str().unwrap(), "ADMIN");

    // The token is a TENANT token (platform false) pinned to the target org/role
    // with the read-only flags, and its TTL is short (≤30 min). Verify it with the
    // real verifier (which also proves the START path signed a valid token).
    let claims = harness
        .verifier()
        .verify_access_token(access_token)
        .unwrap();
    assert!(
        !claims.platform,
        "view_as token must NOT be a platform token"
    );
    assert!(claims.view_as, "view_as flag must be set");
    assert!(claims.read_only, "read_only flag must be set");
    assert_eq!(claims.org, target.to_string());
    assert_eq!(claims.roles, vec!["ADMIN".to_owned()]);
    // sub is the REAL operator id, never spoofed from the body.
    assert_eq!(claims.sub, operator.as_uuid().to_string());
    assert!(
        claims.exp - claims.iat <= 30 * 60 && claims.exp - claims.iat > 0,
        "view_as token TTL must be a short positive window (≤30m), got {}s",
        claims.exp - claims.iat,
    );

    // START is audited with the real operator id and org_id = NULL (platform tier).
    assert_eq!(
        audit_count(&owner_pool, "platform.view_as.start", operator).await,
        1,
        "START must write exactly one audit row with the operator actor",
    );
}

// ===========================================================================
// (a) The view_as token READS the target tenant's rows (RLS armed to acting org).
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn view_as_token_reads_target_tenant_rows(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let operator = seed_platform_admin(&owner_pool).await;
    let target = seed_tenant(&owner_pool, "acme", 5).await;
    let _other = seed_tenant(&owner_pool, "globex", 9).await;
    let platform = harness.platform_service();
    let tenant = harness.tenant_service();
    let platform_token = harness.token(operator, OrgId::platform(), true, "SUPER_ADMIN");

    let (_s, body) = start_view_as(&platform, &platform_token, target, "ADMIN").await;
    let view_as_token = body["access_token"].as_str().unwrap();

    // A GET with the view_as token reads EXACTLY the target tenant's users (5),
    // not the other tenant's (9) — RLS is armed to the acting org.
    let (status, read) = request(&tenant, "GET", PROBE_USERS_PATH, view_as_token, None).await;
    assert_eq!(status, StatusCode::OK, "{read:?}");
    assert_eq!(
        read["count"].as_i64().unwrap(),
        5,
        "must see the target tenant's 5 users"
    );
    assert_eq!(read["org"].as_str().unwrap(), target.to_string());
}

// ===========================================================================
// (b) The view_as token CANNOT mutate: every non-GET/HEAD method → 403
// view_as_read_only, BEFORE any handler runs.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn view_as_token_cannot_mutate_any_method(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let operator = seed_platform_admin(&owner_pool).await;
    let target = seed_tenant(&owner_pool, "acme", 2).await;
    let platform = harness.platform_service();
    let tenant = harness.tenant_service();
    let platform_token = harness.token(operator, OrgId::platform(), true, "SUPER_ADMIN");

    let (_s, body) = start_view_as(&platform, &platform_token, target, "SUPER_ADMIN").await;
    let view_as_token = body["access_token"].as_str().unwrap();

    // Every mutating method is blocked by the blanket gate with 403 + the code.
    for method in ["POST", "PATCH", "PUT", "DELETE"] {
        let payload = (method != "DELETE").then(|| "{}".to_owned());
        let (status, resp) =
            request(&tenant, method, PROBE_USERS_PATH, view_as_token, payload).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "{method} under a view_as token must be 403, got {status}: {resp:?}",
        );
        assert_eq!(
            resp["error"]["code"].as_str().unwrap(),
            VIEW_AS_READ_ONLY_CODE,
            "{method} must be rejected with the read-only code",
        );
        assert_ne!(
            resp["mutated"],
            Value::Bool(true),
            "the mutation handler must NEVER run under a view_as token ({method})",
        );
    }

    // A GET with the SAME token still works — the gate blocks only unsafe methods.
    let (status, _read) = request(&tenant, "GET", PROBE_USERS_PATH, view_as_token, None).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "GET must still be allowed under view_as"
    );
}

// ===========================================================================
// An ORDINARY tenant token (NOT view_as) can still mutate the probe route — the
// gate must not block normal traffic.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn ordinary_tenant_token_can_still_mutate(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let _operator = seed_platform_admin(&owner_pool).await;
    let target = seed_tenant(&owner_pool, "acme", 1).await;
    let tenant = harness.tenant_service();

    // An ordinary SUPER_ADMIN tenant token (view_as = false) passes the gate.
    let user = UserId::new();
    let normal = harness.token(user, OrgId::from_uuid(target), false, "SUPER_ADMIN");
    let (status, resp) = request(
        &tenant,
        "POST",
        PROBE_USERS_PATH,
        &normal,
        Some("{}".to_owned()),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "an ordinary tenant token must NOT be blocked by the view-as gate: {resp:?}",
    );
    assert_eq!(resp["mutated"], Value::Bool(true));
}

// ===========================================================================
// (d) Cross-tenant isolation: a view_as token pinned to org A cannot read org B.
// The token's org claim arms RLS to A; B's rows are invisible.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn view_as_token_cannot_read_a_different_org(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let operator = seed_platform_admin(&owner_pool).await;
    let org_a = seed_tenant(&owner_pool, "acme", 3).await;
    let org_b = seed_tenant(&owner_pool, "globex", 11).await;
    let platform = harness.platform_service();
    let tenant = harness.tenant_service();
    let platform_token = harness.token(operator, OrgId::platform(), true, "SUPER_ADMIN");

    // Start a view_as session pinned to org A.
    let (_s, body) = start_view_as(&platform, &platform_token, org_a, "ADMIN").await;
    let view_as_token = body["access_token"].as_str().unwrap();

    // The probe reads under the token's armed org (A) only: it sees A's 3 users,
    // and there is NO path for this token to read B's 11 — the org is baked into
    // the verified token, not request-controlled.
    let (status, read) = request(&tenant, "GET", PROBE_USERS_PATH, view_as_token, None).await;
    assert_eq!(status, StatusCode::OK, "{read:?}");
    assert_eq!(
        read["count"].as_i64().unwrap(),
        3,
        "sees ONLY org A's users"
    );
    assert_eq!(read["org"].as_str().unwrap(), org_a.to_string());
    assert_ne!(
        read["org"].as_str().unwrap(),
        org_b.to_string(),
        "the token can never be armed to org B",
    );
}

// ===========================================================================
// START refuses a non-ACTIVE tenant (409) — impersonation is scoped to live
// tenants.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn start_refuses_suspended_tenant(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let operator = seed_platform_admin(&owner_pool).await;
    let target = seed_tenant(&owner_pool, "acme", 2).await;
    set_org_status(&owner_pool, target, "SUSPENDED").await;
    let platform = harness.platform_service();
    let platform_token = harness.token(operator, OrgId::platform(), true, "SUPER_ADMIN");

    let (status, _body) = start_view_as(&platform, &platform_token, target, "ADMIN").await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "view-as must refuse a suspended tenant with 409",
    );
}

// ===========================================================================
// START rejects an unknown role code (422).
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn start_rejects_unknown_role(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let operator = seed_platform_admin(&owner_pool).await;
    let target = seed_tenant(&owner_pool, "acme", 1).await;
    let platform = harness.platform_service();
    let platform_token = harness.token(operator, OrgId::platform(), true, "SUPER_ADMIN");

    let (status, _body) = start_view_as(&platform, &platform_token, target, "WIZARD").await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "an unknown role code must be rejected 422",
    );
}

// ===========================================================================
// (e) EXIT is platform-gated and audits `platform.view_as.stop` with the real
// operator id; a tenant token cannot EXIT.
// ===========================================================================
#[sqlx::test(migrations = "../db/migrations")]
async fn exit_audits_stop_with_operator_and_rejects_tenant_token(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let operator = seed_platform_admin(&owner_pool).await;
    let target = seed_tenant(&owner_pool, "acme", 1).await;
    let platform = harness.platform_service();
    let platform_token = harness.token(operator, OrgId::platform(), true, "SUPER_ADMIN");

    // EXIT with the platform token succeeds and audits the stop.
    let (status, _body) = request(
        &platform,
        "POST",
        PLATFORM_VIEW_AS_EXIT_PATH,
        &platform_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        audit_count(&owner_pool, "platform.view_as.stop", operator).await,
        1,
        "EXIT must write exactly one stop audit row with the operator actor",
    );

    // A TENANT token cannot EXIT (platform extractor → 403).
    let tenant_user = UserId::new();
    let tenant_token = harness.token(tenant_user, OrgId::from_uuid(target), false, "SUPER_ADMIN");
    let (status, _body) = request(
        &platform,
        "POST",
        PLATFORM_VIEW_AS_EXIT_PATH,
        &tenant_token,
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a tenant token cannot EXIT view-as"
    );
}
