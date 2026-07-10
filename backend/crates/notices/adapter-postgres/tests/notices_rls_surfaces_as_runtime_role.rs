#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS gate for the notice board, proven as the genuine non-owner
//! runtime role `mnt_rt` (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) — not the
//! default `#[sqlx::test]` BYPASSRLS superuser pool. Proves: draft visibility
//! is publish-tier-gated, publish snapshots every active org member + issues
//! an NT- code + fans out one notification per recipient, 수령확인 progress is
//! correct, and cross-org isolation holds throughout.

use mnt_kernel_core::{NoticeId, OrgId, TraceContext, UserId};
use mnt_notices_adapter_postgres::PgNoticeStore;
use mnt_notices_application::{
    AcknowledgeNoticeCommand, CreateDraftNoticeCommand, GetNoticeQuery, ListNoticesQuery,
    NoticeProgressQuery, PublishNoticeCommand,
};
use mnt_notifications_adapter_postgres::PgNotificationStore;
use mnt_notifications_application::{ListNotificationsQuery, UnreadNotificationCountQuery};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use time::OffsetDateTime;
use uuid::Uuid;

const OTHER_ORG: Uuid = Uuid::from_u128(0x7303_7303_7303_7303_7303_7303_7303_7303);

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    for grant in [
        "GRANT SELECT, INSERT, UPDATE ON notices TO mnt_rt",
        "GRANT SELECT, INSERT, UPDATE ON notice_receipts TO mnt_rt",
        "GRANT SELECT, INSERT, UPDATE ON notifications TO mnt_rt",
        "GRANT SELECT, INSERT, UPDATE ON object_code_counters TO mnt_rt",
        "GRANT SELECT ON object_types TO mnt_rt",
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
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, $2, $3, $4, true)",
    )
    .bind(user_id.as_uuid())
    .bind(format!("{name} {}", Uuid::new_v4()))
    .bind(Vec::from(["ADMIN"]))
    .bind(org)
    .execute(owner_pool)
    .await
    .unwrap();
    user_id
}

fn draft(author: UserId) -> CreateDraftNoticeCommand {
    CreateDraftNoticeCommand {
        author,
        title: "2026년 정기인사 명령".to_owned(),
        body: "전사 정기인사를 아래와 같이 공지합니다.".to_owned(),
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    }
}

