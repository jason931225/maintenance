//! GUARDED tenant hard-removal (`DELETE /api/platform/orgs/{id}`) tests.
//!
//! Proves the enterprise invariants of the removal:
//!   (a) a platform-super-admin can remove an EMPTY tenant — its shell rows are
//!       gone and the org is gone, and its immutable audit trail SURVIVES,
//!       re-homed to the platform sentinel;
//!   (b) removal of a tenant WITH real data (equipment) is REFUSED with 409 and
//!       nothing is deleted (the transaction rolled back);
//!   (c) a non-platform (tenant) principal is rejected with 403;
//!   (d) cross-tenant: removing org A does not touch org B's rows;
//!   (e) audit-immutability is intact — a direct `mnt_rt` UPDATE on audit_events
//!       still raises (the removal's re-home is the ONLY sanctioned path).
//!
//! The app router runs against a pool whose connections `SET ROLE mnt_rt`, so the
//! removal exercises the production runtime role under FORCE RLS — a superuser
//! pool would mask whether the SECURITY DEFINER escape actually works for `mnt_rt`
//! (per the project's rls-verify-as-runtime-role discipline).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_kernel_core::{OrgId, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use mnt_platform_provisioning::PlatformProvisioner;
use mnt_platform_rest::{PLATFORM_ORGS_PATH, PlatformRestState, router};
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

struct Harness {
    private_pem: String,
    public_pem: String,
    /// The runtime-role pool the app router uses (every connection is `mnt_rt`).
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

    fn service(&self) -> Router {
        let verifier = JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            self.public_pem.as_bytes(),
        )
        .unwrap();
        router(PlatformRestState::new(
            self.rt_pool.clone(),
            Some(verifier),
            PlatformProvisioner::new(Duration::minutes(15)),
        ))
    }

    fn token(&self, user_id: UserId, org_id: OrgId, platform: bool) -> String {
        let issuer = JwtIssuer::from_es256_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            self.private_pem.as_bytes(),
            self.public_pem.as_bytes(),
        )
        .unwrap();
        issuer
            .issue_access_token(AccessTokenInput {
                subject: user_id,
                org_id,
                roles: vec!["SUPER_ADMIN".to_owned()],
                branches: vec![],
                platform,
                view_as: false,
                read_only: false,
                display_name: None,
                issued_at: OffsetDateTime::now_utc(),
            })
            .unwrap()
    }
}

/// A pool whose every connection runs `SET ROLE mnt_rt`, so the app router's
/// statements execute as the production runtime role (NOSUPERUSER, NOBYPASSRLS)
/// under FORCE RLS — the same pattern the identity/auth runtime-RLS tests use.
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

