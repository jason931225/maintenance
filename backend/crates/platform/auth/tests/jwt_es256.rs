#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_kernel_core::{AccessScope, AccessScopeLevel, BranchId, OrgId, ScopeNodeId, UserId};
use mnt_platform_auth::{AccessClaims, AccessTokenInput, JwtIssuer, JwtSettings};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use time::{Duration, OffsetDateTime};

fn es256_issuer() -> JwtIssuer {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();

    JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: "mnt-platform-auth".to_owned(),
            audience: "mnt-api".to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        private_pem.as_bytes(),
        public_pem.as_bytes(),
    )
    .unwrap()
}

#[test]
fn es256_access_token_round_trips_with_expected_claims() {
    let issuer = es256_issuer();

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
    assert_eq!(
        claims.access_scope().unwrap(),
        AccessScope::legacy_org(OrgId::knl())
    );
    assert!(claims.group_roles.is_empty());
}

#[test]
fn es256_access_token_carries_optional_display_name_claim() {
    let issuer = es256_issuer();

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

#[test]
fn es256_access_token_can_carry_group_roles_without_widening_scope() {
    let issuer = es256_issuer();
    let org_id = OrgId::knl();

    let token = issuer
        .issue_access_token_with_group_roles(
            AccessTokenInput {
                subject: UserId::new(),
                org_id,
                roles: vec!["MEMBER".to_owned()],
                branches: vec![],
                platform: false,
                view_as: false,
                read_only: false,
                display_name: None,
                issued_at: OffsetDateTime::now_utc(),
            },
            vec!["GROUP_ADMIN".to_owned()],
        )
        .unwrap();

    let claims = issuer.verify_access_token(&token).unwrap();
    assert_eq!(claims.group_roles, vec!["GROUP_ADMIN"]);
    assert_eq!(
        claims.access_scope().unwrap(),
        AccessScope::legacy_org(org_id),
        "group-role claims are UI hints; backend endpoints re-resolve live grants",
    );
}

#[test]
fn es256_access_token_round_trips_explicit_access_scope_claims() {
    let issuer = es256_issuer();

    let scope = AccessScope::new(
        AccessScopeLevel::Group,
        ScopeNodeId::from_uuid(uuid::Uuid::new_v4()),
    );
    let token = issuer
        .issue_scoped_access_token(
            AccessTokenInput {
                subject: UserId::new(),
                org_id: OrgId::knl(),
                roles: vec!["ADMIN".to_owned()],
                branches: Vec::new(),
                platform: false,
                view_as: false,
                read_only: false,
                display_name: None,
                issued_at: OffsetDateTime::now_utc(),
            },
            scope,
            vec!["group_admin".to_owned()],
        )
        .unwrap();

    let claims = issuer.verify_access_token(&token).unwrap();
    assert_eq!(claims.scope_level, Some(AccessScopeLevel::Group));
    assert_eq!(claims.scope_node, Some(scope.node_id));
    assert_eq!(claims.access_scope().unwrap(), scope);
    assert_eq!(claims.group_roles, vec!["group_admin"]);
}

#[test]
fn es256_view_as_token_refuses_group_roles() {
    let issuer = es256_issuer();

    let err = issuer
        .issue_scoped_access_token(
            AccessTokenInput {
                subject: UserId::new(),
                org_id: OrgId::knl(),
                roles: vec!["ADMIN".to_owned()],
                branches: Vec::new(),
                platform: false,
                view_as: true,
                read_only: true,
                display_name: None,
                issued_at: OffsetDateTime::now_utc(),
            },
            AccessScope::legacy_org(OrgId::knl()),
            vec!["group_admin".to_owned()],
        )
        .unwrap_err();

    assert!(
        err.to_string()
            .contains("view-as tokens cannot carry group roles")
    );
}

#[test]
fn access_scope_claims_must_be_a_complete_pair() {
    let claims = AccessClaims {
        iss: "mnt-platform-auth".to_owned(),
        aud: "mnt-api".to_owned(),
        sub: UserId::new().to_string(),
        iat: 1,
        nbf: 1,
        exp: 2,
        jti: uuid::Uuid::new_v4().to_string(),
        org: OrgId::knl().to_string(),
        roles: Vec::new(),
        branches: Vec::new(),
        platform: false,
        view_as: false,
        read_only: false,
        name: None,
        scope_level: Some(AccessScopeLevel::Org),
        scope_node: None,
        group_roles: Vec::new(),
        alg: "ES256".to_owned(),
    };

    let err = claims.access_scope().unwrap_err();
    assert!(
        err.to_string()
            .contains("scope claims must include both scope_level and scope_node")
    );
}
