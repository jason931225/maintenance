#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_kernel_core::{BranchId, OrgId, UserId};
use mnt_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use time::{Duration, OffsetDateTime};

#[test]
fn es256_access_token_round_trips_with_expected_claims() {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();

    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: "mnt-platform-auth".to_owned(),
            audience: "mnt-api".to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        private_pem.as_bytes(),
        public_pem.as_bytes(),
    )
    .unwrap();

    let user_id = UserId::new();
    let branch_id = BranchId::new();
    let now = OffsetDateTime::now_utc();

    let token = issuer
        .issue_access_token(AccessTokenInput {
            subject: user_id,
            org_id: OrgId::knl(),
            roles: vec!["MECHANIC".to_owned()],
            branches: vec![branch_id],
            platform: false,
            view_as: false,
            read_only: false,
            display_name: None,
            issued_at: now,
        })
        .unwrap();

    let claims = issuer.verify_access_token(&token).unwrap();

    assert_eq!(claims.sub, user_id.to_string());
    assert_eq!(claims.iss, "mnt-platform-auth");
    assert_eq!(claims.aud, "mnt-api");
    assert_eq!(claims.roles, vec!["MECHANIC"]);
    assert_eq!(claims.branches, vec![branch_id.to_string()]);
    assert_eq!(claims.iat, now.unix_timestamp());
    assert_eq!(claims.nbf, now.unix_timestamp());
    assert_eq!(claims.exp, (now + Duration::minutes(15)).unix_timestamp());
    assert_eq!(claims.alg, "ES256");
    // No display name supplied -> the optional `name` claim is absent.
    assert_eq!(claims.name, None);
}

#[test]
fn es256_access_token_carries_optional_display_name_claim() {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();

    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: "mnt-platform-auth".to_owned(),
            audience: "mnt-api".to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        private_pem.as_bytes(),
        public_pem.as_bytes(),
    )
    .unwrap();

    let token = issuer
        .issue_access_token(AccessTokenInput {
            subject: UserId::new(),
            org_id: OrgId::knl(),
            roles: vec!["ADMIN".to_owned()],
            branches: vec![],
            platform: false,
            view_as: false,
            read_only: false,
            display_name: Some("홍길동".to_owned()),
            issued_at: OffsetDateTime::now_utc(),
        })
        .unwrap();

    // The display name round-trips in the `name` claim (display only; the
    // verifier never authorizes off it). The round-trip through encode/verify
    // proves the claim is serialized into and parsed back out of the JWT, which
    // is exactly what the web client decodes for the topbar identity.
    let claims = issuer.verify_access_token(&token).unwrap();
    assert_eq!(claims.name.as_deref(), Some("홍길동"));
}
