#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS + recipient-isolation gate for the notification center.
//!
//! Proven as the genuine non-owner runtime role `mnt_rt` (NOSUPERUSER,
//! NOBYPASSRLS, FORCE RLS) — NOT the default `#[sqlx::test]` BYPASSRLS
//! superuser pool, which sees every row and would green-light a broken
//! recipient filter. There is no per-person GUC, so recipient scoping is
//! enforced in application code; this test is the thing that proves user B
//! cannot list or read-mark user A's notifications, and that another tenant
//! sees nothing.

use mnt_kernel_core::{ErrorKind, OrgId, TraceContext, UserId};
use mnt_notifications_adapter_postgres::PgNotificationStore;
use mnt_notifications_application::{
    EmitNotificationCommand, ListNotificationsQuery, MarkAllNotificationsReadCommand,
    MarkNotificationReadCommand, NotificationCreatedNotification, NotificationNotifier,
    NotificationNotifyFuture, UnreadNotificationCountQuery,
};
use mnt_notifications_domain::NotificationLink;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use std::sync::{Arc, Mutex};
use time::OffsetDateTime;
use uuid::Uuid;

const OTHER_ORG: Uuid = Uuid::from_u128(0x7202_7202_7202_7202_7202_7202_7202_7202);

/// Records realtime notifier calls so the test can assert emit fires it exactly
/// once per genuinely-new row (and never on a dedup redelivery).
#[derive(Default)]
struct RecordingNotifier {
    calls: Mutex<Vec<NotificationCreatedNotification>>,
}

impl NotificationNotifier for RecordingNotifier {
    fn notification_created(
        &self,
        notification: NotificationCreatedNotification,
    ) -> NotificationNotifyFuture<'_> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(notification);
        })
    }
}

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    for grant in [
        "GRANT SELECT, INSERT, UPDATE ON notifications TO mnt_rt",
        "GRANT SELECT, INSERT ON audit_events TO mnt_rt",
        "GRANT SELECT ON users TO mnt_rt",
        "GRANT SELECT ON organizations TO mnt_rt",
    ] {
        sqlx::query(grant).execute(owner_pool).await.unwrap();
    }
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn seed_org(owner_pool: &PgPool, org: Uuid, tag: &str) {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind(format!("org-{}", tag.to_lowercase()))
    .bind(format!("Org {tag}"))
    .execute(owner_pool)
    .await
    .unwrap();
}

async fn seed_user(owner_pool: &PgPool, org: Uuid, name: &str) -> UserId {
    let user_id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(user_id.as_uuid())
        .bind(format!("{name} {}", Uuid::new_v4()))
        .bind(Vec::from(["ADMIN"]))
        .bind(org)
        .execute(owner_pool)
        .await
        .unwrap();
    user_id
}

fn emit_to(recipient: UserId, category: &str, dedup_key: Option<&str>) -> EmitNotificationCommand {
    EmitNotificationCommand {
        actor: None,
        recipient,
        category: category.to_owned(),
        text: "결재 문서가 도착했습니다".to_owned(),
        link: NotificationLink::Object {
            kind: "approval".to_owned(),
            id: Uuid::new_v4().to_string(),
        },
        dedup_key: dedup_key.map(str::to_owned),
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    }
}

fn unread_count_of(recipient: UserId) -> UnreadNotificationCountQuery {
    UnreadNotificationCountQuery { recipient }
}

