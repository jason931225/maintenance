use mnt_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use mnt_platform_db::with_audit;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::AuthError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshToken(String);

impl RefreshToken {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone)]
pub struct RefreshTokenIssue {
    pub token: RefreshToken,
    pub family_id: Uuid,
    pub token_id: Uuid,
    pub user_id: Uuid,
    pub expires_at: OffsetDateTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RefreshTokenUseError {
    #[error("invalid refresh token")]
    InvalidToken,
    #[error("refresh token expired")]
    Expired,
    #[error("refresh token family has been revoked")]
    FamilyRevoked,
    #[error("refresh token reuse detected")]
    ReuseDetected,
    #[error("refresh token storage error")]
    Storage,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RefreshTokenStore;

impl RefreshTokenStore {
    pub async fn issue_family(
        &self,
        pool: &PgPool,
        user_id: Uuid,
        now: OffsetDateTime,
        ttl: Duration,
    ) -> Result<RefreshTokenIssue, AuthError> {
        let family_id = Uuid::new_v4();
        let token_id = Uuid::new_v4();
        let token = generate_refresh_token();
        let token_hash = hash_token(token.as_str());
        let expires_at = now + ttl;

        let audit = AuditEvent::new(
            Some(UserId::from_uuid(user_id)),
            AuditAction::new("auth.refresh.issue")?,
            "auth_refresh_token_family",
            family_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "family_id": family_id,
                "token_id": token_id,
                "user_id": user_id,
                "expires_at": expires_at,
            })),
        );

        with_audit::<_, (), AuthError>(pool, audit, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO auth_refresh_token_families (id, user_id, created_at, org_id)
                    VALUES ($1, $2, $3, $4)
                    "#,
                )
                .bind(family_id)
                .bind(user_id)
                .bind(now)
                .bind(*OrgId::knl().as_uuid())
                .execute(tx.as_mut())
                .await?;

