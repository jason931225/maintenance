#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, OrgId, TraceContext, UserId,
};
use mnt_messenger_adapter_postgres::PgMessengerStore;
use mnt_messenger_application::{CreateThreadCommand, SendMessageCommand};
use mnt_messenger_domain::ThreadKind;
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_realtime::{
    PgRealtimeHub, PostgresMessageNotifier, RealtimeEvent, RealtimeHubConfig, RealtimePrincipal,
};
use sqlx::PgPool;
use time::OffsetDateTime;
use tokio::time::timeout;

#[sqlx::test(migrations = "../db/migrations")]
async fn postgres_notify_from_instance_a_wakes_instance_b_and_rereads_message_body(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let branch_id = seed_branch(&pool).await;
        let sender = seed_user_with_branch(&pool, "sender", "MECHANIC", branch_id).await;
        let recipient = seed_user_with_branch(&pool, "recipient", "ADMIN", branch_id).await;

        let hub_b = Arc::new(PgRealtimeHub::new(
            pool.clone(),
            RealtimeHubConfig {
                connection_buffer: 8,
            },
        ));
        let _listener_b = hub_b.clone().start_postgres_listener().await.unwrap();
        let mut subscriber_b = hub_b
            .connect(
                RealtimePrincipal {
                    user_id: recipient,
                    branch_scope: BranchScope::single(branch_id),
                    org_id: OrgId::knl(),
                },
                None,
            )
            .await
            .unwrap();

        let store_a = PgMessengerStore::new(pool.clone())
            .with_notifier(Arc::new(PostgresMessageNotifier::new(pool.clone())));
        let thread = store_a
            .create_thread(CreateThreadCommand {
                actor: sender,
                branch_scope: BranchScope::single(branch_id),
                branch_id,
                kind: ThreadKind::Team,
                visibility: None,
                title: Some("정비팀".to_owned()),
                work_order_id: None,
                member_ids: vec![sender, recipient],
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();

        let sent = store_a
            .send_message(SendMessageCommand {
                actor: sender,
                branch_scope: BranchScope::single(branch_id),
                thread_id: thread.id,
                body: "A 인스턴스에서 저장된 본문을 B 인스턴스가 DB에서 재조회".to_owned(),
                attachment_evidence_ids: Vec::new(),
                quoted_message_id: None,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();

        let delivered = timeout(Duration::from_secs(3), subscriber_b.recv())
            .await
            .expect("instance B should receive the LISTEN/NOTIFY wake")
            .expect("instance B connection should still be open");

        let RealtimeEvent::MessagePosted { message } = delivered;
        assert_eq!(message.id, sent.id);
        assert_eq!(message.thread_id, thread.id);
        assert_eq!(message.branch_id, branch_id);
        assert_eq!(
            message.body,
            "A 인스턴스에서 저장된 본문을 B 인스턴스가 DB에서 재조회"
        );
    })
    .await;
}

#[sqlx::test(migrations = "../db/migrations")]
async fn reconnect_replays_messages_after_the_last_read_cursor(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let branch_id = seed_branch(&pool).await;
        let sender = seed_user_with_branch(&pool, "resume sender", "MECHANIC", branch_id).await;
        let recipient = seed_user_with_branch(&pool, "resume recipient", "ADMIN", branch_id).await;
        let store = PgMessengerStore::new(pool.clone());
        let thread = store
            .create_thread(CreateThreadCommand {
                actor: sender,
                branch_scope: BranchScope::single(branch_id),
                branch_id,
                kind: ThreadKind::Team,
                visibility: None,
                title: Some("정비팀".to_owned()),
                work_order_id: None,
                member_ids: vec![sender, recipient],
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();
        let first = store
            .send_message(SendMessageCommand {
                actor: sender,
                branch_scope: BranchScope::single(branch_id),
                thread_id: thread.id,
                body: "already read".to_owned(),
                attachment_evidence_ids: Vec::new(),
                quoted_message_id: None,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();
        let second = store
            .send_message(SendMessageCommand {
                actor: sender,
                branch_scope: BranchScope::single(branch_id),
                thread_id: thread.id,
                body: "replayed after reconnect".to_owned(),
                attachment_evidence_ids: Vec::new(),
                quoted_message_id: None,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc() + time::Duration::seconds(1),
            })
            .await
            .unwrap();

        let hub = Arc::new(PgRealtimeHub::new(
            pool.clone(),
            RealtimeHubConfig {
                connection_buffer: 8,
            },
        ));
        let mut reconnected = hub
            .connect(
                RealtimePrincipal {
                    user_id: recipient,
                    branch_scope: BranchScope::single(branch_id),
                    org_id: OrgId::knl(),
                },
                Some(first.id),
            )
            .await
            .unwrap();

        let delivered = timeout(Duration::from_secs(3), reconnected.recv())
            .await
            .expect("resume replay should arrive")
            .expect("connection should stay open");

        let RealtimeEvent::MessagePosted { message } = delivered;
        assert_eq!(message.id, second.id);
        assert_eq!(message.body, "replayed after reconnect");
    })
    .await;
}

#[sqlx::test(migrations = "../db/migrations")]
async fn reconnect_replay_pages_past_one_hundred_messages_without_truncating(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let branch_id = seed_branch(&pool).await;
        let sender = seed_user_with_branch(&pool, "page sender", "MECHANIC", branch_id).await;
        let recipient = seed_user_with_branch(&pool, "page recipient", "ADMIN", branch_id).await;
        let store = PgMessengerStore::new(pool.clone());
        let thread = create_thread(&store, sender, recipient, branch_id).await;
        let base = OffsetDateTime::now_utc();
        let cursor = send_at(&store, sender, branch_id, thread.id, "already read", base).await;
        let mut expected_ids = Vec::new();

        for index in 0..105 {
            let message = send_at(
                &store,
                sender,
                branch_id,
                thread.id,
                &format!("missed {index:03}"),
                base + time::Duration::seconds(i64::from(index + 1)),
            )
            .await;
            expected_ids.push(message.id);
        }

        let hub = Arc::new(PgRealtimeHub::new(
            pool.clone(),
            RealtimeHubConfig {
                connection_buffer: 8,
            },
        ));
        let mut reconnected = hub
            .connect(
                RealtimePrincipal {
                    user_id: recipient,
                    branch_scope: BranchScope::single(branch_id),
                    org_id: OrgId::knl(),
                },
                Some(cursor.id),
            )
            .await
            .unwrap();

        let mut delivered_ids = Vec::new();
        for _ in 0..expected_ids.len() {
            delivered_ids.push(recv_message_id(&mut reconnected).await);
        }

        assert_eq!(delivered_ids, expected_ids);
    })
    .await;
}

#[sqlx::test(migrations = "../db/migrations")]
async fn reconnect_replay_streams_backlog_larger_than_connection_buffer(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let branch_id = seed_branch(&pool).await;
        let sender = seed_user_with_branch(&pool, "buffer sender", "MECHANIC", branch_id).await;
        let recipient = seed_user_with_branch(&pool, "buffer recipient", "ADMIN", branch_id).await;
        let store = PgMessengerStore::new(pool.clone());
        let thread = create_thread(&store, sender, recipient, branch_id).await;
        let base = OffsetDateTime::now_utc();
        let cursor = send_at(&store, sender, branch_id, thread.id, "already read", base).await;
        let mut expected_ids = Vec::new();

        for index in 0..12 {
            let message = send_at(
                &store,
                sender,
                branch_id,
                thread.id,
                &format!("buffered replay {index:02}"),
                base + time::Duration::seconds(i64::from(index + 1)),
            )
            .await;
            expected_ids.push(message.id);
        }

        let hub = Arc::new(PgRealtimeHub::new(
            pool.clone(),
            RealtimeHubConfig {
                connection_buffer: 3,
            },
        ));
        let mut reconnected = hub
            .connect(
                RealtimePrincipal {
                    user_id: recipient,
                    branch_scope: BranchScope::single(branch_id),
                    org_id: OrgId::knl(),
                },
                Some(cursor.id),
            )
            .await
            .unwrap();

        let mut delivered_ids = Vec::new();
        for _ in 0..expected_ids.len() {
            delivered_ids.push(recv_message_id(&mut reconnected).await);
        }

        assert_eq!(delivered_ids, expected_ids);
        assert!(
            timeout(Duration::from_millis(50), reconnected.disconnect())
                .await
                .is_err(),
            "a draining client should not be disconnected just because replay exceeds the mpsc buffer"
        );
    })
    .await;
}

