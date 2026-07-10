#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency};
use mnt_kernel_core::OrgId;
use mnt_platform_email::StubEmailMode;

fn app_pairs() -> Vec<(&'static str, String)> {
    vec![
        ("MNT_APP_ROLE", AppRole::Api.to_string()),
        ("MNT_HTTP_ADDR", "127.0.0.1:0".to_owned()),
    ]
}

fn complete_smtp_pairs() -> Vec<(&'static str, String)> {
    vec![
        ("MNT_EMAIL_SMTP_HOST", "smtp.example.com".to_owned()),
        ("MNT_EMAIL_SMTP_PORT", "587".to_owned()),
        ("MNT_EMAIL_SMTP_USERNAME", "smtp-user".to_owned()),
        ("MNT_EMAIL_SMTP_PASSWORD", "smtp-password".to_owned()),
        ("MNT_EMAIL_FROM", "no-reply@example.com".to_owned()),
        ("MNT_EMAIL_FROM_NAME", "MNT".to_owned()),
    ]
}

fn partial_smtp_pairs() -> Vec<(&'static str, String)> {
    vec![
        ("MNT_EMAIL_SMTP_HOST", "smtp.example.com".to_owned()),
        ("MNT_EMAIL_SMTP_PORT", "587".to_owned()),
        ("MNT_EMAIL_FROM", "no-reply@example.com".to_owned()),
        ("MNT_EMAIL_FROM_NAME", "MNT".to_owned()),
    ]
}

async fn assert_stub_sender_is_selected(config: AppConfig) {
    let state = AppState::new(config, DatabaseDependency::NotConfigured).unwrap();
    let result = state
        .email_sender()
        .send_otp("ops@example.com", "123456", Duration::from_secs(300))
        .await;

    assert!(
        result.is_ok(),
        "explicit non-production stub mode should select the OTP-logging stub sender"
    );
}

#[test]
fn solapi_credentials_without_approved_template_disable_alimtalk_instead_of_crashing() {
    let mut pairs = app_pairs();
    pairs.extend([
        ("MNT_SOLAPI_API_KEY", "key".to_owned()),
        ("MNT_SOLAPI_API_SECRET", "secret".to_owned()),
        ("MNT_SOLAPI_FROM", "0212345678".to_owned()),
        ("MNT_SOLAPI_PF_ID", "pf".to_owned()),
    ]);
    let config = AppConfig::from_pairs(pairs).unwrap();

    assert!(
        config.solapi.is_none(),
        "Alimtalk leg must stay disabled until Kakao-approved template IDs are configured"
    );
}

#[test]
fn solapi_credentials_with_approved_template_enable_alimtalk() {
    let mut pairs = app_pairs();
    pairs.extend([
        ("MNT_SOLAPI_API_KEY", "key".to_owned()),
        ("MNT_SOLAPI_API_SECRET", "secret".to_owned()),
        ("MNT_SOLAPI_FROM", "0212345678".to_owned()),
        ("MNT_SOLAPI_PF_ID", "pf".to_owned()),
        ("MNT_SOLAPI_TEMPLATE_ID", "KA01TP250612000001".to_owned()),
    ]);
    let config = AppConfig::from_pairs(pairs).unwrap();

    assert_eq!(
        config
            .solapi
            .as_ref()
            .map(|solapi| solapi.template_id.as_str()),
        Some("KA01TP250612000001")
    );
}

#[test]
fn storefront_org_id_drives_public_support_intake_org() {
    let public_org = OrgId::new();
    let mut pairs = app_pairs();
    pairs.push(("STOREFRONT_ORG_ID", public_org.to_string()));
    let config = AppConfig::from_pairs(pairs).unwrap();

    assert_eq!(config.storefront_org, Some(public_org));
}

#[test]
fn invalid_storefront_org_id_is_rejected() {
    let mut pairs = app_pairs();
    pairs.push(("STOREFRONT_ORG_ID", "not-a-uuid".to_owned()));
    let err = AppConfig::from_pairs(pairs).unwrap_err();

    assert!(err.to_string().contains("invalid STOREFRONT_ORG_ID"));
}

