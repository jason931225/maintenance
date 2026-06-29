#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_kernel_core::{BranchId, OrgId, UserId};
use mnt_platform_provisioning::BootstrapCredentialStore;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;
use webauthn_authenticator_rs::prelude::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_rs::prelude::{CreationChallengeResponse, RequestChallengeResponse};

const TEST_ISSUER: &str = "mnt-platform-auth";
const TEST_AUDIENCE: &str = "mnt-api";
const TEST_ORIGIN: &str = "https://auth.example.com";

#[derive(Debug, Deserialize)]
struct RegisterStartResponse {
    ceremony_id: Uuid,
    challenge: CreationChallengeResponse,
}

#[derive(Debug, Deserialize)]
struct RegisterFinishResponse {
    credential_id: String,
}

#[derive(Debug, Deserialize)]
struct LoginStartResponse {
    ceremony_id: Uuid,
    challenge: RequestChallengeResponse,
}

#[derive(Debug, Deserialize)]
struct TokenPairResponse {
    access_token: String,
    /// Present (body transport, mobile) or null (cookie transport, web).
    refresh_token: Option<String>,
    #[serde(default)]
    requires_passkey_setup: bool,
}

#[derive(Debug, Deserialize)]
struct DeviceLoginStartResponse {
    approve_url: String,
}

#[derive(Debug, Deserialize)]
struct OtpRedeemResponse {
    access_token: String,
    /// Present (body transport, mobile) or null (cookie transport, web).
    refresh_token: Option<String>,
    requires_passkey_setup: bool,
}

#[derive(Debug, Deserialize)]
struct AdminIssueOtpResponse {
    otp: String,
    user_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct AdminCredentialResetResponse {
    otp: String,
    user_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct PrivacyConsentStatusResponse {
    policy_version: String,
    accepted: bool,
    #[serde(with = "time::serde::rfc3339::option")]
    accepted_at: Option<OffsetDateTime>,
}

/// End-to-end: an admin issues a one-time code; the new user signs in for the
/// FIRST time by redeeming it (minting a session, flagged for passkey setup),
/// enrolls a passkey from that authenticated session, and then signs in again
/// usernamelessly (discoverable) with no user_id. Refresh reuse still revokes the
/// family.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn otp_first_signin_then_passkey_enrollment_then_usernameless_login(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Auth Region", "Auth Branch").await;
    // The admin who issues codes.
    let admin_id =
        seed_user_with_branch(&pool, "Branch Admin", "010-4000-0000", "ADMIN", branch_id).await;
    // The pre-provisioned new user who will do their first sign-in via OTP.
    let new_user_id =
        seed_user_with_branch(&pool, "New User", "010-4000-0001", "MECHANIC", branch_id).await;
    seed_equipment(&pool, branch_id, "290").await;

    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    // The admin first signs in (cold start in this test uses a directly-issued
    // OTP for the admin) and enrolls a passkey so it can call admin endpoints.
    let admin_access = admin_session_via_otp(&service, &pool, admin_id).await;

    // Admin issues a one-time code for the new user.
    let issued: AdminIssueOtpResponse = post_json(
        service.clone(),
        "/api/v1/auth/admin/otp/issue",
        Some(&admin_access),
        json!({ "user_id": new_user_id.as_uuid(), "branch_id": branch_id }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(&issued.user_id, new_user_id.as_uuid());
    assert_eq!(issued.otp.chars().count(), 8, "issued OTP must be 8 chars");

    // FIRST SIGN-IN: the new user redeems the OTP -> session + setup flag.
    let redeem: OtpRedeemResponse = post_json(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issued.otp }),
        StatusCode::OK,
    )
    .await;
    assert!(
        redeem.requires_passkey_setup,
        "a zero-passkey user must be flagged for passkey setup"
    );
    assert!(
        !redeem.access_token.is_empty()
            && redeem
                .refresh_token
                .as_ref()
                .is_some_and(|token| !token.is_empty()),
        "an OTP redeem is a first sign-in: it must mint a full session (access + refresh tokens)"
    );

    // INITIAL SETTINGS: the OTP-signed-in user enrolls a passkey via the
    // authenticated register path (no bootstrap token).
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential_id = enroll_passkey(&service, &mut authenticator, &redeem.access_token).await;

    // A second OTP redeem is rejected: single-use.
    let replay = post_raw(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issued.otp }),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