#[sqlx::test(migrations = "../db/migrations")]
async fn live_messages_during_replay_are_delivered_after_replay_without_duplicates(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let branch_id = seed_branch(&pool).await;
        let sender = seed_user_with_branch(&pool, "race sender", "MECHANIC", branch_id).await;
        let recipient = seed_user_with_branch(&pool, "race recipient", "ADMIN", branch_id).await;
        let store = PgMessengerStore::new(pool.clone());
        let thread = create_thread(&store, sender, recipient, branch_id).await;
        let base = OffsetDateTime::now_utc();
        let cursor = send_at(&store, sender, branch_id, thread.id, "already read", base).await;
        let mut expected_ids = Vec::new();

        for index in 0..5 {
            let message = send_at(
                &store,
                sender,
                branch_id,
                thread.id,
                &format!("missed before live {index}"),
                base + time::Duration::seconds(i64::from(index + 1)),
            )
            .await;
            expected_ids.push(message.id);
        }

        let hub = Arc::new(PgRealtimeHub::new(
            pool.clone(),
            RealtimeHubConfig {
                connection_buffer: 2,
            },
        ));
        let mut reconnected = hub
            .connect(
                RealtimePrincipal {
                    user_id: recipient,
                    branch_scope: BranchScope::single(branch_id),
                    org_id: OrgId::knl(),
                },
                Some(cursor.id),
            )
            .await
            .unwrap();

        let live = send_at(
            &store,
            sender,
            branch_id,
            thread.id,
            "live while replaying",
            base + time::Duration::seconds(10),
        )
        .await;
        expected_ids.push(live.id);
        hub.dispatch_local_for_test(
            OrgId::knl(),
            RealtimeEvent::MessagePosted {
                message: live.clone(),
            },
        )
        .await
        .unwrap();

        let mut delivered_ids = Vec::new();
        for _ in 0..expected_ids.len() {
            delivered_ids.push(recv_message_id(&mut reconnected).await);
        }

        assert_eq!(delivered_ids, expected_ids);
    })
    .await;
}

