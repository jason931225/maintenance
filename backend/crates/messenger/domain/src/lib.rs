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

/// Extract the `#`-object-code tokens in a message body, in first-seen order,
/// deduplicated. Mirrors [`extract_mention_user_ids`]'s boundary rule and the
/// web token grammar (DESIGN §4.7-7): a `#` that is boundary-preceded followed
/// by a candidate code — an uppercase prefix (`WO`, `AP`, …), a `-`, then the
/// code body (`[A-Za-z0-9-]`, e.g. a `YYYYMMDD-NNN` request no or a bare
/// sequence). Only the shape is checked here; the caller validates the prefix
/// against the seeded `object_types.code_prefix` set (so `#hashtag` noise is
/// dropped) and resolves the target under policy at read time.
///
/// Unlike `@`-mentions, `#`-refs carry no notification (DESIGN §4.7-7: `#` =
/// 알림 없음) — this is purely the persisted-reference parse.
///
/// Capped at [`MAX_OBJECT_CODE_REFS`] distinct codes: with `MessageBody`
/// already bounded to [`MAX_MESSAGE_BODY_CHARS`], a body still fits many more
/// than that many `#code` tokens (e.g. `"#A-A "` repeated), and each ref
/// costs a lookup + row write downstream — the cap is a message-ref
/// amplification guard, not an expected ceiling.
#[must_use]
pub fn extract_object_code_refs(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut prev: Option<char> = None;
    for (idx, ch) in body.char_indices() {
        if out.len() >= MAX_OBJECT_CODE_REFS {
            break;
        }
        if ch == '#' && prev.is_none_or(is_mention_boundary) {
            let rest = &body[idx + 1..];
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
                .unwrap_or(rest.len());
            let candidate = &rest[..end];
            if is_code_shaped(candidate) && !out.iter().any(|c| c == candidate) {
                out.push(candidate.to_owned());
            }
        }
        prev = Some(ch);
    }
    out
}

/// Cap on distinct `#`-object-code refs parsed from one message body (message-
/// ref amplification guard — see [`extract_object_code_refs`]).
pub const MAX_OBJECT_CODE_REFS: usize = 50;

/// A code is `<UPPER prefix>-<body>`: 1+ leading uppercase ASCII letters, a
/// single `-`, then at least one more char. Rejects `hashtag`, `-x`, `WO-`.
fn is_code_shaped(candidate: &str) -> bool {
    let Some(dash) = candidate.find('-') else {
        return false;
    };
    let (prefix, rest) = (&candidate[..dash], &candidate[dash + 1..]);
    !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_uppercase()) && !rest.is_empty()
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

/// Max message body length, matching the workflow-studio decision/return
/// comment cap (`app/src/workflow_studio.rs`) already established elsewhere in
/// this codebase for free-text fields. Also bounds parse cost downstream
/// (`extract_mention_user_ids` / `extract_object_code_refs` scan the whole
/// body) — a message-amplification guard, not just a UI courtesy.
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
