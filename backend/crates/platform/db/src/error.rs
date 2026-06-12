//! Database-layer error type.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
}
