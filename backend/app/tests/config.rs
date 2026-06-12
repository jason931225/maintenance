#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_app::{AppConfig, AppRole};

#[test]
fn solapi_credentials_without_approved_template_disable_alimtalk_instead_of_crashing() {
    let config = AppConfig::from_pairs([
        ("MNT_APP_ROLE", AppRole::Api.to_string()),
        ("MNT_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("MNT_SOLAPI_API_KEY", "key".to_owned()),
        ("MNT_SOLAPI_API_SECRET", "secret".to_owned()),
        ("MNT_SOLAPI_FROM", "0212345678".to_owned()),
        ("MNT_SOLAPI_PF_ID", "pf".to_owned()),
    ])
    .unwrap();

    assert!(
        config.solapi.is_none(),
        "Alimtalk leg must stay disabled until Kakao-approved template IDs are configured"
    );
}

#[test]
fn solapi_credentials_with_approved_template_enable_alimtalk() {
    let config = AppConfig::from_pairs([
        ("MNT_APP_ROLE", AppRole::Api.to_string()),
        ("MNT_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("MNT_SOLAPI_API_KEY", "key".to_owned()),
        ("MNT_SOLAPI_API_SECRET", "secret".to_owned()),
        ("MNT_SOLAPI_FROM", "0212345678".to_owned()),
        ("MNT_SOLAPI_PF_ID", "pf".to_owned()),
        ("MNT_SOLAPI_TEMPLATE_ID", "KA01TP250612000001".to_owned()),
    ])
    .unwrap();

    assert_eq!(
        config
            .solapi
            .as_ref()
            .map(|solapi| solapi.template_id.as_str()),
        Some("KA01TP250612000001")
    );
}