                sqlx::query(
                    r#"
                    INSERT INTO auth_refresh_tokens (
                        id, family_id, user_id, token_hash, issued_at, expires_at, org_id
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                    "#,
                )
                .bind(token_id)
                .bind(family_id)
                .bind(user_id)
                .bind(token_hash)
                .bind(now)
                .bind(expires_at)
                .bind(*OrgId::knl().as_uuid())
                .execute(tx.as_mut())
                .await?;

                Ok(())
            })
        })
        .await?;

        Ok(RefreshTokenIssue {
            token: RefreshToken(token),
            family_id,
            token_id,
            user_id,
            expires_at,
        })
    }

    pub async fn rotate(
        &self,
        pool: &PgPool,
        presented_token: &str,
        now: OffsetDateTime,
        ttl: Duration,
    ) -> Result<RefreshTokenIssue, RefreshTokenUseError> {
        self.rotate_inner(pool, presented_token, now, ttl)
            .await
            .map_err(|err| match err {
                AuthError::Refresh(refresh) => refresh,
                _ => RefreshTokenUseError::Storage,
            })
    }

    async fn rotate_inner(
        &self,
        pool: &PgPool,
        presented_token: &str,
        now: OffsetDateTime,
        ttl: Duration,
    ) -> Result<RefreshTokenIssue, AuthError> {
        let token_hash = hash_token(presented_token);
        let mut tx = pool.begin().await?;

        let row = sqlx::query(
            r#"
            SELECT
                t.id AS token_id,
                t.family_id,
                t.user_id,
                t.expires_at,
                t.used_at,
                t.revoked_at AS token_revoked_at,
                f.revoked_at AS family_revoked_at
            FROM auth_refresh_tokens t
            JOIN auth_refresh_token_families f ON f.id = t.family_id
            WHERE t.token_hash = $1
            FOR UPDATE OF t, f
            "#,
        )
        .bind(token_hash)
        .fetch_optional(tx.as_mut())
        .await?;

        let Some(row) = row else {
            tx.rollback().await?;
            return Err(RefreshTokenUseError::InvalidToken.into());
        };

        let token_id: Uuid = row.try_get("token_id")?;
        let family_id: Uuid = row.try_get("family_id")?;
        let user_id: Uuid = row.try_get("user_id")?;
        let expires_at: OffsetDateTime = row.try_get("expires_at")?;
        let used_at: Option<OffsetDateTime> = row.try_get("used_at")?;
        let token_revoked_at: Option<OffsetDateTime> = row.try_get("token_revoked_at")?;
        let family_revoked_at: Option<OffsetDateTime> = row.try_get("family_revoked_at")?;

        if family_revoked_at.is_some() {
            tx.rollback().await?;
            return Err(RefreshTokenUseError::FamilyRevoked.into());
        }

        if used_at.is_some() || token_revoked_at.is_some() {
            revoke_family_for_reuse(&mut tx, family_id, token_id, now).await?;
            insert_audit_in_tx(
                &mut tx,
                user_id,
                family_id,
                "auth.refresh.reuse_detected",
                now,
                serde_json::json!({
                    "family_id": family_id,
                    "revoked_reason": "reuse_detected",
                    "reused_token_id": token_id,
                }),
            )
            .await?;
            tx.commit().await?;
            return Err(RefreshTokenUseError::ReuseDetected.into());
        }

        if expires_at <= now {
            sqlx::query("UPDATE auth_refresh_tokens SET revoked_at = $1 WHERE id = $2")
                .bind(now)
                .bind(token_id)
                .execute(tx.as_mut())
                .await?;
            tx.commit().await?;
            return Err(RefreshTokenUseError::Expired.into());
        }

        let replacement_id = Uuid::new_v4();
        let replacement = generate_refresh_token();
        let replacement_hash = hash_token(replacement.as_str());
        let replacement_expires_at = now + ttl;

        sqlx::query(
            r#"
            INSERT INTO auth_refresh_tokens (
                id, family_id, user_id, token_hash, issued_at, expires_at, org_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(replacement_id)
        .bind(family_id)
        .bind(user_id)
        .bind(replacement_hash)
        .bind(now)
        .bind(replacement_expires_at)
        .bind(*OrgId::knl().as_uuid())
        .execute(tx.as_mut())
        .await?;

        sqlx::query(
            r#"
            UPDATE auth_refresh_tokens
            SET used_at = $1, replaced_by = $2
            WHERE id = $3
            "#,
        )
        .bind(now)
        .bind(replacement_id)
        .bind(token_id)
        .execute(tx.as_mut())
        .await?;

        insert_audit_in_tx(
            &mut tx,
            user_id,
            family_id,
            "auth.refresh",
            now,
            serde_json::json!({
                "family_id": family_id,
                "used_token_id": token_id,
                "replacement_token_id": replacement_id,
                "expires_at": replacement_expires_at,
            }),
        )
        .await?;

        tx.commit().await?;

        Ok(RefreshTokenIssue {
            token: RefreshToken(replacement),
            family_id,
            token_id: replacement_id,
            user_id,
            expires_at: replacement_expires_at,
        })
    }

    pub async fn revoke_family_for_logout(
        &self,
        pool: &PgPool,
        presented_token: &str,
        now: OffsetDateTime,
    ) -> Result<(), RefreshTokenUseError> {
        self.revoke_family_for_logout_inner(pool, presented_token, now)
            .await
            .map_err(|err| match err {
                AuthError::Refresh(refresh) => refresh,
                _ => RefreshTokenUseError::Storage,
            })
    }

    async fn revoke_family_for_logout_inner(
        &self,
        pool: &PgPool,
        presented_token: &str,
        now: OffsetDateTime,
    ) -> Result<(), AuthError> {
        let token_hash = hash_token(presented_token);
        let mut tx = pool.begin().await?;

        let row = sqlx::query(
            r#"
            SELECT
                t.family_id,
                t.user_id,
                f.revoked_at AS family_revoked_at
            FROM auth_refresh_tokens t
            JOIN auth_refresh_token_families f ON f.id = t.family_id
            WHERE t.token_hash = $1
            FOR UPDATE OF t, f
            "#,
        )
        .bind(token_hash)
        .fetch_optional(tx.as_mut())
        .await?;

        let Some(row) = row else {
            tx.rollback().await?;
            return Err(RefreshTokenUseError::InvalidToken.into());
        };

        let family_id: Uuid = row.try_get("family_id")?;
        let user_id: Uuid = row.try_get("user_id")?;
        let family_revoked_at: Option<OffsetDateTime> = row.try_get("family_revoked_at")?;

        if family_revoked_at.is_some() {
            tx.rollback().await?;
            return Err(RefreshTokenUseError::FamilyRevoked.into());
        }

        sqlx::query(
            r#"
            UPDATE auth_refresh_token_families
            SET revoked_at = $1, revoked_reason = 'logout'
            WHERE id = $2 AND revoked_at IS NULL
            "#,
        )
        .bind(now)
        .bind(family_id)
        .execute(tx.as_mut())
        .await?;

        sqlx::query(
            r#"
            UPDATE auth_refresh_tokens
            SET revoked_at = COALESCE(revoked_at, $1)
            WHERE family_id = $2
            "#,
        )
        .bind(now)
        .bind(family_id)
        .execute(tx.as_mut())
        .await?;

        insert_audit_in_tx(
            &mut tx,
            user_id,
            family_id,
            "auth.logout",
            now,
            serde_json::json!({
                "family_id": family_id,
                "revoked_reason": "logout",
            }),
        )
        .await?;

        tx.commit().await?;
        Ok(())
    }
}

async fn revoke_family_for_reuse(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    family_id: Uuid,
    reused_token_id: Uuid,
    now: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE auth_refresh_token_families
        SET revoked_at = $1, revoked_reason = 'reuse_detected'
        WHERE id = $2 AND revoked_at IS NULL
        "#,
    )
    .bind(now)
    .bind(family_id)
    .execute(tx.as_mut())
    .await?;

    sqlx::query(
        r#"
        UPDATE auth_refresh_tokens
        SET revoked_at = COALESCE(revoked_at, $1),
            reuse_detected_at = CASE WHEN id = $2 THEN $1 ELSE reuse_detected_at END
        WHERE family_id = $3
        "#,
    )
    .bind(now)
    .bind(reused_token_id)
    .bind(family_id)
    .execute(tx.as_mut())
    .await?;

    Ok(())
}

async fn insert_audit_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    family_id: Uuid,
    action: &str,
    now: OffsetDateTime,
    after: serde_json::Value,
) -> Result<(), AuthError> {
    let event = AuditEvent::new(
        Some(UserId::from_uuid(user_id)),
        AuditAction::new(action)?,
        "auth_refresh_token_family",
        family_id.to_string(),
        TraceContext::generate(),
        now,
    )
    .with_snapshots(None, Some(after));

    sqlx::query(
        r#"
        INSERT INTO audit_events (
            id, actor, action, target_type, target_id, branch_id,
            before_snap, after_snap, trace_id, span_id, occurred_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        "#,
    )
    .bind(*event.id.as_uuid())
    .bind(event.actor.map(|actor| *actor.as_uuid()))
    .bind(event.action.as_str())
    .bind(event.target_type)
    .bind(event.target_id)
    .bind(event.branch_id.map(|branch| *branch.as_uuid()))
    .bind(event.before)
    .bind(event.after)
    .bind(event.trace.trace_id())
    .bind(event.trace.span_id())
    .bind(event.occurred_at)
    .execute(tx.as_mut())
    .await?;

    Ok(())
}

fn generate_refresh_token() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    format!("mnt_rt_{}", hex_encode(&bytes))
}

fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