#[tokio::test]
async fn no_email_config_in_explicit_dev_mode_selects_stub_sender() {
    let mut pairs = app_pairs();
    pairs.push(("MNT_EMAIL_STUB_MODE", "dev".to_owned()));

    let config = AppConfig::from_pairs(pairs).unwrap();

    assert!(config.email.is_none());
    assert_eq!(config.email_stub_mode, Some(StubEmailMode::Development));
    assert_stub_sender_is_selected(config).await;
}

#[tokio::test]
async fn no_email_config_in_explicit_test_mode_selects_stub_sender() {
    let mut pairs = app_pairs();
    pairs.push(("MNT_EMAIL_STUB_MODE", "test".to_owned()));

    let config = AppConfig::from_pairs(pairs).unwrap();

    assert!(config.email.is_none());
    assert_eq!(config.email_stub_mode, Some(StubEmailMode::Test));
    assert_stub_sender_is_selected(config).await;
}

#[tokio::test]
async fn no_email_config_without_stub_mode_selects_disabled_sender() {
    let config = AppConfig::from_pairs(app_pairs()).unwrap();

    assert!(config.email.is_none());
    assert!(config.email_stub_mode.is_none());

    let state = AppState::new(config, DatabaseDependency::NotConfigured).unwrap();
    let err = state
        .email_sender()
        .send_otp("ops@example.com", "123456", Duration::from_secs(300))
        .await
        .unwrap_err();

    assert!(
        err.to_string().contains("disabled"),
        "missing SMTP without explicit stub mode must fail closed without OTP logging: {err}"
    );
}

#[test]
fn complete_smtp_config_initializes_real_sender_config() {
    let mut pairs = app_pairs();
    pairs.extend(complete_smtp_pairs());

    let config = AppConfig::from_pairs(pairs).unwrap();
    let email = config
        .email
        .as_ref()
        .expect("complete SMTP config should be present");

    assert_eq!(email.host, "smtp.example.com");
    assert_eq!(email.port, 587);
    assert_eq!(email.username, "smtp-user");
    assert_eq!(email.password, "smtp-password");
    assert_eq!(email.from_address, "no-reply@example.com");
    assert_eq!(email.from_name, "MNT");
    assert!(config.email_stub_mode.is_none());
    AppState::new(config, DatabaseDependency::NotConfigured).unwrap();
}

#[test]
fn partial_smtp_config_in_production_like_env_is_rejected() {
    let mut pairs = app_pairs();
    pairs.extend(partial_smtp_pairs());

    let err = AppConfig::from_pairs(pairs).unwrap_err();
    let message = err.to_string();

    assert!(message.contains("MNT_EMAIL_*"), "{message}");
    assert!(message.contains("partially configured"), "{message}");
    assert!(message.contains("MNT_EMAIL_STUB_MODE"), "{message}");
}

#[tokio::test]
async fn partial_smtp_config_in_explicit_e2e_mode_selects_stub_sender() {
    let mut pairs = app_pairs();
    pairs.extend(partial_smtp_pairs());
    pairs.push(("MNT_EMAIL_STUB_MODE", "e2e".to_owned()));

    let config = AppConfig::from_pairs(pairs).unwrap();

    assert!(config.email.is_none());
    assert_eq!(config.email_stub_mode, Some(StubEmailMode::E2e));
    assert_stub_sender_is_selected(config).await;
}

#[test]
fn invalid_email_stub_mode_is_rejected() {
    let mut pairs = app_pairs();
    pairs.push(("MNT_EMAIL_STUB_MODE", "production".to_owned()));

    let err = AppConfig::from_pairs(pairs).unwrap_err();
    let message = err.to_string();

    assert!(message.contains("invalid MNT_EMAIL_STUB_MODE"), "{message}");
    assert!(message.contains("local"), "{message}");
    assert!(message.contains("dev"), "{message}");
    assert!(message.contains("e2e"), "{message}");
    assert!(message.contains("test"), "{message}");
}
