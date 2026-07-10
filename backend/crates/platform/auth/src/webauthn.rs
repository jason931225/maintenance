use mnt_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use mnt_platform_db::insert_audit_event;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use url::Url;
use uuid::Uuid;
use webauthn_rs::prelude::{
    CreationChallengeResponse, DiscoverableAuthentication, DiscoverableKey, Passkey,
    PasskeyRegistration, PublicKeyCredential, RegisterPublicKeyCredential,
    RequestChallengeResponse, Webauthn, WebauthnBuilder,
};

use crate::AuthError;

pub type PasskeyRegistrationCredential = RegisterPublicKeyCredential;
pub type PasskeyAuthenticationCredential = PublicKeyCredential;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MobileStepUpActionKind {
    ApprovalDecision,
    PollVote,
}

impl MobileStepUpActionKind {
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::ApprovalDecision => "APPROVAL_DECISION",
            Self::PollVote => "POLL_VOTE",
        }
    }

    pub const fn expected_reason_key(self) -> &'static str {
        match self {
            Self::ApprovalDecision => "operations_passkey_approval_decision",
            Self::PollVote => "operations_passkey_poll_vote",
        }
    }

    fn from_wire(raw: &str) -> Result<Self, AuthError> {
        match raw {
            "APPROVAL_DECISION" => Ok(Self::ApprovalDecision),
            "POLL_VOTE" => Ok(Self::PollVote),
            _ => Err(AuthError::InvalidStoredData(format!(
                "unknown mobile step-up action kind: {raw}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MobilePasskeyStepUpBinding {
    pub action_kind: MobileStepUpActionKind,
    pub object_id: Uuid,
    pub reason_key: String,
    pub replay_attempt: Option<i32>,
}

impl<'de> Deserialize<'de> for MobilePasskeyStepUpBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct BindingVisitor;

        enum Field {
            ActionKind,
            ObjectId,
            ReasonKey,
            ReplayAttempt,
            Ignore,
        }

        impl<'de> Deserialize<'de> for Field {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct FieldVisitor;

                impl serde::de::Visitor<'_> for FieldVisitor {
                    type Value = Field;

                    fn expecting(
                        &self,
                        formatter: &mut std::fmt::Formatter<'_>,
                    ) -> std::fmt::Result {
                        formatter.write_str("a mobile passkey step-up binding field")
                    }

                    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
                    where
                        E: serde::de::Error,
                    {
                        Ok(match value {
                            "action_kind" => Field::ActionKind,
                            "object_id" => Field::ObjectId,
                            "reason_key" => Field::ReasonKey,
                            "replay_attempt" => Field::ReplayAttempt,
                            _ => Field::Ignore,
                        })
                    }
                }

                deserializer.deserialize_identifier(FieldVisitor)
            }
        }

        impl<'de> serde::de::Visitor<'de> for BindingVisitor {
            type Value = MobilePasskeyStepUpBinding;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a mobile passkey step-up binding")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut action_kind = None;
                let mut object_id = None;
                let mut reason_key = None;
                let mut replay_attempt = None;

                while let Some(key) = map.next_key::<Field>()? {
                    match key {
                        Field::ActionKind => {
                            if action_kind.is_some() {
                                return Err(serde::de::Error::duplicate_field("action_kind"));
                            }
                            action_kind = Some(map.next_value()?);
                        }
                        Field::ObjectId => {
                            if object_id.is_some() {
                                return Err(serde::de::Error::duplicate_field("object_id"));
                            }
                            object_id = Some(map.next_value()?);
                        }
                        Field::ReasonKey => {
                            if reason_key.is_some() {
                                return Err(serde::de::Error::duplicate_field("reason_key"));
                            }
                            reason_key = Some(map.next_value()?);
                        }
                        Field::ReplayAttempt => {
                            if replay_attempt.is_some() {
                                return Err(serde::de::Error::duplicate_field("replay_attempt"));
                            }
                            replay_attempt = Some(map.next_value::<Option<i32>>()?);
                        }
                        Field::Ignore => {
                            let _ = map.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }

                Ok(MobilePasskeyStepUpBinding {
                    action_kind: action_kind
                        .ok_or_else(|| serde::de::Error::missing_field("action_kind"))?,
                    object_id: object_id
                        .ok_or_else(|| serde::de::Error::missing_field("object_id"))?,
                    reason_key: reason_key
                        .ok_or_else(|| serde::de::Error::missing_field("reason_key"))?,
                    replay_attempt: replay_attempt
                        .ok_or_else(|| serde::de::Error::missing_field("replay_attempt"))?,
                })
            }
        }

        const FIELDS: &[&str] = &["action_kind", "object_id", "reason_key", "replay_attempt"];
        deserializer.deserialize_struct("MobilePasskeyStepUpBinding", FIELDS, BindingVisitor)
    }
}

impl MobilePasskeyStepUpBinding {
    pub fn approval_decision(object_id: Uuid, replay_attempt: Option<i32>) -> Self {
        Self::new(
            MobileStepUpActionKind::ApprovalDecision,
            object_id,
            replay_attempt,
        )
    }

    pub fn poll_vote(object_id: Uuid, replay_attempt: Option<i32>) -> Self {
        Self::new(MobileStepUpActionKind::PollVote, object_id, replay_attempt)
    }

    fn new(
        action_kind: MobileStepUpActionKind,
        object_id: Uuid,
        replay_attempt: Option<i32>,
    ) -> Self {
        Self {
            action_kind,
            object_id,
            reason_key: action_kind.expected_reason_key().to_owned(),
            replay_attempt,
        }
    }

    pub fn validate(&self) -> Result<(), MobileStepUpBindingError> {
        if self.reason_key != self.action_kind.expected_reason_key() {
            return Err(MobileStepUpBindingError::ReasonKeyMismatch);
        }
        if self.replay_attempt.is_some_and(|attempt| attempt < 1) {
            return Err(MobileStepUpBindingError::InvalidReplayAttempt);
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MobileStepUpBindingError {
    #[error("reason_key is not supported for action_kind")]
    ReasonKeyMismatch,

    #[error("replay_attempt must be null or a positive 1-based integer")]
    InvalidReplayAttempt,
}

#[derive(Debug, Deserialize)]
pub struct MobilePasskeyStepUpAssertion {
    pub ceremony_id: Uuid,
    pub credential: PasskeyAuthenticationCredential,
}

#[derive(Debug, Deserialize)]
pub struct MobilePasskeyStepUpEnvelope {
    pub binding: MobilePasskeyStepUpBinding,
    pub assertion: MobilePasskeyStepUpAssertion,
}

#[derive(Debug, thiserror::Error)]
pub enum MobilePasskeyStepUpVerificationError {
    #[error("mobile passkey step-up binding mismatch")]
    BindingMismatch,

    #[error(transparent)]
    Auth(#[from] AuthError),
}

impl From<sqlx::Error> for MobilePasskeyStepUpVerificationError {
    fn from(value: sqlx::Error) -> Self {
        Self::Auth(value.into())
    }
}

impl From<serde_json::Error> for MobilePasskeyStepUpVerificationError {
    fn from(value: serde_json::Error) -> Self {
        Self::Auth(value.into())
    }
}

impl From<webauthn_rs::prelude::WebauthnError> for MobilePasskeyStepUpVerificationError {
    fn from(value: webauthn_rs::prelude::WebauthnError) -> Self {
        Self::Auth(value.into())
    }
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
    /// The tenant the asserting credential belongs to, resolved from the
    /// credential id BEFORE the RLS-gated read. The login handler uses it to arm
    /// the GUC for the subsequent `users` read + session mint, since the passkey
    /// login route runs before the tenant middleware.
    pub org_id: OrgId,
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
        org: OrgId,
        input: PasskeyRegistrationStart,
    ) -> Result<RegistrationCeremony, AuthError> {
        // Authenticated path: `org` comes from the verified JWT's `org` claim.
        // `load_user_passkeys` reads the FORCE-RLS `auth_webauthn_credentials`, so
        // the org is armed inside it to avoid an empty exclude-credentials list
        // (which would let a user re-register an already-registered authenticator).
        let existing = load_user_passkeys(pool, org, input.user_id).await?;
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

    /// Count the authenticated user's existing passkeys (RLS-armed).
    ///
    /// Used by the add-device flow to decide whether a fresh step-up assertion is
    /// REQUIRED: a user with zero passkeys is doing initial enrollment (no
    /// existing credential to assert), while a user with one or more must prove
    /// possession of an existing passkey before a new one is issued.
    pub async fn count_user_passkeys(
        &self,
        pool: &PgPool,
        org: OrgId,
        user_id: Uuid,
    ) -> Result<usize, AuthError> {
        Ok(load_user_passkeys(pool, org, user_id).await?.len())
    }

    /// Verify a FRESH step-up assertion of one of `expected_user_id`'s OWN
    /// existing passkeys, with user verification (UV) required.
    ///
    /// This is the anti-silent-add gate for self-service device enrollment: before
    /// a new credential is issued to an already-enrolled user, the caller must
    /// assert an existing passkey of THE SAME user with UV=true, so a stolen
    /// session (bearer token only, no authenticator) cannot add a credential.
    ///
    /// The assertion ceremony is claimed atomically (single-use, like login), the
    /// discoverable assertion is verified against the resolved credential, and the
    /// assertion is rejected unless (a) `user_verified()` is true and (b) the
    /// asserting credential belongs to `expected_user_id`. The credential's org is
    /// resolved + the GUC armed exactly as in `finish_authentication`, but NO
    /// token is minted and NO session is created — this only proves possession.
    pub async fn verify_step_up_for_user(
        &self,
        pool: &PgPool,
        ceremony_id: Uuid,
        credential: PublicKeyCredential,
        expected_user_id: Uuid,
    ) -> Result<(), AuthError> {
        let now = OffsetDateTime::now_utc();
        let mut tx = pool.begin().await?;

        let claim = claim_ceremony_tx(&mut tx, ceremony_id, "authentication", now)
            .await?
            .ok_or_else(|| {
                AuthError::InvalidStoredData("ceremony not found or already consumed".to_owned())
            })?;

        let credential_id = serialize_to_string(&credential.raw_id, "step-up credential id")?;

        let Some(org_uuid) = resolve_credential_org(&mut tx, &credential_id).await? else {
            return Err(AuthError::InvalidStoredData(
                "asserted credential is not registered".to_owned(),
            ));
        };
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_uuid.to_string())
            .execute(tx.as_mut())
            .await?;

        let row = sqlx::query(
            r#"
            SELECT id, user_id, passkey_json
            FROM auth_webauthn_credentials
            WHERE credential_id = $1
            "#,
        )
        .bind(&credential_id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| {
            AuthError::InvalidStoredData("asserted credential is not registered".to_owned())
        })?;
        let passkey_id: Uuid = row.try_get("id")?;
        let user_id: Uuid = row.try_get("user_id")?;
        let passkey_json: serde_json::Value = row.try_get("passkey_json")?;

        // The step-up must assert one of the AUTHENTICATED caller's OWN passkeys.
        // A credential belonging to anyone else (or a handle mismatch) is rejected
        // before verification so a different user's authenticator can never unlock
        // an add-device for this account.
        if user_id != expected_user_id {
            return Err(AuthError::InvalidStoredData(
                "step-up credential does not belong to the authenticated user".to_owned(),
            ));
        }
        if let Some(asserted_handle) = credential.get_user_unique_id()
            && Uuid::from_slice(asserted_handle).ok() != Some(user_id)
        {
            return Err(AuthError::InvalidStoredData(
                "asserted user handle does not match the credential owner".to_owned(),
            ));
        }

        let state: DiscoverableAuthentication = serde_json::from_value(claim.state_json)?;
        let mut passkey: Passkey = serde_json::from_value(passkey_json)?;
        let discoverable_key = DiscoverableKey::from(&passkey);
        let result = self.webauthn.finish_discoverable_authentication(
            &credential,
            state,
            &[discoverable_key],
        )?;

        // Require user verification (UV): a step-up to add a NEW credential is a
        // high-value action, so a mere user-presence touch is insufficient — the
        // authenticator must have verified the user (biometric/PIN).
        if !result.user_verified() {
            return Err(AuthError::InvalidStoredData(
                "step-up assertion did not perform user verification".to_owned(),
            ));
        }

        // Keep the sign-count / backup-state fresh, mirroring login, so a replayed
        // counter is still caught on the next real authentication.
        let changed = passkey.update_credential(&result).unwrap_or(false);
        if changed {
            sqlx::query(
                r#"
                UPDATE auth_webauthn_credentials
                SET passkey_json = $1, last_used_at = $2
                WHERE id = $3
                "#,
            )
            .bind(serde_json::to_value(&passkey)?)
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

        tx.commit().await?;
        Ok(())
    }

    pub async fn start_mobile_step_up(
        &self,
        pool: &PgPool,
        user_id: Uuid,
        binding: MobilePasskeyStepUpBinding,
    ) -> Result<AuthenticationCeremony, AuthError> {
        binding
            .validate()
            .map_err(|err| AuthError::InvalidStoredData(err.to_string()))?;
        let (challenge, state) = self.webauthn.start_discoverable_authentication()?;
        let ceremony_id = Uuid::new_v4();
        let now = OffsetDateTime::now_utc();
        let expires_at = now + self.ceremony_ttl;

        let mut tx = pool.begin().await?;
        sqlx::query(
            r#"
            INSERT INTO auth_webauthn_ceremonies (
                id, user_id, ceremony_kind, challenge_json, state_json, expires_at
            ) VALUES ($1, $2, 'authentication', $3, $4, $5)
            "#,
        )
        .bind(ceremony_id)
        .bind(user_id)
        .bind(serde_json::to_value(&challenge)?)
        .bind(serde_json::to_value(&state)?)
        .bind(expires_at)
        // rls-arming: ok auth_webauthn_ceremonies is a global auth table (no org_id, no RLS)
        .execute(tx.as_mut())
        .await?;
        insert_mobile_step_up_binding_tx(&mut tx, ceremony_id, &binding).await?;
        tx.commit().await?;

        Ok(AuthenticationCeremony {
            ceremony_id,
            challenge,
            expires_at,
        })
    }

    pub async fn verify_mobile_step_up_for_user(
        &self,
        pool: &PgPool,
        envelope: MobilePasskeyStepUpEnvelope,
        expected_user_id: Uuid,
        expected_binding: &MobilePasskeyStepUpBinding,
    ) -> Result<(), MobilePasskeyStepUpVerificationError> {
        if envelope.binding != *expected_binding {
            return Err(MobilePasskeyStepUpVerificationError::BindingMismatch);
        }

        let now = OffsetDateTime::now_utc();
        let mut tx = pool.begin().await?;
        let claim = claim_ceremony_tx(
            &mut tx,
            envelope.assertion.ceremony_id,
            "authentication",
            now,
        )
        .await?
        .ok_or_else(|| {
            AuthError::InvalidStoredData("ceremony not found or already consumed".to_owned())
        })?;

        if claim.user_id != Some(expected_user_id) {
            return Err(AuthError::InvalidStoredData(
                "step-up ceremony does not belong to the authenticated user".to_owned(),
            )
            .into());
        }

        let persisted = load_mobile_step_up_binding_tx(&mut tx, envelope.assertion.ceremony_id)
            .await?
            .ok_or(MobilePasskeyStepUpVerificationError::BindingMismatch)?;
        if persisted != *expected_binding {
            return Err(MobilePasskeyStepUpVerificationError::BindingMismatch);
        }

        let credential = envelope.assertion.credential;
        let credential_id = serialize_to_string(&credential.raw_id, "step-up credential id")?;

        let Some(org_uuid) = resolve_credential_org(&mut tx, &credential_id).await? else {
            return Err(AuthError::InvalidStoredData(
                "asserted credential is not registered".to_owned(),
            )
            .into());
        };
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_uuid.to_string())
            .execute(tx.as_mut())
            .await?;

        let row = sqlx::query(
            r#"
            SELECT id, user_id, passkey_json
            FROM auth_webauthn_credentials
            WHERE credential_id = $1
            "#,
        )
        .bind(&credential_id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| {
            AuthError::InvalidStoredData("asserted credential is not registered".to_owned())
        })?;
        let passkey_id: Uuid = row.try_get("id")?;
        let user_id: Uuid = row.try_get("user_id")?;
        let passkey_json: serde_json::Value = row.try_get("passkey_json")?;

        if user_id != expected_user_id {
            return Err(AuthError::InvalidStoredData(
                "step-up credential does not belong to the authenticated user".to_owned(),
            )
            .into());
        }
        if let Some(asserted_handle) = credential.get_user_unique_id()
            && Uuid::from_slice(asserted_handle).ok() != Some(user_id)
        {
            return Err(AuthError::InvalidStoredData(
                "asserted user handle does not match the credential owner".to_owned(),
            )
            .into());
        }

        let state: DiscoverableAuthentication = serde_json::from_value(claim.state_json)?;
        let mut passkey: Passkey = serde_json::from_value(passkey_json)?;
        let discoverable_key = DiscoverableKey::from(&passkey);
        let result = self.webauthn.finish_discoverable_authentication(
            &credential,
            state,
            &[discoverable_key],
        )?;

        if !result.user_verified() {
            return Err(AuthError::InvalidStoredData(
                "step-up assertion did not perform user verification".to_owned(),
            )
            .into());
        }

        let changed = passkey.update_credential(&result).unwrap_or(false);
        if changed {
            sqlx::query(
                r#"
                UPDATE auth_webauthn_credentials
                SET passkey_json = $1, last_used_at = $2
                WHERE id = $3
                "#,
            )
            .bind(serde_json::to_value(&passkey)?)
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

        tx.commit().await?;
        Ok(())
    }

    pub async fn finish_registration(
        &self,
        pool: &PgPool,
        org: OrgId,
        ceremony_id: Uuid,
        credential: RegisterPublicKeyCredential,
    ) -> Result<StoredPasskey, AuthError> {
        let now = OffsetDateTime::now_utc();
        let mut tx = pool.begin().await?;
        let stored = self
            .finish_registration_in_tx(&mut tx, org, ceremony_id, credential, now)
            .await?;
        tx.commit().await?;
        Ok(stored)
    }

    /// Finish a passkey registration inside a caller-provided transaction.
    ///
    /// Performs the atomic ceremony claim, verifies the credential against the
    /// claimed state, inserts the passkey, and appends the audit row — all in the
    /// caller's transaction. The bootstrap cold-start path uses this so the
    /// passkey insert and the single-use bootstrap-credential consume commit (or
    /// roll back) atomically together. The caller owns the `commit`.
    pub async fn finish_registration_in_tx(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        org: OrgId,
        ceremony_id: Uuid,
        credential: RegisterPublicKeyCredential,
        now: OffsetDateTime,
    ) -> Result<StoredPasskey, AuthError> {
        // The caller is AUTHENTICATED: `org` comes from the verified JWT's `org`
        // claim (never read from a user row under RLS — chicken-and-egg). Arm the
        // tenant GUC for this transaction so the FORCE-RLS WITH CHECK on
        // `auth_webauthn_credentials` (migration 0035) accepts the passkey INSERT
        // stamped with THIS org, and the consume of the bootstrap credential in
        // the same caller transaction also passes.
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org.as_uuid().to_string())
            .execute(tx.as_mut())
            .await?;

        // Claim the ceremony atomically: the UPDATE marks it consumed only if it
        // is still unconsumed and unexpired. A racing finish sees 0 rows and is
        // rejected, so one ceremony can never mint two passkeys.
        let claim = claim_ceremony_tx(tx, ceremony_id, "registration", now)
            .await?
            .ok_or_else(|| {
                AuthError::InvalidStoredData("ceremony not found or already consumed".to_owned())
            })?;
        let user_id = claim.user_id.ok_or_else(|| {
            AuthError::InvalidStoredData("registration ceremony missing user_id".to_owned())
        })?;

        // Verify the assertion AFTER the atomic claim using the RETURNING state.
        // On verification failure we return Err, so the transaction rolls back and
        // the claim is undone — a legitimate retry stays possible.
        let state: PasskeyRegistration = serde_json::from_value(claim.state_json)?;
        let passkey = self
            .webauthn
            .finish_passkey_registration(&credential, &state)?;
        let passkey_json = serde_json::to_value(&passkey)?;
        let credential_id = serialize_to_string(passkey.cred_id(), "passkey credential id")?;
        let passkey_id = Uuid::new_v4();

        sqlx::query(
            r#"
            INSERT INTO auth_webauthn_credentials (
                id, user_id, credential_id, passkey_json, created_at, org_id
            ) VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(passkey_id)
        .bind(user_id)
        .bind(&credential_id)
        .bind(passkey_json)
        .bind(now)
        .bind(*org.as_uuid())
        .execute(tx.as_mut())
        .await?;

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
        insert_audit_event(tx, &audit).await?;

        Ok(StoredPasskey {
            id: passkey_id,
            user_id,
            credential_id,
        })
    }

    /// Start a usernameless (discoverable) authentication ceremony.
    ///
    /// The challenge carries an EMPTY `allowCredentials` list: the client
    /// discovers the resident credential to use without the server naming a user.
    /// The persisted ceremony has a NULL `user_id` because the asserting user is
    /// only known once the client returns the credential at finish time.
    pub async fn start_authentication(
        &self,
        pool: &PgPool,
    ) -> Result<AuthenticationCeremony, AuthError> {
        let (challenge, state) = self.webauthn.start_discoverable_authentication()?;
        let ceremony_id = Uuid::new_v4();
        let now = OffsetDateTime::now_utc();
        let expires_at = now + self.ceremony_ttl;

        persist_ceremony(
            pool,
            ceremony_id,
            None,
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

    /// Finish a usernameless (discoverable) authentication ceremony.
    ///
    /// The user is resolved FROM the asserted credential — by credential id,
    /// which is unique per credential and always present in the assertion — so no
    /// `user_id` is required from the client. When the authenticator returns a
    /// user handle (a true resident key), it is cross-checked against the
    /// resolved credential's owner. The atomic single-use ceremony claim from the
    /// harden-1 fix is preserved verbatim, so a replayed ceremony is rejected.
    pub async fn finish_authentication(
        &self,
        pool: &PgPool,
        ceremony_id: Uuid,
        credential: PublicKeyCredential,
    ) -> Result<AuthenticationOutcome, AuthError> {
        let now = OffsetDateTime::now_utc();
        let mut tx = pool.begin().await?;

        // Claim the ceremony atomically inside the consuming transaction. A racing
        // finish sees 0 rows and is rejected, so one authentication ceremony can
        // never mint two token pairs.
        let claim = claim_ceremony_tx(&mut tx, ceremony_id, "authentication", now)
            .await?
            .ok_or_else(|| {
                AuthError::InvalidStoredData("ceremony not found or already consumed".to_owned())
            })?;

        // Resolve the asserting user FROM the credential. The credential id is the
        // stable lookup key (unique in `auth_webauthn_credentials`); it is always
        // present in the assertion even when the authenticator omits the user
        // handle. `raw_id` is the same `Base64UrlSafeData` type stored at
        // registration (`passkey.cred_id()`), so it serializes to the identical
        // base64url string the credential row is keyed by. If a user handle IS
        // present we additionally require it to match the credential's owner.
        let credential_id =
            serialize_to_string(&credential.raw_id, "authentication credential id")?;

        // Resolve the credential's tenant from its credential id FIRST, then arm
        // the GUC, THEN do the RLS-gated read/update. `auth_webauthn_credentials`
        // is FORCE RLS (migration 0035), so as the non-owner `mnt_rt` role a
        // lookup-by-credential-id returns ZERO rows until `app.current_org` is set
        // — but the org is what we need to set it. The narrow SECURITY DEFINER
        // resolver `platform_resolve_credential_org` (migration 0038) returns only
        // the credential's org_id, breaking that chicken-and-egg so passkey login
        // works for ANY tenant. A NULL means the credential is unknown: keep the
        // existing "not registered" error.
        let Some(org_uuid) = resolve_credential_org(&mut tx, &credential_id).await? else {
            return Err(AuthError::InvalidStoredData(
                "asserted credential is not registered".to_owned(),
            ));
        };
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_uuid.to_string())
            .execute(tx.as_mut())
            .await?;

        let row = sqlx::query(
            r#"
            SELECT id, user_id, passkey_json
            FROM auth_webauthn_credentials
            WHERE credential_id = $1
            "#,
        )
        .bind(&credential_id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| {
            AuthError::InvalidStoredData("asserted credential is not registered".to_owned())
        })?;
        let passkey_id: Uuid = row.try_get("id")?;
        let user_id: Uuid = row.try_get("user_id")?;
        let passkey_json: serde_json::Value = row.try_get("passkey_json")?;

        if let Some(asserted_handle) = credential.get_user_unique_id()
            && Uuid::from_slice(asserted_handle).ok() != Some(user_id)
        {
            return Err(AuthError::InvalidStoredData(
                "asserted user handle does not match the credential owner".to_owned(),
            ));
        }

        // Verify the assertion AFTER the atomic claim using the RETURNING state
        // and the resolved credential as the single allowed discoverable key. A
        // verification failure returns Err and rolls back the claim.
        let state: DiscoverableAuthentication = serde_json::from_value(claim.state_json)?;
        let mut passkey: Passkey = serde_json::from_value(passkey_json)?;
        let discoverable_key = DiscoverableKey::from(&passkey);
        let result = self.webauthn.finish_discoverable_authentication(
            &credential,
            state,
            &[discoverable_key],
        )?;
        let changed = passkey.update_credential(&result).unwrap_or(false);

        if changed {
            sqlx::query(
                r#"
                UPDATE auth_webauthn_credentials
                SET passkey_json = $1, last_used_at = $2
                WHERE id = $3
                "#,
            )
            .bind(serde_json::to_value(&passkey)?)
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

        tx.commit().await?;

        Ok(AuthenticationOutcome {
            user_id,
            passkey_id,
            org_id: OrgId::from_uuid(org_uuid),
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
    // rls-arming: ok auth_webauthn_ceremonies is a global pre-auth table (no org_id, no RLS)
    .execute(pool)
    .await?;
    Ok(())
}

/// Atomically claim a ceremony inside the consuming transaction.
///
/// The `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() RETURNING`
/// both checks the single-use/expiry invariant and marks the ceremony consumed
/// in one statement. Concurrent finish requests race on this row: exactly one
/// matches and consumes it; the loser matches 0 rows and gets `Ok(None)`, which
/// callers translate into a rejection. Because the claim lives in the caller's
/// transaction, returning `Err` later (e.g. on assertion-verification failure)
/// rolls the claim back, so a committed success is the only permanent consume.
async fn claim_ceremony_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    kind: &str,
    now: OffsetDateTime,
) -> Result<Option<CeremonyRow>, AuthError> {
    let row = sqlx::query(
        r#"
        UPDATE auth_webauthn_ceremonies
        SET consumed_at = $3
        WHERE id = $1
          AND ceremony_kind = $2
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING user_id, state_json
        "#,
    )
    .bind(id)
    .bind(kind)
    .bind(now)
    .fetch_optional(tx.as_mut())
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    Ok(Some(CeremonyRow {
        user_id: row.try_get("user_id")?,
        state_json: row.try_get("state_json")?,
    }))
}

async fn insert_mobile_step_up_binding_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ceremony_id: Uuid,
    binding: &MobilePasskeyStepUpBinding,
) -> Result<(), AuthError> {
    sqlx::query(
        r#"
        INSERT INTO auth_webauthn_ceremony_bindings (
            ceremony_id, action_kind, object_id, reason_key, replay_attempt
        ) VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(ceremony_id)
    .bind(binding.action_kind.as_wire())
    .bind(binding.object_id)
    .bind(&binding.reason_key)
    .bind(binding.replay_attempt)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

async fn load_mobile_step_up_binding_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ceremony_id: Uuid,
) -> Result<Option<MobilePasskeyStepUpBinding>, AuthError> {
    let row = sqlx::query(
        r#"
        SELECT action_kind, object_id, reason_key, replay_attempt
        FROM auth_webauthn_ceremony_bindings
        WHERE ceremony_id = $1
        "#,
    )
    .bind(ceremony_id)
    .fetch_optional(tx.as_mut())
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    let action_kind: String = row.try_get("action_kind")?;
    Ok(Some(MobilePasskeyStepUpBinding {
        action_kind: MobileStepUpActionKind::from_wire(&action_kind)?,
        object_id: row.try_get("object_id")?,
        reason_key: row.try_get("reason_key")?,
        replay_attempt: row.try_get("replay_attempt")?,
    }))
}

/// Resolve a webauthn credential's tenant from its credential id, via the narrow
/// SECURITY DEFINER resolver `platform_resolve_credential_org` (migration 0038).
///
/// `auth_webauthn_credentials` is FORCE RLS, so the app's non-owner `mnt_rt` role
/// cannot read a credential row by credential id until `app.current_org` is armed
/// — but the org is exactly what we need to arm it. This resolver returns ONLY the
/// org_id, breaking that chicken-and-egg without widening any read surface.
/// Returns `None` for an unknown credential id.
async fn resolve_credential_org(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    credential_id: &str,
) -> Result<Option<Uuid>, AuthError> {
    Ok(
        sqlx::query_scalar("SELECT platform_resolve_credential_org($1)")
            .bind(credential_id)
            .fetch_one(tx.as_mut())
            .await?,
    )
}

async fn load_user_passkeys(
    pool: &PgPool,
    org: OrgId,
    user_id: Uuid,
) -> Result<Vec<Passkey>, AuthError> {
    // `auth_webauthn_credentials` is FORCE RLS; arm the tenant GUC for this
    // transaction so the non-owner `mnt_rt` role sees the user's existing
    // passkeys. The org is the authenticated request's verified tenant.
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await?;
    let rows = sqlx::query(
        "SELECT passkey_json FROM auth_webauthn_credentials WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(tx.as_mut())
    .await?;
    tx.commit().await?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mobile_step_up_binding_replay_attempt_is_required_but_nullable() {
        let object_id = Uuid::nil();
        let missing_replay_attempt = json!({
            "action_kind": "APPROVAL_DECISION",
            "object_id": object_id,
            "reason_key": "operations_passkey_approval_decision"
        });

        let error = serde_json::from_value::<MobilePasskeyStepUpBinding>(missing_replay_attempt)
            .expect_err("replay_attempt must be present, even when null");
        assert!(error.to_string().contains("replay_attempt"));

        let online_binding: MobilePasskeyStepUpBinding = serde_json::from_value(json!({
            "action_kind": "APPROVAL_DECISION",
            "object_id": object_id,
            "reason_key": "operations_passkey_approval_decision",
            "replay_attempt": null
        }))
        .unwrap();
        assert_eq!(online_binding.replay_attempt, None);

        let replay_binding: MobilePasskeyStepUpBinding = serde_json::from_value(json!({
            "action_kind": "POLL_VOTE",
            "object_id": object_id,
            "reason_key": "operations_passkey_poll_vote",
            "replay_attempt": 1
        }))
        .unwrap();
        assert_eq!(replay_binding.replay_attempt, Some(1));
    }

    #[test]
    fn mobile_step_up_binding_rejects_zero_replay_attempt() {
        let binding: MobilePasskeyStepUpBinding = serde_json::from_value(json!({
            "action_kind": "APPROVAL_DECISION",
            "object_id": Uuid::nil(),
            "reason_key": "operations_passkey_approval_decision",
            "replay_attempt": 0
        }))
        .unwrap();

        assert!(matches!(
            binding.validate(),
            Err(MobileStepUpBindingError::InvalidReplayAttempt)
        ));
    }
}