    // USERNAMELESS SIGN-IN: no user_id, discoverable assertion -> token pair.
    let first_tokens = usernameless_login(&service, &mut authenticator, &credential_id).await;
    let work_order: Value = post_json(
        service.clone(),
        "/api/work-orders",
        Some(&first_tokens.access_token),
        json!({
            "branch_id": branch_id,
            "management_no": "#290",
            "symptom": "Hydraulic oil leak"
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(work_order["status"], "RECEIVED");

    // Refresh rotation + reuse-detection still holds (mobile/body transport).
    let first_refresh = first_tokens
        .refresh_token
        .clone()
        .expect("body-transport login must return a refresh token");
    let rotated: TokenPairResponse = post_json(
        service.clone(),
        "/api/v1/auth/token/refresh",
        None,
        json!({ "refresh_token": first_refresh }),
        StatusCode::OK,
    )
    .await;
    assert_ne!(rotated.refresh_token, first_tokens.refresh_token);

    let reuse = post_raw(
        service.clone(),
        "/api/v1/auth/token/refresh",
        None,
        json!({ "refresh_token": first_refresh }),
    )
    .await;
    assert_eq!(reuse.status(), StatusCode::UNAUTHORIZED);

    assert_audit_count(&pool, "auth.otp.signin", 2).await; // admin + new user
    assert_audit_count(&pool, "auth.login", 1).await; // usernameless login
}

/// Regression for desktop/phone onboarding: a zero-passkey user can refresh the
/// OTP-minted session before enrollment completes. Refresh must keep carrying the
/// setup flag, otherwise a hard reload recreates a normal session and lets the
/// user into the app without registering a passkey.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn refresh_keeps_zero_passkey_user_in_setup_mode_until_enrolled(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Refresh Setup Region", "Refresh Setup Branch").await;
    let user_id = seed_user_with_branch(
        &pool,
        "Refresh Setup User",
        "010-4090-0001",
        "MECHANIC",
        branch_id,
    )
    .await;
    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            *user_id.as_uuid(),
            OrgId::knl(),
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await
        .unwrap();
    let redeem: OtpRedeemResponse = post_json(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issue.token.as_str() }),
        StatusCode::OK,
    )
    .await;
    assert!(redeem.requires_passkey_setup);

    let refresh_token = redeem
        .refresh_token
        .clone()
        .expect("body transport must return refresh token");
    let refreshed: TokenPairResponse = post_json(
        service.clone(),
        "/api/v1/auth/token/refresh",
        None,
        json!({ "refresh_token": refresh_token }),
        StatusCode::OK,
    )
    .await;
    assert!(
        refreshed.requires_passkey_setup,
        "refresh before enrollment must keep the client locked on passkey setup"
    );

    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    enroll_passkey(&service, &mut authenticator, &refreshed.access_token).await;
    let post_enrollment_refresh = refreshed
        .refresh_token
        .clone()
        .expect("rotated body refresh token must be returned");
    let refreshed_after_enrollment: TokenPairResponse = post_json(
        service.clone(),
        "/api/v1/auth/token/refresh",
        None,
        json!({ "refresh_token": post_enrollment_refresh }),
        StatusCode::OK,
    )
    .await;
    assert!(
        !refreshed_after_enrollment.requires_passkey_setup,
        "refresh after successful passkey enrollment should clear the setup flag"
    );
}

/// `/device-login/approve-session` is only for the first-enrollment QR path,
/// where the desktop handoff is pinned to the OTP user/org. Generic desktop QR
/// logins must still require a fresh WebAuthn assertion through
/// `/device-login/approve`; a normal bearer session is not enough.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn approve_session_rejects_generic_desktop_handoff_without_target(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Device QR Region", "Device QR Branch").await;
    let user_id = seed_user_with_branch(
        &pool,
        "Device QR User",
        "010-4090-0002",
        "MECHANIC",
        branch_id,
    )
    .await;
    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            *user_id.as_uuid(),
            OrgId::knl(),
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await
        .unwrap();
    let redeem: OtpRedeemResponse = post_json(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issue.token.as_str() }),
        StatusCode::OK,
    )
    .await;
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    enroll_passkey(&service, &mut authenticator, &redeem.access_token).await;

    let handoff: DeviceLoginStartResponse = post_json(
        service.clone(),
        "/api/v1/auth/device-login/start",
        None,
        json!({}),
        StatusCode::OK,
    )
    .await;
    let approve_url = Url::parse(&handoff.approve_url).unwrap();
    let approve_token = approve_url
        .fragment()
        .and_then(|fragment| {
            url::form_urlencoded::parse(fragment.as_bytes())
                .find(|(key, _)| key == "desktop_approve")
                .map(|(_, value)| value.into_owned())
        })
        .expect("desktop approve token must be in the URL fragment");

    let response = post_raw(
        service.clone(),
        "/api/v1/auth/device-login/approve-session",
        Some(&redeem.access_token),
        json!({ "approve_token": approve_token }),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "generic desktop QR handoffs require a fresh passkey assertion"
    );
}

