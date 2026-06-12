#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use mnt_dispatch_adapter_postgres::PgDispatchStore;
use mnt_dispatch_application::{IncidentLocationInput, StartP1DispatchCommand};
use mnt_dispatch_domain::{DispatchStatus, DispatchTimerConfig};
use mnt_dispatch_worker::DispatchWorker;
use mnt_kernel_core::TraceContext;
use mnt_platform_jobs::{DispatchTimerJob, PlatformJob};
use mnt_platform_push::{
    AlimtalkMessage, BoxFuture, FcmPushMessage, ProviderMessageId, PushError, PushNotifier,
};
use sqlx::{PgPool, Row};
use time::macros::datetime;

#[path = "../../../../test_support/dispatch_worker_fixtures.rs"]
mod dispatch_worker_fixtures;

use dispatch_worker_fixtures::seed_dispatch_context;

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn timer_worker_delivers_alimtalk_and_manager_force_push(pool: PgPool) {
    let seeded = seed_dispatch_context(&pool).await;
    let store = PgDispatchStore::new(pool.clone());
    let now = datetime!(2026-06-12 09:00 UTC);
    let timers = DispatchTimerConfig::default();
    let started = store
        .start_dispatch(
            StartP1DispatchCommand {
                actor: seeded.receptionist,
                work_order_id: seeded.work_order_id,
                incident_location: Some(IncidentLocationInput {
                    latitude: 37.5651,
                    longitude: 126.9895,
                }),
                include_region: false,
                trace: TraceContext::generate(),
                occurred_at: now,
            },
            timers,
        )
        .await
        .unwrap();
    assert_eq!(started.target_count, 3);

    let notifier = Arc::new(RecordingNotifier::default());
    let worker = DispatchWorker::new(store.clone(), Some(notifier.clone()));

    worker
        .handle(PlatformJob::DispatchAlimtalkNoAck(DispatchTimerJob {
            dispatch_id: started.id,
            scheduled_for: now + timers.alimtalk_no_ack_after,
        }))
        .await
        .unwrap();

    assert_eq!(notifier.alimtalk_count(), 2);
    assert_eq!(
        alert_count(&pool, started.id, "ALIMTALK_NO_ACK", "SENT").await,
        2
    );

    worker
        .handle(PlatformJob::DispatchAcceptWindowExpired(DispatchTimerJob {
            dispatch_id: started.id,
            scheduled_for: started.accept_window_ends_at,
        }))
        .await
        .unwrap();

    let expired = store.dispatch(started.id).await.unwrap();
    assert_eq!(expired.status, DispatchStatus::ManagerForcePending);
    assert_eq!(notifier.fcm_count(), 1);
    assert_eq!(
        alert_count(&pool, started.id, "MANAGER_FORCE_ASSIGN", "SENT").await,
        1
    );
}

#[derive(Default)]
struct RecordingNotifier {
    fcm: Mutex<Vec<FcmPushMessage>>,
    alimtalk: Mutex<Vec<AlimtalkMessage>>,
}

impl RecordingNotifier {
    fn fcm_count(&self) -> usize {
        self.fcm.lock().unwrap().len()
    }

    fn alimtalk_count(&self) -> usize {
        self.alimtalk.lock().unwrap().len()
    }
}

impl PushNotifier for RecordingNotifier {
    fn send_fcm<'a>(
        &'a self,
        message: FcmPushMessage,
    ) -> BoxFuture<'a, Result<ProviderMessageId, PushError>> {
        Box::pin(async move {
            let mut sent = self.fcm.lock().unwrap();
            sent.push(message);
            Ok(ProviderMessageId(format!("fcm-{}", sent.len())))
        })
    }

    fn send_alimtalk<'a>(
        &'a self,
        message: AlimtalkMessage,
    ) -> BoxFuture<'a, Result<ProviderMessageId, PushError>> {
        Box::pin(async move {
            let mut sent = self.alimtalk.lock().unwrap();
            sent.push(message);
            Ok(ProviderMessageId(format!("alimtalk-{}", sent.len())))
        })
    }
}

async fn alert_count(
    pool: &PgPool,
    dispatch_id: mnt_kernel_core::P1DispatchId,
    alert_type: &str,
    status: &str,
) -> i64 {
    let row = sqlx::query(
        r#"
        SELECT COUNT(*) AS alert_count
        FROM p1_dispatch_alerts
        WHERE dispatch_id = $1
          AND alert_type = $2
          AND status = $3
          AND sent_at IS NOT NULL
          AND provider_message_id IS NOT NULL
        "#,
    )
    .bind(*dispatch_id.as_uuid())
    .bind(alert_type)
    .bind(status)
    .fetch_one(pool)
    .await
    .unwrap();
    row.try_get("alert_count").unwrap()
}
