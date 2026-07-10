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

/// How a thread is offered in the sidebar: `Channel` is a named, branch-scoped
/// room any active branch member can discover and join; `Direct` is a fixed
/// member set (DM, group, work-order auto-thread).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadVisibility {
    Channel,
    Direct,
}

impl ThreadVisibility {
    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::Channel => "channel",
            Self::Direct => "direct",
        }
    }

    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        match value {
            "channel" => Ok(Self::Channel),
            "direct" => Ok(Self::Direct),
            other => Err(KernelError::validation(format!(
                "unknown messenger thread visibility {other:?}"
            ))),
        }
    }

    #[must_use]
    pub const fn default_for(kind: ThreadKind, has_title: bool) -> Self {
        match kind {
            ThreadKind::Team if has_title => Self::Channel,
            _ => Self::Direct,
        }
    }
}

/// Activity-derived presence, derived from the age of the member's last real
/// action (send/read/ack), not from an in-process socket heartbeat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceStatus {
    Online,
    Away,
    Offline,
}

pub const PRESENCE_ONLINE_SECONDS: i64 = 5 * 60;
pub const PRESENCE_AWAY_SECONDS: i64 = 30 * 60;

#[must_use]
pub fn presence_status_for_age(age_seconds: Option<i64>) -> PresenceStatus {
    match age_seconds {
        None => PresenceStatus::Offline,
        Some(age) if age < PRESENCE_ONLINE_SECONDS => PresenceStatus::Online,
        Some(age) if age < PRESENCE_AWAY_SECONDS => PresenceStatus::Away,
        Some(_) => PresenceStatus::Offline,
    }
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

pub const MAX_MESSAGE_BODY_CHARS: usize = 4000;

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
        if trimmed.chars().count() > MAX_MESSAGE_BODY_CHARS {
            return Err(KernelError::validation(format!(
                "message body must be at most {MAX_MESSAGE_BODY_CHARS} characters"
            )));
        }
        Ok(Self(trimmed.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
