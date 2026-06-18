use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use mnt_kernel_core::{BranchId, OrgId, UserId};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use time::Duration;
use uuid::Uuid;

use crate::AuthError;

#[derive(Debug, Clone)]
pub struct JwtSettings {
    pub issuer: String,
    pub audience: String,
    pub access_token_ttl: Duration,
}

#[derive(Debug, Clone)]
pub struct AccessTokenInput {
    pub subject: UserId,
    /// The tenant the authenticated user belongs to. Sourced from
    /// `users.org_id` at issuance — never a hardcoded default — and stamped into
    /// the `org` claim so every downstream request can arm `app.current_org`.
    ///
    /// For a PLATFORM token (`platform = true`) this carries the platform
    /// sentinel [`OrgId::platform`]: a platform principal is NOT tenant-scoped,
    /// so its `org` is a non-tenant marker that can never arm a real tenant's
    /// RLS GUC.
    pub org_id: OrgId,
    pub roles: Vec<String>,
    pub branches: Vec<BranchId>,
    /// `true` marks a SaaS-vendor PLATFORM token (the tier ABOVE all tenants).
    /// A platform token is rejected on tenant `/api/*` routes, and a tenant
    /// token is rejected on `/platform/*` — the two tiers are strictly
    /// separated. Tenant tokens always set this `false`.
    pub platform: bool,
    pub issued_at: time::OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub iat: i64,
    pub nbf: i64,
    pub exp: i64,
    pub jti: String,
    /// The user's tenant id, as a UUID string. Verification rejects a token
    /// whose `org` does not parse as a UUID, so callers can trust it. On a
    /// PLATFORM token this is the platform sentinel [`OrgId::platform`].
    pub org: String,
    pub roles: Vec<String>,
    pub branches: Vec<String>,
    /// `true` for a SaaS-vendor PLATFORM token (cross-tenant, NOT tenant-scoped).
    /// Absent in legacy tokens → defaults to `false` (a tenant token), so old
    /// tenant tokens keep their exact meaning and can never be mistaken for a
    /// platform token.
    #[serde(default)]
    pub platform: bool,
    pub alg: String,
}

#[derive(Clone)]
pub struct JwtIssuer {
    settings: JwtSettings,
    encoding_key: EncodingKey,
    decoding_key: DecodingKey,
}

#[derive(Clone, Debug)]
pub struct JwtVerifier {
    settings: JwtSettings,
    decoding_key: DecodingKey,
}

impl JwtIssuer {
    pub fn from_es256_pem(
        settings: JwtSettings,
        private_key_pem: &[u8],
        public_key_pem: &[u8],
    ) -> Result<Self, AuthError> {
        Ok(Self {
            settings,
            encoding_key: EncodingKey::from_ec_pem(private_key_pem)?,
            decoding_key: DecodingKey::from_ec_pem(public_key_pem)?,
        })
    }

    pub fn issue_access_token(&self, input: AccessTokenInput) -> Result<String, AuthError> {
        let issued_at = input.issued_at.unix_timestamp();
        let expires_at = (input.issued_at + self.settings.access_token_ttl).unix_timestamp();
        let claims = AccessClaims {
            iss: self.settings.issuer.clone(),
            aud: self.settings.audience.clone(),
            sub: input.subject.to_string(),
            iat: issued_at,
            nbf: issued_at,
            exp: expires_at,
            jti: Uuid::new_v4().to_string(),
            org: input.org_id.to_string(),
            roles: input.roles,
            branches: input
                .branches
                .into_iter()
                .map(|branch| branch.to_string())
                .collect(),
            platform: input.platform,
            alg: "ES256".to_owned(),
        };

        Ok(encode(
            &Header::new(Algorithm::ES256),
            &claims,
            &self.encoding_key,
        )?)
    }

    pub fn verify_access_token(&self, token: &str) -> Result<AccessClaims, AuthError> {
        verify_access_token(token, &self.decoding_key, &self.settings)
    }
}

impl JwtVerifier {
    pub fn from_es256_public_pem(
        settings: JwtSettings,
        public_key_pem: &[u8],
    ) -> Result<Self, AuthError> {
        Ok(Self {
            settings,
            decoding_key: DecodingKey::from_ec_pem(public_key_pem)?,
        })
    }

    pub fn verify_access_token(&self, token: &str) -> Result<AccessClaims, AuthError> {
        verify_access_token(token, &self.decoding_key, &self.settings)
    }
}

fn verify_access_token(
    token: &str,
    decoding_key: &DecodingKey,
    settings: &JwtSettings,
) -> Result<AccessClaims, AuthError> {
    let mut validation = Validation::new(Algorithm::ES256);
    validation.set_issuer(&[settings.issuer.as_str()]);
    validation.set_audience(&[settings.audience.as_str()]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let token = decode::<AccessClaims>(token, decoding_key, &validation)?;
    // Fail closed on a malformed tenant claim: the `org` claim arms
    // `app.current_org` for RLS, so a token whose `org` is not a valid UUID must
    // never be accepted — it could otherwise reach the DB with an unparseable or
    // empty tenant context.
    OrgId::from_str(&token.claims.org).map_err(|_| {
        AuthError::InvalidStoredData("token org claim is not a valid uuid".to_owned())
    })?;
    Ok(token.claims)
}
