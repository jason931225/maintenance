use mnt_kernel_core::{AuditAction, AuditEvent, TraceContext, UserId};
use mnt_platform_db::with_audit;
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use url::Url;
use uuid::Uuid;
use webauthn_rs::prelude::{
    CreationChallengeResponse, Passkey, PasskeyAuthentication, PasskeyRegistration,
    PublicKeyCredential, RegisterPublicKeyCredential, RequestChallengeResponse, Webauthn,
    WebauthnBuilder,
};

use crate::AuthError;

pub type PasskeyRegistrationCredential = RegisterPublicKeyCredential;

#[derive(Debug, Clone)]
pub struct WebauthnSettings {
    pub rp_id: String,
    pub rp_origin: Url,
    pub rp_name: String,
    pub extra_allowed_origins: Vec<Url>,
    pub ceremony_ttl: Duration,
}

#[derive(Clone)]
pub struct PasskeyService {
    webauthn: Webauthn,
    ceremony_ttl: Duration,
}

#[derive(Debug, Clone)]
pub struct PasskeyRegistrationStart {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Clone)]
pub struct AuthenticationStart {
    pub user_id: Uuid,
}

#[derive(Debug)]
pub struct RegistrationCeremony {
    pub ceremony_id: Uuid,
    pub challenge: CreationChallengeResponse,
    pub expires_at: OffsetDateTime,
}

#[derive(Debug)]
pub struct AuthenticationCeremony {
    pub ceremony_id: Uuid,
    pub challenge: RequestChallengeResponse,
    pub expires_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPasskey {
    pub id: Uuid,
    pub user_id: Uuid,
    pub credential_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticationOutcome {
    pub user_id: Uuid,
    pub passkey_id: Uuid,
}

impl PasskeyService {
    pub fn new(settings: WebauthnSettings) -> Result<Self, AuthError> {
        let mut builder =
            WebauthnBuilder::new(&settings.rp_id, &settings.rp_origin)?.rp_name(&settings.rp_name);
        for origin in &settings.extra_allowed_origins {
            builder = builder.append_allowed_origin(origin);
        }
        Ok(Self {
            webauthn: builder.build()?,
            ceremony_ttl: settings.ceremony_ttl,
        })
    }

    pub async fn start_registration(
        &self,
        pool: &PgPool,
        input: PasskeyRegistrationStart,
    ) -> Result<RegistrationCeremony, AuthError> {
        let existing = load_user_passkeys(pool, input.user_id).await?;
        let exclude_credentials = existing
            .into_iter()
            .map(|passkey| passkey.cred_id().clone())
            .collect::<Vec<_>>();
        let exclude_credentials = if exclude_credentials.is_empty() {
            None
        } else {
            Some(exclude_credentials)
        };

        let (challenge, state) = self.webauthn.start_passkey_registration(
            input.user_id,
            &input.username,
            &input.display_name,
            exclude_credentials,
        )?;
        let ceremony_id = Uuid::new_v4();
        let now = OffsetDateTime::now_utc();
        let expires_at = now + self.ceremony_ttl;

        persist_ceremony(
            pool,
            ceremony_id,
            Some(input.user_id),
            "registration",
            &challenge,
            &state,
            expires_at,
        )
        .await?;

        Ok(RegistrationCeremony {
            ceremony_id,
            challenge,
            expires_at,
        })
    }

    pub async fn finish_registration(
        &self,
        pool: &PgPool,
        ceremony_id: Uuid,
        credential: RegisterPublicKeyCredential,
    ) -> Result<StoredPasskey, AuthError> {
        let row = load_ceremony(pool, ceremony_id, "registration").await?;
        let user_id = row.user_id.ok_or_else(|| {
            AuthError::InvalidStoredData("registration ceremony missing user_id".to_owned())
        })?;
        let state: PasskeyRegistration = serde_json::from_value(row.state_json)?;
        let passkey = self
            .webauthn
            .finish_passkey_registration(&credential, &state)?;
        let passkey_json = serde_json::to_value(&passkey)?;
        let credential_id = serialize_to_string(passkey.cred_id(), "passkey credential id")?;
        let passkey_id = Uuid::new_v4();
        let now = OffsetDateTime::now_utc();

        let audit = AuditEvent::new(
            Some(UserId::from_uuid(user_id)),
            AuditAction::new("auth.passkey.register")?,
            "auth_webauthn_credential",
            passkey_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "credential_id": credential_id,
                "user_id": user_id,
            })),
        );
        let credential_id_for_insert = credential_id.clone();

        with_audit::<_, (), AuthError>(pool, audit, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO auth_webauthn_credentials (
                        id, user_id, credential_id, passkey_json, created_at
                    ) VALUES ($1, $2, $3, $4, $5)
                    "#,
                )
                .bind(passkey_id)
                .bind(user_id)
                .bind(&credential_id_for_insert)
                .bind(passkey_json)
                .bind(now)
                .execute(tx.as_mut())
                .await?;