/// Initial passkey enrollment is gated on separate privacy/data-collection and
/// service-terms agreements. A freshly OTP-authenticated user can read the
/// required version, cannot start enrollment until both required boxes are true,
/// and can proceed after acceptance is recorded.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn first_passkey_enrollment_requires_privacy_terms(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Privacy Region", "Privacy Branch").await;
    let user_id = seed_user_with_branch(
        &pool,
        "Privacy User",
        "010-4050-0001",
        "MECHANIC",
        branch_id,
    )
    .await;
    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            *user_id.as_uuid(),
            OrgId::knl(),
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await
        .unwrap();
    let redeem: OtpRedeemResponse = post_json(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issue.token.as_str() }),
        StatusCode::OK,
    )
    .await;
    assert!(redeem.requires_passkey_setup);

    let initial_status: PrivacyConsentStatusResponse = post_json(
        service.clone(),
        "/api/v1/auth/privacy-consent/status",
        Some(&redeem.access_token),
        json!({}),
        StatusCode::OK,
    )
    .await;
    assert!(!initial_status.accepted);
    assert!(initial_status.accepted_at.is_none());

    let blocked = post_raw(
        service.clone(),
        "/api/v1/auth/passkey/register/start",
        Some(&redeem.access_token),
        json!({ "username": "privacy.user", "display_name": "Privacy User" }),
    )
    .await;
    assert_eq!(blocked.status(), StatusCode::FORBIDDEN);

    let bundled_or_partial_consent = post_raw(
        service.clone(),
        "/api/v1/auth/privacy-consent/accept",
        Some(&redeem.access_token),
        json!({
            "policy_version": initial_status.policy_version,
            "privacy_collection": true,
            "terms_of_service": false
        }),
    )
    .await;
    assert_eq!(bundled_or_partial_consent.status(), StatusCode::BAD_REQUEST);

    let accepted = accept_required_privacy_consent(&service, &redeem.access_token).await;
    assert!(accepted.accepted);
    assert!(accepted.accepted_at.is_some());

    let allowed: RegisterStartResponse = post_json(
        service.clone(),
        "/api/v1/auth/passkey/register/start",
        Some(&redeem.access_token),
        json!({ "username": "privacy.user", "display_name": "Privacy User" }),
        StatusCode::OK,
    )
    .await;
    assert_ne!(allowed.ceremony_id, Uuid::nil());
}

/// The one-time code is consumed on PASSKEY REGISTRATION, not on redeem. A redeem
/// only mints a session, so a failed/incomplete enrollment never burns the code —
/// the user can re-redeem (within the TTL) until a passkey actually sticks. Once a
/// passkey is registered the code is consumed atomically and can never be reused.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn otp_is_consumed_on_passkey_registration_not_on_redeem(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "OTP Region", "OTP Branch").await;
    let admin_id =
        seed_user_with_branch(&pool, "Issuer Admin", "010-4100-0000", "ADMIN", branch_id).await;
    let new_user_id = seed_user_with_branch(
        &pool,
        "Pending User",
        "010-4100-0001",
        "MECHANIC",
        branch_id,
    )
    .await;
    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let admin_access = admin_session_via_otp(&service, &pool, admin_id).await;
    let issued: AdminIssueOtpResponse = post_json(
        service.clone(),
        "/api/v1/auth/admin/otp/issue",
        Some(&admin_access),
        json!({ "user_id": new_user_id.as_uuid(), "branch_id": branch_id }),
        StatusCode::OK,
    )
    .await;

    // First redeem -> session, code NOT consumed.
    let first: OtpRedeemResponse = post_json(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issued.otp }),
        StatusCode::OK,
    )
    .await;
    assert!(first.requires_passkey_setup);

    // Re-redeem BEFORE enrolling a passkey -> STILL succeeds (a failed enrollment
    // must not lock the user out of their own code).
    let second: OtpRedeemResponse = post_json(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issued.otp }),
        StatusCode::OK,
    )
    .await;
    assert!(
        second.requires_passkey_setup,
        "the code must remain redeemable until a passkey is actually registered"
    );

    // Enroll a passkey from the session -> consumes the code atomically with the
    // passkey insert.
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    enroll_passkey(&service, &mut authenticator, &second.access_token).await;

    // Now the code is dead: a further redeem is rejected.
    let after = post_raw(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issued.otp }),
    )
    .await;
    assert_eq!(
        after.status(),
        StatusCode::UNAUTHORIZED,
        "the code is consumed once a passkey is registered"
    );

    // DB: exactly one consumed credential for this user (consumed at enrollment).
    let consumed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM auth_bootstrap_credentials \
         WHERE user_id = $1 AND consumed_at IS NOT NULL",
    )
    .bind(new_user_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(consumed, 1);
}

/// The admin issue-OTP endpoint is authz-gated: a non-admin session is forbidden.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn admin_issue_otp_rejects_non_admin(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "AZ Region", "AZ Branch").await;
    let mechanic_id = seed_user_with_branch(
        &pool,
        "Plain Mechanic",
        "010-5000-0001",
        "MECHANIC",
        branch_id,
    )
    .await;
    let target_id =
        seed_user_with_branch(&pool, "Target User", "010-5000-0002", "MECHANIC", branch_id).await;

    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    // A mechanic signs in via OTP and tries to issue a code -> 403.
    let mechanic_access = admin_session_via_otp(&service, &pool, mechanic_id).await;
    let forbidden = post_raw(
        service.clone(),
        "/api/v1/auth/admin/otp/issue",
        Some(&mechanic_access),
        json!({ "user_id": target_id.as_uuid(), "branch_id": branch_id }),
    )
    .await;
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    // No bearer at all -> 401.
    let unauth = post_raw(
        service,
        "/api/v1/auth/admin/otp/issue",
        None,
        json!({ "user_id": target_id.as_uuid(), "branch_id": branch_id }),
    )
    .await;
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
}