fn publish(notice_id: NoticeId, publisher: UserId) -> PublishNoticeCommand {
    PublishNoticeCommand {
        notice_id,
        publisher,
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    }
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn draft_visibility_publish_and_progress_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let other = OrgId::from_uuid(OTHER_ORG);
    seed_org(&owner_pool, OTHER_ORG, "Other").await;

    let author = seed_user(&owner_pool, *knl.as_uuid(), "총무팀").await;
    let recipient_a = seed_user(&owner_pool, *knl.as_uuid(), "직원 A").await;
    let recipient_b = seed_user(&owner_pool, *knl.as_uuid(), "직원 B").await;

    let notifications = PgNotificationStore::new(rt_pool.clone());
    let store =
        PgNoticeStore::new(rt_pool.clone()).with_notification_sink(Arc::new(notifications.clone()));

    // Create a draft.
    let created = mnt_platform_request_context::scope_org(knl, async {
        store.create_draft(draft(author)).await
    })
    .await
    .expect("create draft");
    assert_eq!(created.status, "draft");
    assert!(created.code.is_none(), "a draft has no code yet");

    // (a) draft visibility is publish-tier-gated: a non-manager get() is
    // NotFound, never a silent leak of unpublished content.
    let hidden = mnt_platform_request_context::scope_org(knl, async {
        store
            .get(
                GetNoticeQuery {
                    notice_id: created.id,
                },
                false,
            )
            .await
    })
    .await;
    assert!(hidden.is_err(), "a non-manager must not see a draft");

    let visible_to_author = mnt_platform_request_context::scope_org(knl, async {
        store
            .get(
                GetNoticeQuery {
                    notice_id: created.id,
                },
                true,
            )
            .await
    })
    .await
    .expect("publish-tier caller sees the draft");
    assert_eq!(visible_to_author.id, created.id);

    // A draft never appears in a non-manager's list.
    let public_list = mnt_platform_request_context::scope_org(knl, async {
        store
            .list(ListNoticesQuery {
                include_drafts: false,
                limit: 50,
            })
            .await
    })
    .await
    .expect("public list");
    assert!(
        public_list.is_empty(),
        "an unpublished draft must not appear in the public list"
    );

    // (b) publish: issues an NT- code, snapshots every active org member into
    // notice_receipts, and fans out one notification per recipient.
    let published = mnt_platform_request_context::scope_org(knl, async {
        store.publish(publish(created.id, author)).await
    })
    .await
    .expect("publish");
    assert_eq!(published.status, "published");
    let code = published.code.clone().expect("published notice has a code");
    assert!(
        code.starts_with("NT-"),
        "code {code} must carry the NT- prefix"
    );

    // Publishing twice is a Conflict, not a silent duplicate code/receipt set.
    let republish = mnt_platform_request_context::scope_org(knl, async {
        store.publish(publish(created.id, author)).await
    })
    .await;
    assert!(
        republish.is_err(),
        "publishing an already-published notice must fail"
    );

    // Now visible in the public list.
    let public_list_after = mnt_platform_request_context::scope_org(knl, async {
        store
            .list(ListNoticesQuery {
                include_drafts: false,
                limit: 50,
            })
            .await
    })
    .await
    .expect("public list after publish");
    assert_eq!(public_list_after.len(), 1);
    assert_eq!(public_list_after[0].id, created.id);

    // Every active org member (author + A + B) got a notification pointing at
    // the notice.
    for recipient in [author, recipient_a, recipient_b] {
        let unread = mnt_platform_request_context::scope_org(knl, async {
            notifications
                .unread_count(UnreadNotificationCountQuery { recipient })
                .await
        })
        .await
        .expect("unread count");
        assert_eq!(unread, 1, "recipient must have exactly one notification");
        let list = mnt_platform_request_context::scope_org(knl, async {
            notifications
                .list(ListNotificationsQuery {
                    recipient,
                    unread_only: true,
                    before_id: None,
                    limit: 10,
                })
                .await
        })
        .await
        .expect("list");
        assert_eq!(list.items[0].category, "공지");
    }

    // (c) 수령확인 progress starts at 0/3.
    let progress_before = mnt_platform_request_context::scope_org(knl, async {
        store
            .progress(NoticeProgressQuery {
                notice_id: created.id,
            })
            .await
    })
    .await
    .expect("progress before");
    assert_eq!(progress_before.total, 3);
    assert_eq!(progress_before.acknowledged, 0);

    // Recipient A acknowledges; progress becomes 1/3. A cross-user
    // acknowledge attempt (someone who was never snapshotted) is NotFound.
    mnt_platform_request_context::scope_org(knl, async {
        store
            .acknowledge(AcknowledgeNoticeCommand {
                notice_id: created.id,
                recipient: recipient_a,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
    })
    .await
    .expect("A acknowledges");

    let stranger = UserId::new();
    let stranger_ack = mnt_platform_request_context::scope_org(knl, async {
        store
            .acknowledge(AcknowledgeNoticeCommand {
                notice_id: created.id,
                recipient: stranger,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
    })
    .await;
    assert!(
        stranger_ack.is_err(),
        "a non-recipient acknowledging must fail, not silently succeed"
    );

    let progress_after = mnt_platform_request_context::scope_org(knl, async {
        store
            .progress(NoticeProgressQuery {
                notice_id: created.id,
            })
            .await
    })
    .await
    .expect("progress after");
    assert_eq!(progress_after.total, 3);
    assert_eq!(progress_after.acknowledged, 1);

    // (d) cross-tenant: under another org's GUC, the notice is invisible.
    let cross_tenant_list = mnt_platform_request_context::scope_org(other, async {
        store
            .list(ListNoticesQuery {
                include_drafts: true,
                limit: 50,
            })
            .await
    })
    .await
    .expect("cross-tenant list itself succeeds");
    assert!(
        cross_tenant_list.is_empty(),
        "another tenant sees none of knl's notices"
    );
}
