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
    /// PLATFORM "view as" impersonation marker. When `true` this is a short-lived
    /// token minted by a platform operator to view a tenant strictly READ-ONLY.
    /// It is a TENANT-tier token (`platform = false`, `org_id = acting tenant`),
    /// so it flows through the tenant org middleware and arms `app.current_org`
    /// to the target tenant — but the blanket read-only method gate rejects every
    /// non-GET/HEAD request that carries it. An ordinary token always sets this
    /// `false`.
    pub view_as: bool,
    /// Companion to [`Self::view_as`]: the impersonation token is read-only. Kept
    /// as a distinct flag (not implied by `view_as`) so the read-only contract is
    /// explicit in the token and a future non-read-only impersonation mode would
    /// be an additive change, never a silent reinterpretation.
    pub read_only: bool,
    /// The authenticated user's display name, stamped into the optional `name`
    /// claim for DISPLAY ONLY (topbar identity, etc.). Never consulted for
    /// authorization. `None` omits the claim entirely, which keeps view-as and
    /// any future operator-less mint backward compatible.
    pub display_name: Option<String>,
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
    /// `true` for a PLATFORM "view as" impersonation token (read-only tenant
    /// view minted by a platform operator). Absent in every ordinary token →
    /// defaults to `false`, so a normal tenant/platform token is never mistaken
    /// for an impersonation token. The read-only method gate keys off this flag.
    #[serde(default)]
    pub view_as: bool,
    /// `true` when the `view_as` token is read-only. Defaults to `false` when
    /// absent. Today every `view_as` token sets this `true`; it is a separate,
    /// explicit claim so the read-only contract is self-describing.
    #[serde(default)]
    pub read_only: bool,
    /// The user's display name, for DISPLAY ONLY (e.g. the topbar identity).
    /// Optional and never used for authorization. Absent in legacy tokens and
    /// omitted from the wire when `None`, so old tokens remain valid verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
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
        self.issue_access_token_with_ttl(input, self.settings.access_token_ttl)
    }

    /// Mint an access token with an EXPLICIT lifetime, overriding the issuer's
    /// default `access_token_ttl`.
    ///
    /// Used by the PLATFORM "view as" START path, which must mint a deliberately
    /// SHORT-LIVED (≤30 min) impersonation token regardless of the configured
    /// session TTL. `ttl` is clamped to a positive duration; a non-positive value
    /// is treated as a zero-length (immediately-expired) token rather than a
    /// long-lived one, so a misconfiguration fails closed.
    pub fn issue_access_token_with_ttl(
        &self,
        input: AccessTokenInput,
        ttl: Duration,
    ) -> Result<String, AuthError> {
        let ttl = if ttl.is_positive() {
            ttl
        } else {
            Duration::ZERO
        };
        let issued_at = input.issued_at.unix_timestamp();
        let expires_at = (input.issued_at + ttl).unix_timestamp();
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
            view_as: input.view_as,
            read_only: input.read_only,
            name: input.display_name,
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
