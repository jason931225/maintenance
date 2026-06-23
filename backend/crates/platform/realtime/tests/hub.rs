#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_kernel_core::{BranchId, BranchScope, MessageId, OrgId, ThreadId, UserId};
use mnt_messenger_application::MessageSummary;
use mnt_platform_realtime::{
    DisconnectReason, PgRealtimeHub, RealtimeEvent, RealtimeHubConfig, RealtimePrincipal,
};
use time::OffsetDateTime;

#[tokio::test]
async fn failed_replay_connect_does_not_leave_an_orphaned_connection() {
    let hub = std::sync::Arc::new(PgRealtimeHub::for_tests(RealtimeHubConfig {
        connection_buffer: 1,
    }));

    let result = hub
        .connect(
            RealtimePrincipal {
                user_id: UserId::new(),
                branch_scope: BranchScope::All,
                org_id: OrgId::knl(),
            },
            Some(MessageId::new()),
        )
        .await;

    assert!(result.is_err());
    assert_eq!(hub.connection_count().await, 0);
}

#[tokio::test]
async fn bounded_mpsc_disconnects_lagging_connection_with_resume_cursor_policy() {
    let branch_id = BranchId::new();
    let user_id = UserId::new();
    let hub = std::sync::Arc::new(PgRealtimeHub::for_tests(RealtimeHubConfig {
        connection_buffer: 1,
    }));
    let mut connection = hub
        .connect(
            RealtimePrincipal {
                user_id,
                branch_scope: BranchScope::single(branch_id),
                org_id: OrgId::knl(),
            },
            None,
        )
        .await
        .unwrap();

    let first = message_event(branch_id, user_id, "queued but not yet read");
    hub.dispatch_local_for_test(OrgId::knl(), first.clone())
        .await
        .unwrap();

    let second = message_event(branch_id, user_id, "cannot fit in the bounded queue");
    hub.dispatch_local_for_test(OrgId::knl(), second)
        .await
        .unwrap();

    let disconnect = connection.disconnect().await.unwrap();
    assert_eq!(disconnect.reason, DisconnectReason::LaggingConsumer);
    assert_eq!(
        disconnect.resume_after, None,
        "server cannot guess which queued event the client actually processed; clients resume from their last acknowledged cursor"
    );
    assert_eq!(hub.connection_count().await, 0);
    assert_eq!(connection.recv().await.unwrap(), first);
    assert!(
        connection.recv().await.is_none(),
        "lagging connections close after draining already queued events"
    );
}

fn message_event(branch_id: BranchId, sender_id: UserId, body: &str) -> RealtimeEvent {
    RealtimeEvent::MessagePosted {
        message: MessageSummary {
            id: MessageId::new(),
            thread_id: ThreadId::new(),
            branch_id,
            sender_id,
            sender_name: Some("Sender".to_owned()),
            body: body.to_owned(),
            attachment_evidence_ids: Vec::new(),
            sent_at: OffsetDateTime::now_utc(),
            created_at: OffsetDateTime::now_utc(),
        },
    }
}
