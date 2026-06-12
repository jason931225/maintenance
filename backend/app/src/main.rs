use mnt_app::{AppConfig, AppState, init_tracing, serve};

#[tokio::main]
async fn main() -> Result<(), mnt_app::AppError> {
    let config = AppConfig::from_env()?;
    let telemetry = init_tracing(&config)?;
    let state = AppState::from_config(config.clone()).await?;
    let result = serve(config, state).await;
    telemetry.shutdown();
    result
}
