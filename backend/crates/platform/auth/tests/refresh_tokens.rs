#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_kernel_core::OrgId;
use mnt_platform_auth::{RefreshTokenStore, RefreshTokenUseError};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};

async fn seed_user(pool: &PgPool) -> uuid::Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind("Refresh User")
    .bind(Vec::<String>::from(["MECHANIC".to_owned()]))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = "../db/migrations")]
async fn refresh_token_reuse_revokes_the_whole_family(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = RefreshTokenStore;
    let now = OffsetDateTime::now_utc();
    let ttl = Duration::days(30);
    // Wide absolute cap so this reuse test is unaffected by the family TTL ceiling.
    let absolute_ttl = Duration::days(30);

    let first = store
        .issue_family(&pool, user_id, OrgId::knl(), now, ttl)
        .await
        .unwrap();
    let second = store
        .rotate(
            &pool,
            first.token.as_str(),
            now + Duration::minutes(1),
            ttl,
            absolute_ttl,
        )
        .await
        .unwrap();

    let reuse = store
        .rotate(
            &pool,
            first.token.as_str(),
            now + Duration::minutes(2),
            ttl,
            absolute_ttl,
        )
        .await
        .unwrap_err();
    assert_eq!(reuse, RefreshTokenUseError::ReuseDetected);

    let after_reuse = store
        .rotate(
            &pool,
            second.token.as_str(),
            now + Duration::minutes(3),
            ttl,
            absolute_ttl,
        )
        .await
        .unwrap_err();
    assert_eq!(after_reuse, RefreshTokenUseError::FamilyRevoked);

    let family = sqlx::query(
        "SELECT revoked_at, revoked_reason FROM auth_refresh_token_families WHERE id = $1",
    )
    .bind(first.family_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let revoked_at: Option<OffsetDateTime> = family.try_get("revoked_at").unwrap();
    let revoked_reason: Option<String> = family.try_get("revoked_reason").unwrap();
    assert!(revoked_at.is_some());
    assert_eq!(revoked_reason.as_deref(), Some("reuse_detected"));

    let token_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_refresh_tokens WHERE family_id = $1")
            .bind(first.family_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(token_rows, 2);

    let revoked_rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM auth_refresh_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL",
    )
    .bind(first.family_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(revoked_rows, 2);
}

/// A rotation past the family's absolute TTL (measured from creation) is rejected
/// and revokes the family, even when the presented token is otherwise valid,
/// unused, and not individually expired. This is the NIST AAL2 absolute
/// session-lifetime cap.
#[sqlx::test(migrations = "../db/migrations")]
async fn rotation_past_family_absolute_ttl_revokes_the_family(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = RefreshTokenStore;
    let now = OffsetDateTime::now_utc();
    // Per-token TTL is generous so the rejection can ONLY come from the absolute
    // family cap, not from individual-token expiry.
    let ttl = Duration::days(30);
    let absolute_ttl = Duration::hours(24);

    let first = store
        .issue_family(&pool, user_id, OrgId::knl(), now, ttl)
        .await
        .unwrap();

    // A rotation comfortably within the cap still succeeds.
    let second = store
        .rotate(
            &pool,
            first.token.as_str(),
            now + Duration::hours(1),
            ttl,
            absolute_ttl,
        )
        .await
        .unwrap();

    // One second past the absolute ceiling: rejected as FamilyRevoked.
    let expired = store
        .rotate(
            &pool,
            second.token.as_str(),
            now + absolute_ttl + Duration::seconds(1),
            ttl,
            absolute_ttl,
        )
        .await
        .unwrap_err();
    assert_eq!(expired, RefreshTokenUseError::FamilyRevoked);

    // The family is revoked with the absolute-TTL reason.
    let family = sqlx::query(
        "SELECT revoked_at, revoked_reason FROM auth_refresh_token_families WHERE id = $1",
    )
    .bind(first.family_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let revoked_at: Option<OffsetDateTime> = family.try_get("revoked_at").unwrap();
    let revoked_reason: Option<String> = family.try_get("revoked_reason").unwrap();
    assert!(revoked_at.is_some());
    assert_eq!(revoked_reason.as_deref(), Some("absolute_ttl_exceeded"));

    // Every token in the family is now revoked, so no sibling can rotate either.
    let live_tokens: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM auth_refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL",
    )
    .bind(first.family_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(live_tokens, 0);
}