/// IDOR: a branch-A admin must NOT be able to mint a sign-in OTP for a user who
/// belongs only to branch B. Authorization is bound to the TARGET's real branch
/// scope, not the client-supplied branch_id.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn admin_issue_otp_rejects_cross_branch_target(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_a = seed_branch(&pool, "Region A", "Branch A").await;
    let branch_b = seed_branch(&pool, "Region B", "Branch B").await;
    let admin_a = seed_user_with_branch(&pool, "Admin A", "010-6000-0000", "ADMIN", branch_a).await;
    // The target belongs ONLY to branch B.
    let target_b =
        seed_user_with_branch(&pool, "User B", "010-6000-0001", "MECHANIC", branch_b).await;

    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let admin_access = admin_session_via_otp(&service, &pool, admin_a).await;

    // Even when the admin lies and passes its own branch_a as branch_id, the
    // target's REAL scope (branch B) is what is authorized against -> 403.
    let forbidden = post_raw(
        service.clone(),
        "/api/v1/auth/admin/otp/issue",
        Some(&admin_access),
        json!({ "user_id": target_b.as_uuid(), "branch_id": branch_a }),
    )
    .await;
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    // Passing the target's real branch_b also fails — admin A has no authority there.
    let forbidden_real_branch = post_raw(
        service,
        "/api/v1/auth/admin/otp/issue",
        Some(&admin_access),
        json!({ "user_id": target_b.as_uuid(), "branch_id": branch_b }),
    )
    .await;
    assert_eq!(forbidden_real_branch.status(), StatusCode::FORBIDDEN);
}

/// IDOR: a branch admin must NOT be able to mint a sign-in OTP for a privileged
/// (SUPER_ADMIN or EXECUTIVE) target. Only a SUPER_ADMIN caller may do so.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn admin_issue_otp_rejects_privileged_target(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Priv Region", "Priv Branch").await;
    let admin_id =
        seed_user_with_branch(&pool, "Branch Admin", "010-6100-0000", "ADMIN", branch_id).await;
    // A SUPER_ADMIN target that also (incidentally) belongs to the admin's branch.
    let super_admin_target = seed_user_with_branch(
        &pool,
        "Super Admin Target",
        "010-6100-0001",
        "SUPER_ADMIN",
        branch_id,
    )
    .await;
    // An EXECUTIVE target in the same branch.
    let executive_target = seed_user_with_branch(
        &pool,
        "Executive Target",
        "010-6100-0002",
        "EXECUTIVE",
        branch_id,
    )
    .await;

    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let admin_access = admin_session_via_otp(&service, &pool, admin_id).await;

    let super_admin_forbidden = post_raw(
        service.clone(),
        "/api/v1/auth/admin/otp/issue",
        Some(&admin_access),
        json!({ "user_id": super_admin_target.as_uuid(), "branch_id": branch_id }),
    )
    .await;
    assert_eq!(super_admin_forbidden.status(), StatusCode::FORBIDDEN);

    let executive_forbidden = post_raw(
        service,
        "/api/v1/auth/admin/otp/issue",
        Some(&admin_access),
        json!({ "user_id": executive_target.as_uuid(), "branch_id": branch_id }),
    )
    .await;
    assert_eq!(executive_forbidden.status(), StatusCode::FORBIDDEN);
}