fn list_unread(recipient: UserId) -> ListNotificationsQuery {
    ListNotificationsQuery {
        recipient,
        unread_only: true,
        before_id: None,
        limit: 50,
    }
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn recipient_isolation_and_read_marking_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let other = OrgId::from_uuid(OTHER_ORG);
    seed_org(&owner_pool, OTHER_ORG, "Other").await;
    let user_a = seed_user(&owner_pool, *knl.as_uuid(), "Approver A").await;
    let user_b = seed_user(&owner_pool, *knl.as_uuid(), "Approver B").await;

    let notifier = Arc::new(RecordingNotifier::default());
    let store = PgNotificationStore::new(rt_pool.clone()).with_notifier(notifier.clone());

    // Emit one to A and one to B (all under knl).
    let a_notif = mnt_platform_request_context::scope_org(knl, async {
        store.emit_notification(emit_to(user_a, "결재", None)).await
    })
    .await
    .expect("emit to A");
    mnt_platform_request_context::scope_org(knl, async {
        store.emit_notification(emit_to(user_b, "멘션", None)).await
    })
    .await
    .expect("emit to B");

    assert_eq!(a_notif.category, "결재");
    assert!(a_notif.unread);
    assert_eq!(a_notif.recipient_user_id, user_a);

    // (a) recipient isolation: A sees only A's; B sees only B's.
    let a_list = mnt_platform_request_context::scope_org(knl, async {
        store.list(list_unread(user_a)).await
    })
    .await
    .expect("A list");
    assert_eq!(a_list.items.len(), 1, "A sees exactly one notification");
    assert_eq!(a_list.items[0].id, a_notif.id);

    let b_list = mnt_platform_request_context::scope_org(knl, async {
        store.list(list_unread(user_b)).await
    })
    .await
    .expect("B list");
    assert_eq!(b_list.items.len(), 1);
    assert_ne!(
        b_list.items[0].id, a_notif.id,
        "B must never see A's notification"
    );

    // (b) cross-user read-mark: B marking A's notification is NotFound, not a
    //     silent success — and A's notification stays unread.
    let cross = mnt_platform_request_context::scope_org(knl, async {
        store
            .mark_read(MarkNotificationReadCommand {
                recipient: user_b,
                notification_id: a_notif.id,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
    })
    .await;
    let cross_err = cross.expect_err("B marking A's notification must fail");
    assert_eq!(
        cross_err.kind(),
        ErrorKind::NotFound,
        "B marking A's notification must be NotFound, not a silent success"
    );

    // A marks its own read -> unread=false, read_at set.
    let marked = mnt_platform_request_context::scope_org(knl, async {
        store
            .mark_read(MarkNotificationReadCommand {
                recipient: user_a,
                notification_id: a_notif.id,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
    })
    .await
    .expect("A marks own read");
    assert!(!marked.unread);
    assert!(marked.read_at.is_some());

    let a_unread_after = mnt_platform_request_context::scope_org(knl, async {
        store.list(list_unread(user_a)).await
    })
    .await
    .expect("A unread after");
    assert_eq!(
        a_unread_after.items.len(),
        0,
        "A has no unread after marking"
    );

    // (c) cross-tenant: under another org's GUC, A's rows are invisible (RLS).
    let cross_tenant = mnt_platform_request_context::scope_org(other, async {
        store.list(list_unread(user_a)).await
    })
    .await
    .expect("cross-tenant list itself succeeds");
    assert_eq!(
        cross_tenant.items.len(),
        0,
        "another tenant sees none of A's notifications"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn unread_count_is_recipient_scoped_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let user_a = seed_user(&owner_pool, *knl.as_uuid(), "Counter A").await;
    let user_b = seed_user(&owner_pool, *knl.as_uuid(), "Counter B").await;
    let store = PgNotificationStore::new(rt_pool.clone());

    // Zero unread to start.
    let zero = mnt_platform_request_context::scope_org(knl, async {
        store.unread_count(unread_count_of(user_a)).await
    })
    .await
    .expect("A count when empty");
    assert_eq!(zero, 0, "no notifications => zero unread");

    // Two for A, one for B.
    let a_first = mnt_platform_request_context::scope_org(knl, async {
        store.emit_notification(emit_to(user_a, "결재", None)).await
    })
    .await
    .expect("emit A#1");
    mnt_platform_request_context::scope_org(knl, async {
        store.emit_notification(emit_to(user_a, "멘션", None)).await
    })
    .await
    .expect("emit A#2");
    mnt_platform_request_context::scope_org(knl, async {
        store.emit_notification(emit_to(user_b, "공지", None)).await
    })
    .await
    .expect("emit B#1");

    let a_count = mnt_platform_request_context::scope_org(knl, async {
        store.unread_count(unread_count_of(user_a)).await
    })
    .await
    .expect("A count");
    assert_eq!(a_count, 2, "A has exactly its own two unread");

    // Cross-user isolation: B's count is unaffected by A's rows.
    let b_count = mnt_platform_request_context::scope_org(knl, async {
        store.unread_count(unread_count_of(user_b)).await
    })
    .await
    .expect("B count");
    assert_eq!(b_count, 1, "B sees only its own unread");

    // Read rows are excluded: marking one of A's read drops the count to one.
    mnt_platform_request_context::scope_org(knl, async {
        store
            .mark_read(MarkNotificationReadCommand {
                recipient: user_a,
                notification_id: a_first.id,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
    })
    .await
    .expect("A marks one read");
    let a_after = mnt_platform_request_context::scope_org(knl, async {
        store.unread_count(unread_count_of(user_a)).await
    })
    .await
    .expect("A count after read");
    assert_eq!(a_after, 1, "read rows are excluded from the unread count");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn mark_all_read_and_dedup_idempotency_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let user = seed_user(&owner_pool, *knl.as_uuid(), "Busy User").await;

    let notifier = Arc::new(RecordingNotifier::default());
    let store = PgNotificationStore::new(rt_pool.clone()).with_notifier(notifier.clone());

    // Three unread notifications.
    for cat in ["결재", "근태", "급여"] {
        mnt_platform_request_context::scope_org(knl, async {
            store.emit_notification(emit_to(user, cat, None)).await
        })
        .await
        .expect("emit");
    }

    let marked = mnt_platform_request_context::scope_org(knl, async {
        store
            .mark_all_read(MarkAllNotificationsReadCommand {
                recipient: user,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
    })
    .await
    .expect("mark all");
    assert_eq!(marked, 3, "all three unread are marked");

    let unread_after =
        mnt_platform_request_context::scope_org(knl, async { store.list(list_unread(user)).await })
            .await
            .expect("list");
    assert!(unread_after.items.is_empty());

    // Dedup: two emits with the same key produce ONE row and fire the realtime
    // notifier ONCE (the redelivery is a no-op returning the existing row).
    let notifier_calls_before = notifier.calls.lock().unwrap().len();
    let first = mnt_platform_request_context::scope_org(knl, async {
        store
            .emit_notification(emit_to(user, "공지", Some("outbox-evt-1")))
            .await
    })
    .await
    .expect("first dedup emit");
    let second = mnt_platform_request_context::scope_org(knl, async {
        store
            .emit_notification(emit_to(user, "공지", Some("outbox-evt-1")))
            .await
    })
    .await
    .expect("second dedup emit");
    assert_eq!(first.id, second.id, "same dedup_key returns the same row");

    let row_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM notifications WHERE dedup_key = $1")
            .bind("outbox-evt-1")
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(row_count, 1, "dedup_key never doubles a row");

    let notifier_calls_after = notifier.calls.lock().unwrap().len();
    assert_eq!(
        notifier_calls_after - notifier_calls_before,
        1,
        "the realtime notifier fires once, not on the redelivery"
    );
}
