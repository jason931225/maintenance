//! Messenger domain.
//!
//! Pure value objects and enum wire contracts only. Persistence, audit, REST,
//! and realtime delivery live in outer layers.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::KernelError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadKind {
    WorkOrder,
    Team,
    Dm,
    Group,
}

impl ThreadKind {
    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::WorkOrder => "work_order",
            Self::Team => "team",
            Self::Dm => "dm",
            Self::Group => "group",
        }
    }

    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        match value {
            "work_order" => Ok(Self::WorkOrder),
            "team" => Ok(Self::Team),
            "dm" => Ok(Self::Dm),
            "group" => Ok(Self::Group),
            other => Err(KernelError::validation(format!(
                "unknown messenger thread kind {other:?}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MessageBody(String);

impl MessageBody {
    pub fn new(value: impl Into<String>) -> Result<Self, KernelError> {
        let value = value.into();
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(KernelError::validation("message body is required"));
        }
        Ok(Self(trimmed.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
