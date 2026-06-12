//! Dispatch timer worker handlers.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeMap;
use std::sync::Arc;

use mnt_dispatch_adapter_postgres::{
    PendingAlimtalkAlert, PendingFcmPush, PgDispatchError, PgDispatchStore,
};
use mnt_dispatch_application::ExpireP1DispatchCommand;
use mnt_kernel_core::TraceContext;
use mnt_platform_jobs::{
    BoxFuture, DispatchTimerJob, JobQueueError, PlatformJob, PlatformJobHandler,
};
use mnt_platform_push::{AlimtalkMessage, FcmPushMessage, PushError, PushNotifier};

#[derive(Debug, thiserror::Error)]
pub enum DispatchWorkerError {
    #[error(transparent)]
    Dispatch(#[from] PgDispatchError),

    #[error("unsupported job for dispatch worker")]
    UnsupportedJob,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlimtalkEscalationPolicy {
    enabled: bool,
}

impl AlimtalkEscalationPolicy {
    #[must_use]
    pub const fn enabled() -> Self {
        Self { enabled: true }
    }

    #[must_use]
    pub const fn disabled() -> Self {
        Self { enabled: false }
    }

    #[must_use]
    pub const fn is_enabled(self) -> bool {
        self.enabled
    }
}

const ALIMTALK_DISABLED_REASON: &str =
    "Solapi Alimtalk disabled: approved dispatch template id is not configured";

#[derive(Clone)]
pub struct DispatchWorker {
    store: PgDispatchStore,
    push_notifier: Option<Arc<dyn PushNotifier>>,
    alimtalk_policy: AlimtalkEscalationPolicy,
}

impl DispatchWorker {
    #[must_use]
    pub fn new(
        store: PgDispatchStore,
        push_notifier: Option<Arc<dyn PushNotifier>>,
        alimtalk_policy: AlimtalkEscalationPolicy,
    ) -> Self {
        Self {
            store,
            push_notifier,
            alimtalk_policy,
        }
    }

    pub async fn handle(&self, job: PlatformJob) -> Result<(), DispatchWorkerError> {
        match job {
            PlatformJob::DispatchAcceptWindowExpired(job) => {
                self.handle_accept_window(job).await?;
                Ok(())
            }
            PlatformJob::DispatchAlimtalkNoAck(job) => {
                self.handle_alimtalk_no_ack(job).await?;
                Ok(())
            }
            PlatformJob::DispatchManualCallRequired(job) => {
                self.handle_manual_call_required(job).await?;
                Ok(())
            }
            PlatformJob::EscalationTimer(_) => Err(DispatchWorkerError::UnsupportedJob),
        }
    }

    async fn handle_accept_window(&self, job: DispatchTimerJob) -> Result<(), DispatchWorkerError> {
        self.store
            .expire_accept_window(ExpireP1DispatchCommand {
                dispatch_id: job.dispatch_id,
                trace: TraceContext::generate(),
                occurred_at: job.scheduled_for,
            })
            .await?;
        self.deliver_manager_force_alerts(job.dispatch_id).await?;
        Ok(())
    }

    async fn handle_alimtalk_no_ack(
        &self,
        job: DispatchTimerJob,
    ) -> Result<(), DispatchWorkerError> {
        self.store
            .mark_alimtalk_no_ack(ExpireP1DispatchCommand {
                dispatch_id: job.dispatch_id,
                trace: TraceContext::generate(),
                occurred_at: job.scheduled_for,
            })
            .await?;
        self.deliver_alimtalk_no_ack_alerts(job.dispatch_id).await?;
        Ok(())
    }

    async fn handle_manual_call_required(
        &self,
        job: DispatchTimerJob,
    ) -> Result<(), DispatchWorkerError> {
        self.store
            .mark_manual_call_required(ExpireP1DispatchCommand {
                dispatch_id: job.dispatch_id,
                trace: TraceContext::generate(),
                occurred_at: job.scheduled_for,
            })
            .await?;
        Ok(())
    }

    async fn deliver_alimtalk_no_ack_alerts(
        &self,
        dispatch_id: mnt_kernel_core::P1DispatchId,
    ) -> Result<(), DispatchWorkerError> {
        let alerts = self
            .store
            .pending_alimtalk_no_ack_alerts(dispatch_id)
            .await?;
        if alerts.is_empty() {
            return Ok(());
        }
        if !self.alimtalk_policy.is_enabled() {
            self.skip_alimtalk_alerts(alerts, ALIMTALK_DISABLED_REASON)
                .await?;
            return Ok(());
        }
        let Some(notifier) = self.push_notifier.as_ref() else {
            self.skip_alimtalk_alerts(alerts, ALIMTALK_DISABLED_REASON)
                .await?;
            return Ok(());
        };
        for alert in alerts {
            self.send_alimtalk(notifier.as_ref(), alert, "P1 emergency dispatch")
                .await?;
        }
        Ok(())
    }

    async fn deliver_manager_force_alerts(
        &self,
        dispatch_id: mnt_kernel_core::P1DispatchId,
    ) -> Result<(), DispatchWorkerError> {
        let Some(notifier) = self.push_notifier.as_ref() else {
            return Ok(());
        };
        let pushes = self.store.pending_manager_force_pushes(dispatch_id).await?;
        for push in pushes {
            self.send_manager_push(notifier.as_ref(), push).await?;
        }
        let fallback_alerts = self
            .store
            .pending_manager_force_alimtalks(dispatch_id)
            .await?;
        for alert in fallback_alerts {
            if self.alimtalk_policy.is_enabled() {
                self.send_alimtalk(
                    notifier.as_ref(),
                    alert,
                    "P1 dispatch needs manager assignment",
                )
                .await?;
            } else {
                self.store
                    .mark_alert_skipped(
                        alert.alert_id,
                        ALIMTALK_DISABLED_REASON.to_owned(),
                        TraceContext::generate(),
                        time::OffsetDateTime::now_utc(),
                    )
                    .await?;
            }
        }
        Ok(())
    }

    async fn send_manager_push(
        &self,
        notifier: &dyn PushNotifier,
        push: PendingFcmPush,
    ) -> Result<(), DispatchWorkerError> {
        let message = FcmPushMessage {
            token: push.push_token,
            title: "P1 dispatch requires assignment".to_owned(),
            body: "No technician accepted before the deadline".to_owned(),
            data: BTreeMap::from([
                ("type".to_owned(), "p1_dispatch_manager_force".to_owned()),
                ("dispatch_id".to_owned(), push.dispatch_id.to_string()),
                ("work_order_id".to_owned(), push.work_order_id.to_string()),
            ]),
        };
        match notifier.send_fcm(message).await {
            Ok(provider_id) => {
                self.store
                    .mark_alert_sent(
                        push.alert_id,
                        non_empty_provider_id(provider_id.0),
                        TraceContext::generate(),
                        time::OffsetDateTime::now_utc(),
                    )
                    .await?;
            }
            Err(err) => {
                self.store
                    .mark_alert_failed(
                        push.alert_id,
                        provider_failure_reason(err),
                        TraceContext::generate(),
                        time::OffsetDateTime::now_utc(),
                    )
                    .await?;
            }
        }
        Ok(())
    }

    async fn send_alimtalk(
        &self,
        notifier: &dyn PushNotifier,
        alert: PendingAlimtalkAlert,
        title: &'static str,
    ) -> Result<(), DispatchWorkerError> {
        let message = AlimtalkMessage {
            to: alert.phone,
            variables: BTreeMap::from([
                ("title".to_owned(), title.to_owned()),
                ("dispatch_id".to_owned(), alert.dispatch_id.to_string()),
                ("work_order_id".to_owned(), alert.work_order_id.to_string()),
            ]),
        };
        match notifier.send_alimtalk(message).await {
            Ok(provider_id) => {
                self.store
                    .mark_alert_sent(
                        alert.alert_id,
                        non_empty_provider_id(provider_id.0),
                        TraceContext::generate(),
                        time::OffsetDateTime::now_utc(),
                    )
                    .await?;
            }
            Err(PushError::Config(message)) => {
                self.store
                    .mark_alert_skipped(
                        alert.alert_id,
                        format!("Solapi Alimtalk disabled: {message}"),
                        TraceContext::generate(),
                        time::OffsetDateTime::now_utc(),
                    )
                    .await?;
            }
            Err(err) => {
                self.store
                    .mark_alert_failed(
                        alert.alert_id,
                        provider_failure_reason(err),
                        TraceContext::generate(),
                        time::OffsetDateTime::now_utc(),
                    )
                    .await?;
            }
        }
        Ok(())
    }

    async fn skip_alimtalk_alerts(
        &self,
        alerts: Vec<PendingAlimtalkAlert>,
        reason: &str,
    ) -> Result<(), DispatchWorkerError> {
        for alert in alerts {
            self.store
                .mark_alert_skipped(
                    alert.alert_id,
                    reason.to_owned(),
                    TraceContext::generate(),
                    time::OffsetDateTime::now_utc(),
                )
                .await?;
        }
        Ok(())
    }
}

impl PlatformJobHandler for DispatchWorker {
    fn handle<'a>(&'a self, job: PlatformJob) -> BoxFuture<'a, Result<(), JobQueueError>> {
        Box::pin(async move {
            DispatchWorker::handle(self, job)
                .await
                .map_err(|err| JobQueueError::Worker(err.to_string()))
        })
    }
}

fn non_empty_provider_id(value: String) -> Option<String> {
    if value.is_empty() { None } else { Some(value) }
}

fn provider_failure_reason(err: PushError) -> String {
    let message = err.to_string();
    if message.len() > 512 {
        message.chars().take(512).collect()
    } else {
        message
    }
}