/// The happy path still works: a branch admin issues a code for an in-branch
/// subordinate (a non-privileged user whose only branch is the admin's).
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn admin_issue_otp_allows_in_branch_subordinate(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Sub Region", "Sub Branch").await;
    let admin_id =
        seed_user_with_branch(&pool, "Branch Admin", "010-6200-0000", "ADMIN", branch_id).await;
    let subordinate =
        seed_user_with_branch(&pool, "Subordinate", "010-6200-0001", "MECHANIC", branch_id).await;

    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let admin_access = admin_session_via_otp(&service, &pool, admin_id).await;

    let issued: AdminIssueOtpResponse = post_json(
        service,
        "/api/v1/auth/admin/otp/issue",
        Some(&admin_access),
        json!({ "user_id": subordinate.as_uuid(), "branch_id": branch_id }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(&issued.user_id, subordinate.as_uuid());
    assert_eq!(issued.otp.chars().count(), 8);
}

/// Lost-device recovery: a branch admin can reset an in-branch subordinate that
/// already has a passkey. The old passkey is revoked and the fresh one-time code
/// redeems so the user can enroll a replacement device.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn admin_credential_reset_recovers_in_branch_subordinate(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Reset Region", "Reset Branch").await;
    let admin_id =
        seed_user_with_branch(&pool, "Reset Admin", "010-6300-0000", "ADMIN", branch_id).await;
    let subordinate = seed_user_with_branch(
        &pool,
        "Locked Mechanic",
        "010-6300-0001",
        "MECHANIC",
        branch_id,
    )
    .await;
    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let subordinate_access = admin_session_via_otp(&service, &pool, subordinate).await;
    let mut old_authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let old_credential_id =
        enroll_passkey(&service, &mut old_authenticator, &subordinate_access).await;

    let admin_access = admin_session_via_otp(&service, &pool, admin_id).await;
    let reset: AdminCredentialResetResponse = post_json(
        service.clone(),
        "/api/v1/auth/admin/credential-reset",
        Some(&admin_access),
        json!({ "user_id": subordinate.as_uuid() }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(&reset.user_id, subordinate.as_uuid());
    assert_eq!(reset.otp.chars().count(), 8);

    let remaining_passkeys: i64 =
        sqlx::query_scalar("SELECT count(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(subordinate.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(remaining_passkeys, 0);

    let login_start: LoginStartResponse = post_raw(
        service.clone(),
        "/api/v1/auth/passkey/login/start",
        None,
        json!({}),
    )
    .await
    .into_json(StatusCode::OK)
    .await;
    let challenge = inject_allow_credential(login_start.challenge, &old_credential_id);
    let assertion = old_authenticator
        .do_authentication(Url::parse(TEST_ORIGIN).unwrap(), challenge)
        .unwrap();
    let old_passkey_login = post_raw(
        service.clone(),
        "/api/v1/auth/passkey/login/finish",
        None,
        json!({ "ceremony_id": login_start.ceremony_id, "credential": assertion }),
    )
    .await;
    assert_eq!(old_passkey_login.status(), StatusCode::UNAUTHORIZED);

    let recovered: OtpRedeemResponse = post_json(
        service,
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": reset.otp }),
        StatusCode::OK,
    )
    .await;
    assert!(recovered.requires_passkey_setup);
}

/// The DB-backed per-IP rate limit trips a 429 once the window cap is exceeded,
/// even with no device id.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn otp_redeem_rate_limit_trips_429_per_ip(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();

    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    // The per-IP cap is 10/min. The 11th request from the same IP is 429,
    // regardless of OTP validity (wrong OTPs otherwise return 401).
    let mut saw_429 = false;
    for i in 0..12 {
        let response = post_raw_with_ip(
            service.clone(),
            "/api/v1/auth/otp/redeem",
            "203.0.113.7",
            json!({ "otp": "badcode1" }),
        )
        .await;
        if i < 10 {
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "request {i} should be a normal generic rejection, not rate limited"
            );
        } else if response.status() == StatusCode::TOO_MANY_REQUESTS {
            saw_429 = true;
        }
    }
    assert!(
        saw_429,
        "the per-IP rate limit must trip a 429 past the cap"
    );

    // A DIFFERENT IP is unaffected by the first IP's bucket.
    let other_ip = post_raw_with_ip(
        service,
        "/api/v1/auth/otp/redeem",
        "203.0.113.99",
        json!({ "otp": "badcode2" }),
    )
    .await;
    assert_eq!(
        other_ip.status(),
        StatusCode::UNAUTHORIZED,
        "a different IP must have its own bucket"
    );
}

/// WEB dual-transport: when `X-Auth-Transport: cookie` is present, an OTP redeem
/// sets the refresh token as an HttpOnly `mnt_refresh` cookie and OMITS it from
/// the JSON body, while the access token stays in the body. The cookie carries
/// the CSRF-safe attributes (HttpOnly, SameSite=Strict, Path=/api/v1/auth).
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn cookie_mode_redeem_sets_httponly_cookie_and_omits_body_refresh(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Cookie Region", "Cookie Branch").await;
    let user_id =
        seed_user_with_branch(&pool, "Web User", "010-7000-0000", "MECHANIC", branch_id).await;
    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            *user_id.as_uuid(),
            OrgId::knl(),
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await
        .unwrap();

    let response = post_cookie_mode(
        service,
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issue.token.as_str() }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let set_cookie = mnt_refresh_set_cookie(&response)
        .expect("cookie-mode redeem must set an mnt_refresh cookie");
    assert!(set_cookie.contains("HttpOnly"), "{set_cookie}");
    assert!(set_cookie.contains("SameSite=Strict"), "{set_cookie}");
    assert!(set_cookie.contains("Path=/api/v1/auth"), "{set_cookie}");
    assert!(set_cookie.contains("Max-Age="), "{set_cookie}");
    // Local-dev config leaves MNT_COOKIE_SECURE at its default (true) in this
    // test harness, so Secure must be present.
    assert!(set_cookie.contains("Secure"), "{set_cookie}");
    assert!(
        !cookie_token(&set_cookie).is_empty(),
        "cookie must carry the refresh token value"
    );

    let body = body_json(response).await;
    assert!(
        !body["access_token"].as_str().unwrap().is_empty(),
        "access token must always be in the body"
    );
    assert!(
        body["refresh_token"].is_null(),
        "cookie mode must NOT leak the refresh token into the JSON body, got {body}"
    );
}

/// WEB dual-transport: passkey login finish in cookie mode sets the cookie and
/// nulls the body refresh token; the cookie value then authorizes a refresh that
/// reads the token from the cookie (no body token) and rotates the cookie.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn cookie_mode_login_then_refresh_reads_and_rotates_cookie(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Cookie Region", "Cookie Branch").await;
    let user_id =
        seed_user_with_branch(&pool, "Web User", "010-7100-0000", "MECHANIC", branch_id).await;
    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    // First sign-in via OTP (cookie mode) then enroll a passkey so we can do a
    // real cookie-mode passkey login.
    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            *user_id.as_uuid(),
            OrgId::knl(),
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await
        .unwrap();
    let redeem = post_cookie_mode(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issue.token.as_str() }),
    )
    .await;
    assert_eq!(redeem.status(), StatusCode::OK);
    let access_token = body_json(redeem).await["access_token"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential_id = enroll_passkey(&service, &mut authenticator, &access_token).await;

    // Cookie-mode usernameless passkey login -> cookie set, body refresh null.
    let login = cookie_mode_usernameless_login(&service, &mut authenticator, &credential_id).await;
    let login_cookie =
        mnt_refresh_set_cookie(&login).expect("cookie-mode login must set an mnt_refresh cookie");
    let cookie_value = cookie_token(&login_cookie).to_owned();
    let login_body = body_json(login).await;
    assert!(login_body["refresh_token"].is_null());

    // Refresh reading the token from the cookie (NO body token) rotates and sets
    // a fresh cookie whose value differs from the one presented.
    let refreshed = post_cookie_mode(
        service.clone(),
        "/api/v1/auth/token/refresh",
        Some(&cookie_value),
        json!({}),
    )
    .await;
    assert_eq!(refreshed.status(), StatusCode::OK);
    let rotated_cookie = mnt_refresh_set_cookie(&refreshed)
        .expect("cookie-mode refresh must rotate the mnt_refresh cookie");
    let rotated_value = cookie_token(&rotated_cookie).to_owned();
    assert_ne!(
        rotated_value, cookie_value,
        "the refresh token cookie must rotate on use"
    );
    assert!(body_json(refreshed).await["refresh_token"].is_null());

    // Logout in cookie mode clears the cookie (Max-Age=0) and revokes the family,
    // so the rotated cookie can no longer refresh. (Reuse-detection of the old
    // pre-rotation token is covered by the body-transport end-to-end test; here we
    // logout with the LIVE rotated cookie, the one a browser would actually hold.)
    let logout = post_cookie_mode(
        service.clone(),
        "/api/v1/auth/logout",
        Some(&rotated_value),
        json!({}),
    )
    .await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
    let clear_cookie =
        mnt_refresh_set_cookie(&logout).expect("logout must emit a clearing mnt_refresh cookie");
    assert!(clear_cookie.contains("Max-Age=0"), "{clear_cookie}");
    assert!(clear_cookie.contains("Path=/api/v1/auth"), "{clear_cookie}");

    let after_logout = post_cookie_mode(
        service,
        "/api/v1/auth/token/refresh",
        Some(&rotated_value),
        json!({}),
    )
    .await;
    assert_eq!(after_logout.status(), StatusCode::UNAUTHORIZED);
}