async fn seed_branch(pool: &PgPool) -> BranchId {
    let region_id = uuid::Uuid::new_v4();
    let branch_id = BranchId::new();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_realtime_branch").unwrap(),
        "branch",
        branch_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_branch(branch_id);
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
                .bind(region_id)
                .bind(format!("Realtime Region {}", uuid::Uuid::new_v4()))
                .bind(*OrgId::knl().as_uuid())
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
            sqlx::query(
                "INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(*branch_id.as_uuid())
            .bind(region_id)
            .bind(format!("Realtime Branch {}", uuid::Uuid::new_v4()))
            .bind(*OrgId::knl().as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<BranchId, DbError>(branch_id)
        })
    })
    .await
    .unwrap()
}

async fn create_thread(
    store: &PgMessengerStore,
    sender: UserId,
    recipient: UserId,
    branch_id: BranchId,
) -> mnt_messenger_application::ThreadSummary {
    store
        .create_thread(CreateThreadCommand {
            actor: sender,
            branch_scope: BranchScope::single(branch_id),
            branch_id,
            kind: ThreadKind::Team,
            visibility: None,
            title: Some("정비팀".to_owned()),
            work_order_id: None,
            member_ids: vec![sender, recipient],
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap()
}

async fn send_at(
    store: &PgMessengerStore,
    sender: UserId,
    branch_id: BranchId,
    thread_id: mnt_kernel_core::ThreadId,
    body: &str,
    occurred_at: OffsetDateTime,
) -> mnt_messenger_application::MessageSummary {
    store
        .send_message(SendMessageCommand {
            actor: sender,
            branch_scope: BranchScope::single(branch_id),
            thread_id,
            body: body.to_owned(),
            attachment_evidence_ids: Vec::new(),
            quoted_message_id: None,
            trace: TraceContext::generate(),
            occurred_at,
        })
        .await
        .unwrap()
}

async fn recv_message_id(
    connection: &mut mnt_platform_realtime::RealtimeConnection,
) -> mnt_kernel_core::MessageId {
    let delivered = timeout(Duration::from_secs(3), connection.recv())
        .await
        .expect("replay event should arrive")
        .expect("connection should stay open");
    let RealtimeEvent::MessagePosted { message } = delivered;
    message.id
}

async fn seed_user_with_branch(
    pool: &PgPool,
    name: &str,
    role: &str,
    branch_id: BranchId,
) -> UserId {
    let user_id = UserId::new();
    let name = name.to_owned();
    let role = role.to_owned();
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.seed_realtime_user").unwrap(),
        "user",
        user_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_branch(branch_id);
    with_audit(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(*user_id.as_uuid())
            .bind(format!("Realtime {name} {}", uuid::Uuid::new_v4()))
            .bind(Vec::from([role]))
            .bind(*OrgId::knl().as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            sqlx::query(
                "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)",
            )
            .bind(*user_id.as_uuid())
            .bind(*branch_id.as_uuid())
            .bind(*OrgId::knl().as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
    user_id
}
