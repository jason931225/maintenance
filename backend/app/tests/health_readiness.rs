use std::time::Duration;

use axum::body::Body;
use http::{Request, StatusCode};
use mnt_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

#[tokio::test]
async fn healthz_reports_process_liveness_and_role() -> Result<(), Box<dyn std::error::Error>> {
    let config = app_config(AppRole::Api)?;
    let state = AppState::new(config, DatabaseDependency::NotConfigured)?;
    let response = build_router(state)
        .oneshot(Request::builder().uri("/healthz").body(Body::empty())?)
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn readyz_is_ready_without_configured_dependencies() -> Result<(), Box<dyn std::error::Error>>
{
    let config = app_config(AppRole::Worker)?;
    let state = AppState::new(config, DatabaseDependency::NotConfigured)?;
    let response = build_router(state)
        .oneshot(Request::builder().uri("/readyz").body(Body::empty())?)
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn readyz_returns_503_when_configured_database_is_unreachable()
-> Result<(), Box<dyn std::error::Error>> {
    let config = app_config(AppRole::Api)?;
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_millis(100))
        .connect_lazy("postgres://mnt_app:wrong@127.0.0.1:1/mnt_missing")?;
    let state = AppState::new(config, DatabaseDependency::Postgres(pool))?;
    let response = build_router(state)
        .oneshot(Request::builder().uri("/readyz").body(Body::empty())?)
        .await?;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    Ok(())
}

fn app_config(role: AppRole) -> Result<AppConfig, mnt_app::AppError> {
    AppConfig::from_pairs([
        ("MNT_APP_ROLE", role.to_string()),
        ("MNT_HTTP_ADDR", "127.0.0.1:0".to_owned()),
    ])
}
