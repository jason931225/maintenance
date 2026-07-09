//! Messenger domain.
//!
//! Pure value objects and enum wire contracts only. Persistence, audit, REST,
//! and realtime delivery live in outer layers.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{KernelError, UserId};
use serde::{Deserialize, Serialize};

/// Extract the `UserId`s mentioned in a message body, in first-seen order,
/// deduplicated. Mirrors the web token grammar (DESIGN §4.7-7): a mention is an
/// `@` that is boundary-preceded (start-of-string / whitespace / `([{`)
/// followed by the confirmed candidate's code, which for a person is the raw
/// user UUID (`web/src/lib/objectCandidates.ts` returns `code = member.id`, and
/// `confirmToken` inserts `@<code>`). Only `@` is a mention — `#object-link`
/// and `!code-link` carry no notification (DESIGN §4.7-7: `#` = 알림 없음).
///
/// This is intentionally the *parse* step only: it does not verify the user
/// exists or is reachable. The caller filters the result down to real,
/// permitted recipients (thread members) so an `@<uuid>` for someone outside
/// the thread resolves to nothing — deny-by-omission, never a link/notify.
#[must_use]
pub fn extract_mention_user_ids(body: &str) -> Vec<UserId> {
    let mut out: Vec<UserId> = Vec::new();
    let mut prev: Option<char> = None;
    for (idx, ch) in body.char_indices() {
        if ch == '@' && prev.is_none_or(is_mention_boundary) {
            let rest = &body[idx + 1..];
            let end = rest
                .find(|c: char| !(c.is_ascii_hexdigit() || c == '-'))
                .unwrap_or(rest.len());
            if let Ok(id) = rest[..end].parse::<UserId>()
                && !out.contains(&id)
            {
                out.push(id);
            }
        }
        prev = Some(ch);
    }
    out
}

fn is_mention_boundary(c: char) -> bool {
    c.is_whitespace() || matches!(c, '(' | '[' | '{')
}

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
