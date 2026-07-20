//! Source-neutral action inbox application boundary.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::future::Future;
use std::pin::Pin;

use mnt_kernel_core::KernelError;
use serde::Serialize;
use time::{Duration, OffsetDateTime};

pub const DEFAULT_PAGE_LIMIT: usize = 100;
pub const MAX_PAGE_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionInboxSource {
    Workflow,
    Dispatch,
    Support,
    WorkOrder,
}

impl ActionInboxSource {
    pub const ALL: [Self; 4] = [
        Self::Workflow,
        Self::Dispatch,
        Self::Support,
        Self::WorkOrder,
    ];
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionInboxPosition {
    pub created_at: OffsetDateTime,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionInboxCursor {
    pub as_of: OffsetDateTime,
    pub position: ActionInboxPosition,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListActionInboxQuery {
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionInboxSourceQuery {
    pub now: OffsetDateTime,
    pub as_of: OffsetDateTime,
    pub after: Option<ActionInboxPosition>,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActionInboxLink {
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionInboxSourceItem {
    pub id: String,
    pub kind: String,
    pub ref_code: String,
    pub title: String,
    pub site: Option<String>,
    pub who: Option<String>,
    pub due: Option<OffsetDateTime>,
    pub submitted: Option<OffsetDateTime>,
    pub links: Vec<ActionInboxLink>,
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionInboxSourcePage {
    pub items: Vec<ActionInboxSourceItem>,
    pub total: usize,
    pub total_is_exact: bool,
    pub has_more: bool,
}

pub type ActionInboxSourceFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ActionInboxSourcePage, KernelError>> + Send + 'a>>;

/// Compile-enforced inbound dependency boundary. Implementations own source
/// visibility and persistence predicates; the use case only merges already
/// person-scoped projections.
pub trait ActionInboxSourcePort: Send + Sync {
    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActionInboxItem {
    pub id: String,
    pub kind: String,
    pub urg: &'static str,
    #[serde(rename = "ref")]
    pub ref_code: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
    #[serde(
        rename = "due",
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub due: Option<OffsetDateTime>,
    #[serde(rename = "dueTone")]
    pub due_tone: &'static str,
    #[serde(
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub submitted: Option<OffsetDateTime>,
    pub links: Vec<ActionInboxLink>,
    pub done: bool,
    #[serde(skip)]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActionInboxPage {
    pub items: Vec<ActionInboxItem>,
    pub total: usize,
    pub total_is_exact: bool,
    pub next_cursor: Option<String>,
}

pub async fn list_action_inbox(
    port: &dyn ActionInboxSourcePort,
    query: ListActionInboxQuery,
    now: OffsetDateTime,
) -> Result<ActionInboxPage, KernelError> {
    let cursor = query
        .cursor
        .as_deref()
        .map(|raw| parse_cursor(raw, now))
        .transpose()?;
    let as_of = cursor.as_ref().map_or(now, |cursor| cursor.as_of);
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_LIMIT)
        .clamp(1, MAX_PAGE_LIMIT);
    let source_query = ActionInboxSourceQuery {
        now,
        as_of,
        after: cursor.as_ref().map(|cursor| cursor.position.clone()),
        limit,
    };
    let mut pages = Vec::with_capacity(ActionInboxSource::ALL.len());
    for source in ActionInboxSource::ALL {
        pages.push(port.list_source_page(source, source_query.clone()).await?);
    }
    Ok(merge_pages(pages, now, as_of, cursor.as_ref(), limit))
}

pub fn merge_pages(
    pages: Vec<ActionInboxSourcePage>,
    now: OffsetDateTime,
    as_of: OffsetDateTime,
    cursor: Option<&ActionInboxCursor>,
    limit: usize,
) -> ActionInboxPage {
    let total = pages
        .iter()
        .fold(0usize, |sum, page| sum.saturating_add(page.total));
    let total_is_exact = pages.iter().all(|page| page.total_is_exact);
    let source_has_more = pages.iter().any(|page| page.has_more);
    let mut items = pages
        .into_iter()
        .flat_map(|page| page.items)
        .filter(|item| item.created_at <= as_of)
        .map(|item| project_item(item, now))
        .collect::<Vec<_>>();
    items.sort_by(compare_items);
    if let Some(cursor) = cursor {
        items.retain(|item| item_after_cursor(item, cursor));
    }
    let has_merged_more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = (has_merged_more || source_has_more)
        .then(|| {
            items.last().map(|item| {
                encode_cursor(
                    as_of,
                    &ActionInboxPosition {
                        created_at: item.created_at,
                        id: item.id.clone(),
                    },
                )
            })
        })
        .flatten();
    ActionInboxPage {
        items,
        total,
        total_is_exact,
        next_cursor,
    }
}

fn project_item(item: ActionInboxSourceItem, now: OffsetDateTime) -> ActionInboxItem {
    let (urg, due_tone) = urgency(item.due, now);
    ActionInboxItem {
        id: item.id,
        kind: item.kind,
        urg,
        ref_code: item.ref_code,
        title: item.title,
        site: item.site,
        who: item.who,
        due: item.due,
        due_tone,
        submitted: item.submitted,
        links: item.links,
        done: false,
        created_at: item.created_at,
    }
}

pub fn urgency(due: Option<OffsetDateTime>, now: OffsetDateTime) -> (&'static str, &'static str) {
    match due {
        None => ("wait", "neutral"),
        Some(due) if due <= now => ("now", "danger"),
        Some(due) if due <= now + Duration::hours(24) => ("today", "warn"),
        Some(_) => ("wait", "neutral"),
    }
}

pub fn encode_cursor(as_of: OffsetDateTime, position: &ActionInboxPosition) -> String {
    format!(
        "{}~{}~{}",
        as_of.unix_timestamp_nanos(),
        position.created_at.unix_timestamp_nanos(),
        position.id
    )
}

pub fn parse_cursor(raw: &str, now: OffsetDateTime) -> Result<ActionInboxCursor, KernelError> {
    let mut parts = raw.splitn(3, '~');
    let as_of = parse_timestamp(parts.next());
    let created_at = parse_timestamp(parts.next());
    let id = parts.next().filter(|value| !value.is_empty());
    match (as_of, created_at, id) {
        (Some(as_of), Some(created_at), Some(id))
            if as_of <= now && created_at <= as_of && valid_namespaced_id(id) =>
        {
            Ok(ActionInboxCursor {
                as_of,
                position: ActionInboxPosition {
                    created_at,
                    id: id.to_owned(),
                },
            })
        }
        _ => Err(KernelError::validation("invalid action-inbox cursor")),
    }
}

fn parse_timestamp(raw: Option<&str>) -> Option<OffsetDateTime> {
    raw.and_then(|value| value.parse::<i128>().ok())
        .and_then(|value| OffsetDateTime::from_unix_timestamp_nanos(value).ok())
}

fn valid_namespaced_id(value: &str) -> bool {
    let Some((kind, id)) = value.split_once(':') else {
        return false;
    };
    matches!(kind, "approval" | "dispatch" | "support" | "work")
        && uuid::Uuid::parse_str(id).is_ok()
}

fn compare_items(a: &ActionInboxItem, b: &ActionInboxItem) -> std::cmp::Ordering {
    a.created_at
        .cmp(&b.created_at)
        .then_with(|| a.id.cmp(&b.id))
}

fn item_after_cursor(item: &ActionInboxItem, cursor: &ActionInboxCursor) -> bool {
    item.created_at
        .cmp(&cursor.position.created_at)
        .then_with(|| item.id.cmp(&cursor.position.id))
        .is_gt()
}

/// Normalize the historic alias before it reaches clients.
#[must_use]
pub fn canonical_action_link_kind(kind: &str) -> &str {
    if kind == "workflow_run" {
        "approval_run"
    } else {
        kind
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Mutex;

    use time::{Duration, OffsetDateTime};
    use uuid::Uuid;

    use super::*;

    #[test]
    fn cursor_round_trips_and_rejects_invalid_or_future_boundaries() {
        let as_of = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let position = ActionInboxPosition {
            created_at: as_of - Duration::seconds(5),
            id: format!("work:{}", Uuid::from_u128(7)),
        };
        let encoded = encode_cursor(as_of, &position);
        assert_eq!(
            parse_cursor(&encoded, as_of).unwrap(),
            ActionInboxCursor { as_of, position }
        );
        assert!(parse_cursor("garbage", as_of).is_err());
        assert!(
            parse_cursor(
                &format!(
                    "{}~{}~work:{}",
                    (as_of + Duration::SECOND).unix_timestamp_nanos(),
                    as_of.unix_timestamp_nanos(),
                    Uuid::from_u128(7)
                ),
                as_of,
            )
            .is_err()
        );
        assert!(
            parse_cursor(
                &format!(
                    "{}~{}~unknown:{}",
                    as_of.unix_timestamp_nanos(),
                    as_of.unix_timestamp_nanos(),
                    Uuid::from_u128(7)
                ),
                as_of,
            )
            .is_err()
        );
    }

    #[test]
    fn merge_orders_by_immutable_created_at_then_namespaced_id() {
        let at = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let later = at + Duration::SECOND;
        let page = merge_pages(
            vec![
                source_page(
                    vec![item("work", 2, later), item("work", 1, at)],
                    2,
                    true,
                    false,
                ),
                source_page(vec![item("approval", 3, at)], 1, true, false),
            ],
            at + Duration::seconds(2),
            at + Duration::seconds(2),
            None,
            10,
        );
        assert_eq!(
            page.items
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                format!("approval:{}", Uuid::from_u128(3)),
                format!("work:{}", Uuid::from_u128(1)),
                format!("work:{}", Uuid::from_u128(2)),
            ]
        );
    }

    #[test]
    fn merge_sums_source_totals_preserves_inexactness_and_pages_without_duplicates() {
        let as_of = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let pages = vec![
            source_page(
                vec![
                    item("work", 1, as_of - Duration::seconds(2)),
                    item("work", 3, as_of),
                ],
                8,
                true,
                true,
            ),
            source_page(
                vec![item("approval", 2, as_of - Duration::SECOND)],
                5,
                false,
                false,
            ),
        ];
        let first = merge_pages(pages.clone(), as_of, as_of, None, 2);
        assert_eq!(first.total, 13);
        assert!(!first.total_is_exact);
        assert_eq!(first.items.len(), 2);
        let cursor = parse_cursor(first.next_cursor.as_deref().unwrap(), as_of).unwrap();
        let second_pages = pages
            .into_iter()
            .map(|mut page| {
                page.has_more = false;
                page
            })
            .collect();
        let second = merge_pages(second_pages, as_of, as_of, Some(&cursor), 2);
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].id, format!("work:{}", Uuid::from_u128(3)));
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn urgency_and_wire_projection_preserve_the_existing_rest_shape() {
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let page = merge_pages(
            vec![source_page(
                vec![ActionInboxSourceItem {
                    due: Some(now + Duration::HOUR),
                    ..item("work", 9, now)
                }],
                1,
                true,
                false,
            )],
            now,
            now,
            None,
            10,
        );
        assert_eq!(page.items[0].urg, "today");
        assert_eq!(page.items[0].due_tone, "warn");
        let json = serde_json::to_value(page).unwrap();
        let row = &json["items"][0];
        assert_eq!(row["ref"], "REF-9");
        assert_eq!(row["dueTone"], "warn");
        assert!(row.get("created_at").is_none());
        assert!(row.get("site").is_none());
        assert_eq!(json["total_is_exact"], true);
        assert!(json.get("next_cursor").is_some());
    }

    #[test]
    fn list_action_inbox_pages_more_than_four_hundred_items_without_drift_or_duplicates() {
        const ITEM_COUNT: usize = 421;
        const PAGE_LIMIT: usize = 137;

        let as_of = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let source = FakeActionInboxSource::new(
            (1..=ITEM_COUNT)
                .map(|index| {
                    let source = ActionInboxSource::ALL[(index - 1) % ActionInboxSource::ALL.len()];
                    let kind = match source {
                        ActionInboxSource::Workflow => "approval",
                        ActionInboxSource::Dispatch => "dispatch",
                        ActionInboxSource::Support => "support",
                        ActionInboxSource::WorkOrder => "work",
                    };
                    (
                        source,
                        item(
                            kind,
                            index as u128,
                            as_of - Duration::seconds((ITEM_COUNT - index + 1) as i64),
                        ),
                    )
                })
                .collect(),
        );
        let expected = source
            .items
            .iter()
            .map(|(_, item)| item.id.clone())
            .collect::<Vec<_>>();

        let mut cursor = None;
        let mut collected = Vec::new();
        let mut page_count = 0usize;
        loop {
            let page = run_ready(list_action_inbox(
                &source,
                ListActionInboxQuery {
                    limit: Some(PAGE_LIMIT),
                    cursor,
                },
                as_of + Duration::hours(page_count as i64),
            ))
            .unwrap();
            assert_eq!(page.total, ITEM_COUNT);
            assert!(page.total_is_exact);
            collected.extend(page.items.into_iter().map(|item| item.id));
            page_count += 1;
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }

        assert!(page_count >= 3);
        assert_eq!(collected, expected);
        assert_eq!(collected.len(), ITEM_COUNT);
        assert_eq!(collected.iter().collect::<HashSet<_>>().len(), ITEM_COUNT);

        let queries = source.queries.lock().unwrap();
        assert_eq!(queries.len(), page_count * ActionInboxSource::ALL.len());
        for (page_index, page_queries) in queries
            .chunks_exact(ActionInboxSource::ALL.len())
            .enumerate()
        {
            assert!(page_queries.iter().all(|(_, query)| query.as_of == as_of));
            if page_index == 0 {
                assert!(page_queries.iter().all(|(_, query)| query.after.is_none()));
            } else {
                let prior_page_last_id = &collected[page_index * PAGE_LIMIT - 1];
                let prior_page_last = source
                    .items
                    .iter()
                    .find(|(_, item)| &item.id == prior_page_last_id)
                    .map(|(_, item)| ActionInboxPosition {
                        created_at: item.created_at,
                        id: item.id.clone(),
                    })
                    .unwrap();
                assert!(
                    page_queries
                        .iter()
                        .all(|(_, query)| query.after.as_ref() == Some(&prior_page_last))
                );
            }
        }
    }

    fn run_ready<T>(future: impl Future<Output = T>) -> T {
        let mut future = Box::pin(future);
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(output) => output,
            std::task::Poll::Pending => panic!("fake source futures must be immediately ready"),
        }
    }

    struct FakeActionInboxSource {
        items: Vec<(ActionInboxSource, ActionInboxSourceItem)>,
        queries: Mutex<Vec<(ActionInboxSource, ActionInboxSourceQuery)>>,
    }

    impl FakeActionInboxSource {
        fn new(items: Vec<(ActionInboxSource, ActionInboxSourceItem)>) -> Self {
            Self {
                items,
                queries: Mutex::new(Vec::new()),
            }
        }
    }

    impl ActionInboxSourcePort for FakeActionInboxSource {
        fn list_source_page(
            &self,
            source: ActionInboxSource,
            query: ActionInboxSourceQuery,
        ) -> ActionInboxSourceFuture<'_> {
            self.queries.lock().unwrap().push((source, query.clone()));
            let total = self
                .items
                .iter()
                .filter(|(item_source, item)| {
                    *item_source == source && item.created_at <= query.as_of
                })
                .count();
            let mut matching = self
                .items
                .iter()
                .filter(|(item_source, item)| {
                    *item_source == source
                        && item.created_at <= query.as_of
                        && query.after.as_ref().is_none_or(|after| {
                            item.created_at
                                .cmp(&after.created_at)
                                .then_with(|| item.id.cmp(&after.id))
                                .is_gt()
                        })
                })
                .map(|(_, item)| item.clone())
                .collect::<Vec<_>>();
            matching.sort_by(|left, right| {
                left.created_at
                    .cmp(&right.created_at)
                    .then_with(|| left.id.cmp(&right.id))
            });
            let has_more = matching.len() > query.limit;
            matching.truncate(query.limit);
            Box::pin(async move {
                Ok(ActionInboxSourcePage {
                    items: matching,
                    total,
                    total_is_exact: true,
                    has_more,
                })
            })
        }
    }

    fn source_page(
        items: Vec<ActionInboxSourceItem>,
        total: usize,
        exact: bool,
        has_more: bool,
    ) -> ActionInboxSourcePage {
        ActionInboxSourcePage {
            items,
            total,
            total_is_exact: exact,
            has_more,
        }
    }

    fn item(kind: &'static str, id: u128, created_at: OffsetDateTime) -> ActionInboxSourceItem {
        ActionInboxSourceItem {
            id: format!("{kind}:{}", Uuid::from_u128(id)),
            kind: kind.to_owned(),
            ref_code: format!("REF-{id}"),
            title: format!("Item {id}"),
            site: None,
            who: None,
            due: None,
            submitted: None,
            links: Vec::new(),
            created_at,
        }
    }
}