/// MOBILE (no transport header) is unchanged: refresh and logout read the token
/// from the request BODY, the response carries the refresh token in the body, and
/// NO Set-Cookie header is emitted.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn body_mode_without_header_is_unchanged_and_sets_no_cookie(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Mobile Region", "Mobile Branch").await;
    let user_id =
        seed_user_with_branch(&pool, "Mobile User", "010-7200-0000", "MECHANIC", branch_id).await;
    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            *user_id.as_uuid(),
            OrgId::knl(),
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await
        .unwrap();

    // Redeem with NO transport header -> body carries the refresh token, no cookie.
    let redeem = post_raw(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issue.token.as_str() }),
    )
    .await;
    assert_eq!(redeem.status(), StatusCode::OK);
    assert!(
        set_cookie_values(&redeem).is_empty(),
        "mobile/body mode must not set any cookie"
    );
    let redeem_body = body_json(redeem).await;
    let refresh_token = redeem_body["refresh_token"]
        .as_str()
        .expect("body mode must return the refresh token in the JSON body")
        .to_owned();

    // Body-mode refresh rotates using the body token and still returns no cookie.
    let refreshed = post_raw(
        service.clone(),
        "/api/v1/auth/token/refresh",
        None,
        json!({ "refresh_token": refresh_token }),
    )
    .await;
    assert_eq!(refreshed.status(), StatusCode::OK);
    assert!(
        set_cookie_values(&refreshed).is_empty(),
        "mobile/body mode refresh must not set any cookie"
    );
    let rotated = body_json(refreshed).await["refresh_token"]
        .as_str()
        .expect("body-mode refresh must return the new refresh token in the body")
        .to_owned();
    assert_ne!(rotated, refresh_token);

    // Body-mode logout accepts the body token and revokes the family.
    let logout = post_raw(
        service.clone(),
        "/api/v1/auth/logout",
        None,
        json!({ "refresh_token": rotated }),
    )
    .await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
    assert!(
        set_cookie_values(&logout).is_empty(),
        "mobile/body mode logout must not set any cookie"
    );
}

// --- helpers ---------------------------------------------------------------

