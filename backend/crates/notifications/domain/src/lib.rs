//! Notifications domain.
//!
//! Pure value objects and the deep-link wire contract only. Persistence, audit,
//! REST, and realtime delivery live in outer layers. `category` is deliberately
//! a validated free-form string, not an enum: new producers (결재/멘션/문서/공지/
//! 근태/급여 and beyond) add categories without a code change or migration.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::KernelError;
use serde::{Deserialize, Serialize};

const CATEGORY_MAX: usize = 64;
const BODY_MAX: usize = 2000;

/// Extensible notification category (matches the DB `category` CHECK).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NotificationCategory(String);

impl NotificationCategory {
    pub fn new(value: impl Into<String>) -> Result<Self, KernelError> {
        let trimmed = value.into().trim().to_owned();
        if trimmed.is_empty() {
            return Err(KernelError::validation("notification category is required"));
        }
        if trimmed.chars().count() > CATEGORY_MAX {
            return Err(KernelError::validation(format!(
                "notification category must be at most {CATEGORY_MAX} characters"
            )));
        }
        Ok(Self(trimmed))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

/// Recipient-facing notification text (matches the DB `body` CHECK).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NotificationBody(String);

impl NotificationBody {
    pub fn new(value: impl Into<String>) -> Result<Self, KernelError> {
        let trimmed = value.into().trim().to_owned();
        if trimmed.is_empty() {
            return Err(KernelError::validation("notification text is required"));
        }
        if trimmed.chars().count() > BODY_MAX {
            return Err(KernelError::validation(format!(
                "notification text must be at most {BODY_MAX} characters"
            )));
        }
        Ok(Self(trimmed))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

/// Deep-link target carried by a notification: either a reference to a domain
/// object (`kind` + `id`, e.g. a work order or approval) or a bare app screen.
/// Serializes to the JSONB `link` column and back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NotificationLink {
    Object { kind: String, id: String },
    Screen { screen: String },
}

impl NotificationLink {
    /// Validates the non-empty invariants the JSONB column cannot express.
    pub fn validated(self) -> Result<Self, KernelError> {
        let ok = match &self {
            Self::Object { kind, id } => !kind.trim().is_empty() && !id.trim().is_empty(),
            Self::Screen { screen } => !screen.trim().is_empty(),
        };
        if ok {
            Ok(self)
        } else {
            Err(KernelError::validation(
                "notification link fields must not be empty",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_rejects_blank_and_overlong() {
        assert!(NotificationCategory::new("  ").is_err());
        assert!(NotificationCategory::new("x".repeat(CATEGORY_MAX + 1)).is_err());
        assert_eq!(
            NotificationCategory::new("  결재 ").unwrap().as_str(),
            "결재"
        );
    }

    #[test]
    fn body_rejects_blank_and_overlong() {
        assert!(NotificationBody::new("").is_err());
        assert!(NotificationBody::new("x".repeat(BODY_MAX + 1)).is_err());
    }

    #[test]
    fn link_roundtrips_and_validates() {
        let object = NotificationLink::Object {
            kind: "work_order".into(),
            id: "wo-1".into(),
        };
        let json = serde_json::to_string(&object).unwrap();
        assert!(json.contains("\"type\":\"object\""));
        let back: NotificationLink = serde_json::from_str(&json).unwrap();
        assert_eq!(object, back);

        assert!(
            NotificationLink::Object {
                kind: " ".into(),
                id: "x".into()
            }
            .validated()
            .is_err()
        );
        assert!(
            NotificationLink::Screen {
                screen: "payroll".into()
            }
            .validated()
            .is_ok()
        );
    }
}