                consume_ceremony_tx(tx, ceremony_id, now).await?;
                Ok(())
            })
        })
        .await?;

        Ok(StoredPasskey {
            id: passkey_id,
            user_id,
            credential_id,
        })
    }

    pub async fn start_authentication(
        &self,
        pool: &PgPool,
        input: AuthenticationStart,
    ) -> Result<AuthenticationCeremony, AuthError> {
        let passkeys = load_user_passkeys(pool, input.user_id).await?;
        if passkeys.is_empty() {
            return Err(AuthError::InvalidStoredData(
                "user has no registered passkeys".to_owned(),
            ));
        }
        let (challenge, state) = self.webauthn.start_passkey_authentication(&passkeys)?;
        let ceremony_id = Uuid::new_v4();
        let now = OffsetDateTime::now_utc();
        let expires_at = now + self.ceremony_ttl;

        persist_ceremony(
            pool,
            ceremony_id,
            Some(input.user_id),
            "authentication",
            &challenge,
            &state,
            expires_at,
        )
        .await?;

        Ok(AuthenticationCeremony {
            ceremony_id,
            challenge,
            expires_at,
        })
    }

    pub async fn finish_authentication(
        &self,
        pool: &PgPool,
        ceremony_id: Uuid,
        credential: PublicKeyCredential,
    ) -> Result<AuthenticationOutcome, AuthError> {
        let row = load_ceremony(pool, ceremony_id, "authentication").await?;
        let user_id = row.user_id.ok_or_else(|| {
            AuthError::InvalidStoredData("authentication ceremony missing user_id".to_owned())
        })?;
        let state: PasskeyAuthentication = serde_json::from_value(row.state_json)?;
        let result = self
            .webauthn
            .finish_passkey_authentication(&credential, &state)?;
        let credential_id = serialize_to_string(result.cred_id(), "authentication credential id")?;

        let row = sqlx::query(
            r#"
            SELECT id, passkey_json
            FROM auth_webauthn_credentials
            WHERE user_id = $1 AND credential_id = $2
            "#,
        )
        .bind(user_id)
        .bind(&credential_id)
        .fetch_one(pool)
        .await?;
        let passkey_id: Uuid = row.try_get("id")?;
        let passkey_json: serde_json::Value = row.try_get("passkey_json")?;
        let mut passkey: Passkey = serde_json::from_value(passkey_json)?;
        let changed = passkey.update_credential(&result).unwrap_or(false);
        let updated_passkey_json = if changed {
            Some(serde_json::to_value(&passkey)?)
        } else {
            None
        };
        let now = OffsetDateTime::now_utc();

        let mut tx = pool.begin().await?;
        if let Some(updated_passkey_json) = updated_passkey_json {
            sqlx::query(
                r#"
                UPDATE auth_webauthn_credentials
                SET passkey_json = $1, last_used_at = $2
                WHERE id = $3
                "#,
            )
            .bind(updated_passkey_json)
            .bind(now)
            .bind(passkey_id)
            .execute(tx.as_mut())
            .await?;
        } else {
            sqlx::query("UPDATE auth_webauthn_credentials SET last_used_at = $1 WHERE id = $2")
                .bind(now)
                .bind(passkey_id)
                .execute(tx.as_mut())
                .await?;
        }
        consume_ceremony_tx(&mut tx, ceremony_id, now).await?;
        tx.commit().await?;

        Ok(AuthenticationOutcome {
            user_id,
            passkey_id,
        })
    }
}

struct CeremonyRow {
    user_id: Option<Uuid>,
    state_json: serde_json::Value,
}

async fn persist_ceremony<C, S>(
    pool: &PgPool,
    id: Uuid,
    user_id: Option<Uuid>,
    kind: &str,
    challenge: &C,
    state: &S,
    expires_at: OffsetDateTime,
) -> Result<(), AuthError>
where
    C: serde::Serialize,
    S: serde::Serialize,
{
    sqlx::query(
        r#"
        INSERT INTO auth_webauthn_ceremonies (
            id, user_id, ceremony_kind, challenge_json, state_json, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(id)
    .bind(user_id)
    .bind(kind)
    .bind(serde_json::to_value(challenge)?)
    .bind(serde_json::to_value(state)?)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

async fn load_ceremony(pool: &PgPool, id: Uuid, kind: &str) -> Result<CeremonyRow, AuthError> {
    let row = sqlx::query(
        r#"
        SELECT user_id, state_json
        FROM auth_webauthn_ceremonies
        WHERE id = $1
          AND ceremony_kind = $2
          AND consumed_at IS NULL
          AND expires_at > now()
        "#,
    )
    .bind(id)
    .bind(kind)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AuthError::InvalidStoredData("ceremony not found or expired".to_owned()))?;

    Ok(CeremonyRow {
        user_id: row.try_get("user_id")?,
        state_json: row.try_get("state_json")?,
    })
}

async fn consume_ceremony_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    now: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE auth_webauthn_ceremonies SET consumed_at = $1 WHERE id = $2")
        .bind(now)
        .bind(id)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

async fn load_user_passkeys(pool: &PgPool, user_id: Uuid) -> Result<Vec<Passkey>, AuthError> {
    let rows = sqlx::query(
        "SELECT passkey_json FROM auth_webauthn_credentials WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            let value: serde_json::Value = row.try_get("passkey_json")?;
            Ok(serde_json::from_value(value)?)
        })
        .collect()
}

fn serialize_to_string<T>(value: &T, label: &str) -> Result<String, AuthError>
where
    T: serde::Serialize,
{
    let value = serde_json::to_value(value)?;
    value
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| AuthError::InvalidStoredData(format!("{label} did not serialize as string")))
}