/// Cookie-mode usernameless passkey login: mirrors `usernameless_login` but sends
/// the `X-Auth-Transport: cookie` header so the response carries a Set-Cookie and
/// a null body refresh token. Returns the raw response for header + body asserts.
async fn cookie_mode_usernameless_login(
    service: &axum::Router,
    authenticator: &mut WebauthnAuthenticator<SoftPasskey>,
    credential_id: &str,
) -> http::Response<Body> {
    let start: LoginStartResponse = post_raw(
        service.clone(),
        "/api/v1/auth/passkey/login/start",
        None,
        json!({}),
    )
    .await
    .into_json(StatusCode::OK)
    .await;
    let challenge = inject_allow_credential(start.challenge, credential_id);
    let assertion = authenticator
        .do_authentication(Url::parse(TEST_ORIGIN).unwrap(), challenge)
        .unwrap();
    post_cookie_mode(
        service.clone(),
        "/api/v1/auth/passkey/login/finish",
        None,
        json!({ "ceremony_id": start.ceremony_id, "credential": assertion }),
    )
    .await
}

/// Sign a user in via a directly-issued OTP (used to bootstrap an authenticated
/// session for any role in tests without a pre-existing passkey).
async fn admin_session_via_otp(service: &axum::Router, pool: &PgPool, user_id: UserId) -> String {
    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            pool,
            *user_id.as_uuid(),
            OrgId::knl(),
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await
        .unwrap();
    let redeem: OtpRedeemResponse = post_json(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issue.token.as_str() }),
        StatusCode::OK,
    )
    .await;
    redeem.access_token
}

/// Enroll a passkey and return its credential id (base64url string).
async fn enroll_passkey(
    service: &axum::Router,
    authenticator: &mut WebauthnAuthenticator<SoftPasskey>,
    access_token: &str,
) -> String {
    accept_required_privacy_consent(service, access_token).await;
    let registration: RegisterStartResponse = post_json(
        service.clone(),
        "/api/v1/auth/passkey/register/start",
        Some(access_token),
        json!({ "username": "new.user", "display_name": "New User" }),
        StatusCode::OK,
    )
    .await;
    let credential = authenticator
        .do_registration(Url::parse(TEST_ORIGIN).unwrap(), registration.challenge)
        .unwrap();
    let finish: RegisterFinishResponse = post_json(
        service.clone(),
        "/api/v1/auth/passkey/register/finish",
        Some(access_token),
        json!({ "ceremony_id": registration.ceremony_id, "credential": credential }),
        StatusCode::CREATED,
    )
    .await;
    finish.credential_id
}

async fn accept_required_privacy_consent(
    service: &axum::Router,
    access_token: &str,
) -> PrivacyConsentStatusResponse {
    let status: PrivacyConsentStatusResponse = post_json(
        service.clone(),
        "/api/v1/auth/privacy-consent/status",
        Some(access_token),
        json!({}),
        StatusCode::OK,
    )
    .await;
    if status.accepted {
        return status;
    }

    let accepted: PrivacyConsentStatusResponse = post_json(
        service.clone(),
        "/api/v1/auth/privacy-consent/accept",
        Some(access_token),
        json!({
            "policy_version": status.policy_version,
            "privacy_collection": true,
            "terms_of_service": true
        }),
        StatusCode::OK,
    )
    .await;
    assert!(accepted.accepted);
    assert!(
        accepted.accepted_at.is_some(),
        "accepted consent must record an audit timestamp"
    );
    accepted
}

async fn usernameless_login(
    service: &axum::Router,
    authenticator: &mut WebauthnAuthenticator<SoftPasskey>,
    credential_id: &str,
) -> TokenPairResponse {
    // login/start takes NO body and NO user_id; the server returns a discoverable
    // challenge with an EMPTY allowCredentials list.
    let start: LoginStartResponse = post_raw(
        service.clone(),
        "/api/v1/auth/passkey/login/start",
        None,
        json!({}),
    )
    .await
    .into_json(StatusCode::OK)
    .await;

    // The SoftPasskey harness cannot resolve a resident credential from an empty
    // allowCredentials (it has no resident-key store), so the test injects the
    // known credential id to emulate what a real discoverable authenticator does
    // internally. The SERVER ceremony stays fully discoverable — see the report's
    // SoftPasskey compromise note. The returned assertion still carries the
    // credential id, which is what the server resolves the user by.
    let challenge = inject_allow_credential(start.challenge, credential_id);
    let assertion = authenticator
        .do_authentication(Url::parse(TEST_ORIGIN).unwrap(), challenge)
        .unwrap();

    post_json(
        service.clone(),
        "/api/v1/auth/passkey/login/finish",
        None,
        json!({ "ceremony_id": start.ceremony_id, "credential": assertion }),
        StatusCode::OK,
    )
    .await
}

/// Inject one `allowCredentials` entry into a discoverable challenge so the
/// SoftPasskey harness can locate its key. Emulates resident-credential
/// discovery; production never does this.
fn inject_allow_credential(
    challenge: RequestChallengeResponse,
    credential_id: &str,
) -> RequestChallengeResponse {
    let mut value = serde_json::to_value(&challenge).unwrap();
    let allow = value
        .get_mut("publicKey")
        .and_then(|pk| pk.get_mut("allowCredentials"))
        .and_then(Value::as_array_mut)
        .expect("discoverable challenge must have an allowCredentials array");
    allow.push(json!({ "type": "public-key", "id": credential_id }));
    serde_json::from_value(value).unwrap()
}

