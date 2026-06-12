use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use mnt_platform_auth_rest::AUTH_ROUTE_PATHS;
use mnt_workorder_rest::MOBILE_ROUTE_PATHS;
use tower::ServiceExt;

#[tokio::test]
async fn openapi_yaml_covers_mounted_auth_routes() -> Result<(), Box<dyn std::error::Error>> {
    let config = AppConfig::from_pairs([
        ("MNT_APP_ROLE", AppRole::Api.to_string()),
        ("MNT_HTTP_ADDR", "127.0.0.1:0".to_owned()),
    ])?;
    let state = AppState::new(config, DatabaseDependency::NotConfigured)?;

    let response = build_router(state)
        .oneshot(
            Request::builder()
                .uri("/openapi/openapi.yaml")
                .body(Body::empty())?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    let yaml = String::from_utf8(body.to_vec())?;
    for path in AUTH_ROUTE_PATHS {
        assert!(yaml.contains(path), "OpenAPI YAML is missing {path}");
    }
    for path in MOBILE_ROUTE_PATHS {
        assert!(yaml.contains(path), "OpenAPI YAML is missing {path}");
    }
    Ok(())
}