/// Onboard a tenant THROUGH the platform API (so it gets the exact onboarding
/// shell: org + one SUPER_ADMIN + a bootstrap OTP + the create audit row).
/// Returns the new org id.
async fn onboard(service: &Router, platform_token: &str, slug: &str) -> Uuid {
    let body = format!(r#"{{"slug":"{slug}","name":"Tenant {slug}"}}"#);
    let response = service
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(PLATFORM_ORGS_PATH)
                .header(header::AUTHORIZATION, format!("Bearer {platform_token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    Uuid::parse_str(json["org"]["id"].as_str().unwrap()).unwrap()
}

async fn delete_org(service: &Router, token: &str, org_id: Uuid) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("DELETE")
        .uri(format!("/api/platform/orgs/{org_id}"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
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

/// Insert the platform-admin user under the sentinel org so the audit-event actor
/// FK is satisfiable. Runs as the owner pool (bypasses RLS for setup).
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

/// Count this org's rows in a tenant table, as the OWNER with RLS off (so the
/// assertion sees the truth regardless of any armed GUC). `table` is always a
/// hardcoded test literal (never request-derived), so `AssertSqlSafe` is sound.
async fn count_in_org(owner_pool: &PgPool, table: &str, org_id: Uuid) -> i64 {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let sql = sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table} WHERE org_id = $1"));
    let count: i64 = sqlx::query_scalar(sql)
        .bind(org_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    count
}

/// Whether an organizations row still exists (owner, RLS off).
async fn org_exists(owner_pool: &PgPool, org_id: Uuid) -> bool {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM organizations WHERE id = $1)")
            .bind(org_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    exists
}

/// Seed real registry data (a branch + a registry_customers row) for `org_id` so
/// the tenant counts as "in real use" and removal must be refused. A customer is
/// the minimal guarded "real data" row and avoids registry_equipment's many
/// NOT NULL / CHECK columns. Runs as the owner with RLS off (so the WITH CHECK +
/// org-immutability constraints accept the inserts).
async fn seed_real_data(owner_pool: &PgPool, org_id: Uuid) {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("Region {}", &org_id.simple().to_string()[..8]))
            .bind(org_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let branch_id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind("Main")
    .bind(org_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3)")
        .bind(branch_id)
        .bind("Acme Logistics")
        .bind(org_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

// ---------------------------------------------------------------------------
// (a) Empty tenant: removed; shell + org gone; audit trail survives re-homed.
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn platform_admin_removes_empty_tenant_and_preserves_audit(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let admin = seed_platform_admin(&owner_pool).await;
    let platform_token = harness.token(admin, OrgId::platform(), true);
    let service = harness.service();

    let org_id = onboard(&service, &platform_token, "acme").await;

    // The onboarding shell + the create audit row exist.
    assert_eq!(count_in_org(&owner_pool, "users", org_id).await, 1);
    assert_eq!(
        count_in_org(&owner_pool, "auth_bootstrap_credentials", org_id).await,
        1
    );
    let audit_before = count_in_org(&owner_pool, "audit_events", org_id).await;
    assert!(audit_before >= 1, "onboarding writes an audit row");

    let (status, body) = delete_org(&service, &platform_token, org_id).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");

    // The org and every shell table are gone.
    assert!(
        !org_exists(&owner_pool, org_id).await,
        "org must be deleted"
    );
    for table in [
        "users",
        "user_branches",
        "branches",
        "regions",
        "auth_bootstrap_credentials",
    ] {
        assert_eq!(
            count_in_org(&owner_pool, table, org_id).await,
            0,
            "{table} rows must be gone after removal"
        );
    }

    // The tenant's audit rows are NOT destroyed — re-homed to the platform
    // sentinel (so the immutable trail survives the tenant).
    assert_eq!(
        count_in_org(&owner_pool, "audit_events", org_id).await,
        0,
        "no audit rows should still carry the removed org id"
    );
    let rehomed = count_in_org(&owner_pool, "audit_events", *OrgId::platform().as_uuid()).await;
    assert!(
        rehomed >= audit_before,
        "the tenant's audit rows must survive re-homed to the sentinel"
    );

    // The removal itself is audited as platform.tenant.remove by the operator.
    let remove_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'platform.tenant.remove' AND actor = $1",
    )
    .bind(*admin.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(remove_audits, 1, "removal must be audited exactly once");
}

// ---------------------------------------------------------------------------
// (b) Tenant WITH real data: refused 409; NOTHING deleted (tx rolled back).
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn removal_of_tenant_with_data_is_refused_and_rolls_back(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let admin = seed_platform_admin(&owner_pool).await;
    let platform_token = harness.token(admin, OrgId::platform(), true);
    let service = harness.service();

    let org_id = onboard(&service, &platform_token, "inuse").await;
    seed_real_data(&owner_pool, org_id).await;

    let (status, body) = delete_org(&service, &platform_token, org_id).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body:?}");
    assert_eq!(
        body["error"]["code"], "tenant_has_data",
        "the 409 must carry the archive-instead guard code: {body:?}"
    );

    // Nothing was removed: org, shell, and the real data all remain.
    assert!(
        org_exists(&owner_pool, org_id).await,
        "org must still exist"
    );
    assert_eq!(count_in_org(&owner_pool, "users", org_id).await, 1);
    assert_eq!(
        count_in_org(&owner_pool, "registry_customers", org_id).await,
        1
    );
    // No removal audit row was written.
    let remove_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'platform.tenant.remove'",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(remove_audits, 0, "a refused removal must not be audited");
}

// ---------------------------------------------------------------------------
// (c) A non-platform (tenant) principal is rejected with 403.
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn tenant_token_cannot_remove_a_tenant(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let admin = seed_platform_admin(&owner_pool).await;
    let platform_token = harness.token(admin, OrgId::platform(), true);
    let service = harness.service();

    let org_id = onboard(&service, &platform_token, "victim").await;

    // A normal TENANT token (platform = false).
    let tenant_token = harness.token(UserId::new(), OrgId::knl(), false);
    let (status, _body) = delete_org(&service, &tenant_token, org_id).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a tenant token must never reach DELETE /api/platform/orgs/{{id}}"
    );

    // The tenant is untouched.
    assert!(
        org_exists(&owner_pool, org_id).await,
        "org must still exist"
    );
}

// ---------------------------------------------------------------------------
// (d) Cross-tenant: removing org A leaves org B's rows intact.
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn removing_one_tenant_does_not_touch_another(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let admin = seed_platform_admin(&owner_pool).await;
    let platform_token = harness.token(admin, OrgId::platform(), true);
    let service = harness.service();

    let org_a = onboard(&service, &platform_token, "alpha").await;
    let org_b = onboard(&service, &platform_token, "beta").await;

    let (status, body) = delete_org(&service, &platform_token, org_a).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");

    assert!(!org_exists(&owner_pool, org_a).await, "org A must be gone");
    assert!(org_exists(&owner_pool, org_b).await, "org B must survive");
    assert_eq!(
        count_in_org(&owner_pool, "users", org_b).await,
        1,
        "org B's shell user must be untouched"
    );
    assert_eq!(
        count_in_org(&owner_pool, "auth_bootstrap_credentials", org_b).await,
        1,
        "org B's bootstrap credential must be untouched"
    );
}

// ---------------------------------------------------------------------------
// (e) Audit-immutability is intact: a direct mnt_rt UPDATE still raises (the
// removal re-home is the ONLY path that may release audit references).
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn direct_runtime_update_on_audit_events_is_still_rejected(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let admin = seed_platform_admin(&owner_pool).await;
    let platform_token = harness.token(admin, OrgId::platform(), true);
    let service = harness.service();

    let org_id = onboard(&service, &platform_token, "audited").await;

    // As mnt_rt, with the org armed, try to re-home an audit row WITHOUT the
    // sanctioned DEFINER GUC. The append-only trigger must reject it.
    let mut tx = harness.rt_pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let result = sqlx::query("UPDATE audit_events SET actor = NULL WHERE org_id = $1")
        .bind(org_id)
        .execute(&mut *tx)
        .await;
    assert!(
        result.is_err(),
        "a direct mnt_rt UPDATE on audit_events must be rejected by the append-only trigger"
    );
    let _ = tx.rollback().await;
}