trait ResponseExt {
    async fn into_json<T: for<'de> Deserialize<'de>>(self, expected: StatusCode) -> T;
}

impl ResponseExt for http::Response<Body> {
    async fn into_json<T: for<'de> Deserialize<'de>>(self, expected: StatusCode) -> T {
        assert_eq!(self.status(), expected);
        let bytes = to_bytes(self.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
}

async fn post_json<T>(
    service: axum::Router,
    uri: &str,
    bearer: Option<&str>,
    body: Value,
    expected: StatusCode,
) -> T
where
    T: for<'de> Deserialize<'de>,
{
    let response = post_raw(service, uri, bearer, body).await;
    assert_eq!(response.status(), expected);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn post_raw(
    service: axum::Router,
    uri: &str,
    bearer: Option<&str>,
    body: Value,
) -> http::Response<Body> {
    let mut builder = Request::builder()
        .uri(uri)
        .method("POST")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    service
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

async fn post_raw_with_ip(
    service: axum::Router,
    uri: &str,
    ip: &str,
    body: Value,
) -> http::Response<Body> {
    let builder = Request::builder()
        .uri(uri)
        .method("POST")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", ip);
    service
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

/// POST as a WEB client: sends `X-Auth-Transport: cookie` and, optionally, a
/// `Cookie` header carrying `mnt_refresh=<token>` (what a browser would replay).
async fn post_cookie_mode(
    service: axum::Router,
    uri: &str,
    cookie: Option<&str>,
    body: Value,
) -> http::Response<Body> {
    let mut builder = Request::builder()
        .uri(uri)
        .method("POST")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-auth-transport", "cookie");
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, format!("mnt_refresh={cookie}"));
    }
    service
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

/// Collect every `Set-Cookie` header value off a response as owned strings.
fn set_cookie_values(response: &http::Response<Body>) -> Vec<String> {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap().to_owned())
        .collect()
}

/// Find the `mnt_refresh` Set-Cookie attribute string, returning its full
/// directive (e.g. `mnt_refresh=abc; HttpOnly; SameSite=Strict; ...`).
fn mnt_refresh_set_cookie(response: &http::Response<Body>) -> Option<String> {
    set_cookie_values(response)
        .into_iter()
        .find(|value| value.starts_with("mnt_refresh="))
}

/// Pull the cookie's value (the substring between `mnt_refresh=` and the first `;`).
fn cookie_token(set_cookie: &str) -> &str {
    set_cookie
        .strip_prefix("mnt_refresh=")
        .and_then(|rest| rest.split(';').next())
        .unwrap()
}

async fn body_json(response: http::Response<Body>) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn app_state(
    pool: PgPool,
    private_key_pem: String,
    public_key_pem: String,
) -> Result<AppState, mnt_app::AppError> {
    let config = AppConfig::from_pairs([
        ("MNT_APP_ROLE", AppRole::Api.to_string()),
        ("MNT_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("MNT_JWT_ISSUER", TEST_ISSUER.to_owned()),
        ("MNT_JWT_AUDIENCE", TEST_AUDIENCE.to_owned()),
        ("MNT_JWT_PRIVATE_KEY_PEM", private_key_pem),
        ("MNT_JWT_PUBLIC_KEY_PEM", public_key_pem),
        ("MNT_WEBAUTHN_RP_ID", "example.com".to_owned()),
        ("MNT_WEBAUTHN_RP_ORIGIN", TEST_ORIGIN.to_owned()),
        ("MNT_WEBAUTHN_RP_NAME", "MNT Maintenance".to_owned()),
    ])?;

    AppState::new(config, DatabaseDependency::Postgres(pool))
}

async fn seed_branch(pool: &PgPool, region_name: &str, branch_name: &str) -> BranchId {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(region_name)
            .bind(*OrgId::knl().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(branch_name)
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user_with_branch(
    pool: &PgPool,
    display_name: &str,
    phone: &str,
    role: &str,
    branch_id: BranchId,
) -> UserId {
    let user_id = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, phone, roles, org_id) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(*user_id.as_uuid())
    .bind(display_name)
    .bind(phone)
    .bind(Vec::from([role]))
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    user_id
}

async fn seed_equipment(pool: &PgPool, branch_id: BranchId, management_no: &str) {
    let equipment_suffix = format!("{:0>4}", management_no);
    let customer_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(format!("Customer {management_no}"))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    let site_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(format!("Site {management_no}"))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, model, source_sheet, source_row, org_id
        )
        VALUES ($1, $2, $3, $4, $5,
                'A', 'B', 'C', '임대', '좌식', '2.5', 'GTS25DE', 'test', 1, $6)
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(format!("ABC12-{equipment_suffix}"))
    .bind(management_no)
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
}

async fn assert_audit_count(pool: &PgPool, action: &str, expected: i64) {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = $1")
        .bind(action)
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(count, expected, "unexpected audit count for {action}");
}
