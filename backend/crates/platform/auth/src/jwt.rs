use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use mnt_kernel_core::{BranchId, UserId};
use serde::{Deserialize, Serialize};
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
    pub roles: Vec<String>,
    pub branches: Vec<BranchId>,
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
    pub roles: Vec<String>,
    pub branches: Vec<String>,
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
            roles: input.roles,
            branches: input
                .branches
                .into_iter()
                .map(|branch| branch.to_string())
                .collect(),
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
    Ok(token.claims)
}
