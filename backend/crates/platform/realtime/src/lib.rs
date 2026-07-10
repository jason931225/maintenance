//! Realtime platform surface.
//!
//! PostgreSQL remains the source of truth. `LISTEN/NOTIFY` carries only IDs
//! and wakes local WebSocket hubs so they can re-read messages before fan-out.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use mnt_kernel_core::{BranchId, BranchScope, ErrorKind, MessageId, OrgId, ThreadId, UserId};
use mnt_messenger_application::{
    MessageNotifier, MessageNotifyFuture, MessagePostedNotification, MessageSummary,
};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_db::{DbError, with_org_conn};
use mnt_platform_request_context::{RequestContextError, current_org};
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgListener;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use tokio::sync::{Mutex, mpsc, watch};

pub const MESSAGE_POSTED_CHANNEL: &str = "message_posted";
pub const NOTIFY_PAYLOAD_LIMIT_BYTES: usize = 8000;
pub const DEFAULT_CONNECTION_BUFFER: usize = 64;
pub const REPLAY_PAGE_SIZE: i64 = 100;
pub const REPLAY_SEND_TIMEOUT: Duration = Duration::from_secs(30);
pub const WS_ROUTE_PATHS: &[&str] = &["/api/v1/ws"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageNotifyPayload {
    pub message_id: MessageId,
    pub thread_id: ThreadId,
    /// The tenant that owns the posted message. Realtime is a background
    /// LISTEN/NOTIFY task with NO request context, so `current_org()` is not
    /// available in the listener; the publisher carries the org here so the
    /// listener can arm `app.current_org` before reading FORCE-RLS tables.
    pub org_id: OrgId,
}

impl MessageNotifyPayload {
    #[must_use]
    pub fn from_notification(notification: MessagePostedNotification, org_id: OrgId) -> Self {
        Self {
            message_id: notification.message_id,
            thread_id: notification.thread_id,
            org_id,
        }
    }

    pub fn to_json_bytes(&self) -> Result<Vec<u8>, NotifyPayloadError> {
        let bytes = serde_json::to_vec(self)?;
        validate_payload_size(&bytes)?;
        Ok(bytes)
    }

    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, NotifyPayloadError> {
        validate_payload_size(bytes)?;
        Ok(serde_json::from_slice(bytes)?)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum NotifyPayloadError {
    #[error("NOTIFY payload is {size} bytes; it must be below {limit} bytes")]
    PayloadTooLarge { size: usize, limit: usize },

    #[error(transparent)]
    Serialize(#[from] serde_json::Error),

    #[error(transparent)]
    Database(#[from] sqlx::Error),

    #[error(transparent)]
    RequestContext(#[from] RequestContextError),
}

#[derive(Debug, thiserror::Error)]
pub enum RealtimeError {
    #[error("database is not configured for realtime")]
    DatabaseNotConfigured,

    #[error(transparent)]
    Database(#[from] sqlx::Error),

    #[error(transparent)]
    NotifyPayload(#[from] NotifyPayloadError),

    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    RequestContext(#[from] RequestContextError),

    #[error("realtime connection closed during replay")]
    ConnectionClosed,

    #[error("realtime replay consumer did not drain within {timeout:?}")]
    ReplayTimedOut { timeout: Duration },
}

#[derive(Debug, Clone)]
pub struct PostgresMessageNotifier {
    pool: PgPool,
}

impl PostgresMessageNotifier {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn notify_message_posted(
        &self,
        notification: MessagePostedNotification,
    ) -> Result<(), NotifyPayloadError> {
        // The publisher runs inside the message-send request task, where the
        // tenant is armed, so `current_org()` resolves the org to stamp onto the
        // payload. The background listener has no request context and reads it
        // back to arm `app.current_org` before any FORCE-RLS table read.
        let org = current_org()?;
        let payload = MessageNotifyPayload::from_notification(notification, org).to_json_bytes()?;
        Self::validate_payload_size_for_test(&payload)?;
        let payload = String::from_utf8(payload).map_err(|err| {
            serde_json::Error::io(std::io::Error::new(std::io::ErrorKind::InvalidData, err))
        })?;

        sqlx::query("SELECT pg_notify($1, $2)")
            .bind(MESSAGE_POSTED_CHANNEL)
            .bind(payload)
            // rls-arming: ok pg_notify is not a tenant-table read
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub fn validate_payload_size_for_test(bytes: &[u8]) -> Result<(), NotifyPayloadError> {
        validate_payload_size(bytes)
    }
}

impl MessageNotifier for PostgresMessageNotifier {
    fn message_posted(&self, notification: MessagePostedNotification) -> MessageNotifyFuture<'_> {
        Box::pin(async move {
            if let Err(err) = self.notify_message_posted(notification).await {
                tracing::error!(error = %err, "failed to publish messenger realtime notification");
            }
        })
    }
}

fn validate_payload_size(bytes: &[u8]) -> Result<(), NotifyPayloadError> {
    if bytes.len() >= NOTIFY_PAYLOAD_LIMIT_BYTES {
        Err(NotifyPayloadError::PayloadTooLarge {
            size: bytes.len(),
            limit: NOTIFY_PAYLOAD_LIMIT_BYTES,
        })
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RealtimeEvent {
    MessagePosted { message: MessageSummary },
}

impl RealtimeEvent {
    fn message_id(&self) -> MessageId {
        match self {
            Self::MessagePosted { message } => message.id,
        }
    }

    fn cursor(&self) -> MessageCursor {
        match self {
            Self::MessagePosted { message } => MessageCursor {
                sent_at: message.sent_at,
                id: message.id,
            },
        }
    }

    fn branch_id(&self) -> BranchId {
        match self {
            Self::MessagePosted { message } => message.branch_id,
        }
    }

    fn thread_id(&self) -> ThreadId {
        match self {
            Self::MessagePosted { message } => message.thread_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct MessageCursor {
    sent_at: time::OffsetDateTime,
    id: MessageId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeHubConfig {
    pub connection_buffer: usize,
}

impl Default for RealtimeHubConfig {
    fn default() -> Self {
        Self {
            connection_buffer: DEFAULT_CONNECTION_BUFFER,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimePrincipal {
    pub user_id: UserId,
    pub branch_scope: BranchScope,
    /// The subscriber's tenant, taken from the authenticated WS session's JWT
    /// `org` claim. Replay reads run in a background task with no request
    /// context, so this org arms `app.current_org` for the subscriber's own
    /// FORCE-RLS reads.
    pub org_id: OrgId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisconnectReason {
    LaggingConsumer,
    ReplayFailed,
    ServerShutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisconnectNotice {
    pub reason: DisconnectReason,
    pub resume_after: Option<MessageId>,
}

#[derive(Debug)]
pub struct RealtimeConnection {
    id: uuid::Uuid,
    events_rx: mpsc::Receiver<RealtimeEvent>,
    disconnect_rx: mpsc::UnboundedReceiver<DisconnectNotice>,
}

impl RealtimeConnection {
    #[must_use]
    pub fn id(&self) -> uuid::Uuid {
        self.id
    }

    pub async fn recv(&mut self) -> Option<RealtimeEvent> {
        self.events_rx.recv().await
    }

    pub async fn disconnect(&mut self) -> Option<DisconnectNotice> {
        self.disconnect_rx.recv().await
    }

    fn into_parts(
        self,
    ) -> (
        uuid::Uuid,
        mpsc::Receiver<RealtimeEvent>,
        mpsc::UnboundedReceiver<DisconnectNotice>,
    ) {
        (self.id, self.events_rx, self.disconnect_rx)
    }
}

#[derive(Debug)]
struct ConnectionSlot {
    principal: RealtimePrincipal,
    events_tx: mpsc::Sender<RealtimeEvent>,
    disconnect_tx: mpsc::UnboundedSender<DisconnectNotice>,
    delivery_state: ConnectionDeliveryState,
}

#[derive(Debug)]
enum ConnectionDeliveryState {
    Live,
    Replaying {
        buffered_events: Vec<RealtimeEvent>,
        replay_cursor: Option<MessageCursor>,
    },
}

#[derive(Debug)]
pub struct PgRealtimeHub {
    pool: Option<PgPool>,
    config: RealtimeHubConfig,
    connections: Mutex<HashMap<uuid::Uuid, ConnectionSlot>>,
}

impl PgRealtimeHub {
    #[must_use]
    pub fn new(pool: PgPool, config: RealtimeHubConfig) -> Self {
        Self {
            pool: Some(pool),
            config,
            connections: Mutex::new(HashMap::new()),
        }
    }

    #[must_use]
    pub fn for_tests(config: RealtimeHubConfig) -> Self {
        Self {
            pool: None,
            config,
            connections: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connect(
        self: &Arc<Self>,
        principal: RealtimePrincipal,
        last_message_id: Option<MessageId>,
    ) -> Result<RealtimeConnection, RealtimeError> {
        if last_message_id.is_some() && self.pool.is_none() {
            return Err(RealtimeError::DatabaseNotConfigured);
        }

        let capacity = self.config.connection_buffer.max(1);
        let (events_tx, events_rx) = mpsc::channel(capacity);
        let (disconnect_tx, disconnect_rx) = mpsc::unbounded_channel();
        let id = uuid::Uuid::new_v4();
        let delivery_state = if last_message_id.is_some() {
            ConnectionDeliveryState::Replaying {
                buffered_events: Vec::new(),
                replay_cursor: None,
            }
        } else {
            ConnectionDeliveryState::Live
        };
        self.connections.lock().await.insert(
            id,
            ConnectionSlot {
                principal: principal.clone(),
                events_tx,
                disconnect_tx,
                delivery_state,
            },
        );

        if let Some(last_message_id) = last_message_id {
            let hub = Arc::clone(self);
            tokio::spawn(async move {
                hub.run_replay(id, principal, last_message_id).await;
            });
        }

        Ok(RealtimeConnection {
            id,
            events_rx,
            disconnect_rx,
        })
    }

    pub async fn connection_count(&self) -> usize {
        self.connections.lock().await.len()
    }

    pub async fn remove_connection(&self, connection_id: uuid::Uuid) {
        self.connections.lock().await.remove(&connection_id);
    }

    pub async fn dispatch_local_for_test(
        &self,
        org: OrgId,
        event: RealtimeEvent,
    ) -> Result<(), RealtimeError> {
        self.dispatch_event(org, event, None).await
    }

    pub async fn shutdown(&self) {
        let mut connections = self.connections.lock().await;
        for (_, slot) in connections.drain() {
            let _ = slot.disconnect_tx.send(DisconnectNotice {
                reason: DisconnectReason::ServerShutdown,
                resume_after: None,
            });
        }
    }

    pub async fn start_postgres_listener(
        self: Arc<Self>,
    ) -> Result<PostgresBridgeHandle, RealtimeError> {
        let pool = self
            .pool
            .as_ref()
            .ok_or(RealtimeError::DatabaseNotConfigured)?
            .clone();
        let mut listener = PgListener::connect_with(&pool).await?;
        listener.listen(MESSAGE_POSTED_CHANNEL).await?;
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let hub = Arc::clone(&self);

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    notification = listener.recv() => {
                        match notification {
                            Ok(notification) => {
                                if notification.channel() == MESSAGE_POSTED_CHANNEL
                                    && let Err(err) = hub.handle_notify_payload(notification.payload()).await
                                {
                                    tracing::warn!(error = %err, "failed to handle messenger realtime notification");
                                }
                            }
                            Err(err) => {
                                tracing::warn!(error = %err, "Postgres realtime listener failed; retrying");
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                        }
                    }
                }
            }
        });

        Ok(PostgresBridgeHandle { shutdown_tx })
    }

    async fn handle_notify_payload(&self, payload: &str) -> Result<(), RealtimeError> {
        let payload = MessageNotifyPayload::from_json_bytes(payload.as_bytes())?;
        // The listener has no request context; the org rides on the payload and
        // scopes every FORCE-RLS read triggered by this notification.
        let org = payload.org_id;
        let message = self
            .fetch_message(org, payload.message_id, payload.thread_id)
            .await?;
        self.dispatch_event(org, RealtimeEvent::MessagePosted { message }, None)
            .await
    }

    async fn run_replay(
        self: Arc<Self>,
        connection_id: uuid::Uuid,
        principal: RealtimePrincipal,
        last_message_id: MessageId,
    ) {
        let result = async {
            self.replay_after(connection_id, &principal, last_message_id)
                .await?;
            self.finish_replay(connection_id).await
        }
        .await;

        if let Err(err) = result {
            tracing::warn!(error = %err, "realtime replay failed");
            let resume_after = self.replay_resume_after(connection_id).await;
            self.disconnect_connection(connection_id, DisconnectReason::ReplayFailed, resume_after)
                .await;
        }
    }

    async fn replay_after(
        &self,
        connection_id: uuid::Uuid,
        principal: &RealtimePrincipal,
        last_message_id: MessageId,
    ) -> Result<(), RealtimeError> {
        let pool = self
            .pool
            .as_ref()
            .ok_or(RealtimeError::DatabaseNotConfigured)?;
        // Replay runs in a spawned task with no request context, so the org is
        // carried from the authenticated subscriber session (`principal.org_id`)
        // and arms `app.current_org` for every FORCE-RLS read below.
        let org = principal.org_id;
        let last_message_uuid = *last_message_id.as_uuid();
        let cursor_row = with_org_conn::<_, _, RealtimeError>(pool, org, move |tx| {
            Box::pin(async move {
                Ok(
                    sqlx::query("SELECT sent_at, id FROM messenger_messages WHERE id = $1")
                        .bind(last_message_uuid)
                        .fetch_optional(tx.as_mut())
                        .await?,
                )
            })
        })
        .await?;
        let Some(cursor) = cursor_row else {
            return Ok(());
        };
        let mut cursor = MessageCursor {
            sent_at: cursor.try_get("sent_at")?,
            id: MessageId::from_uuid(cursor.try_get("id")?),
        };

        loop {
            let cursor_sent_at = cursor.sent_at;
            let cursor_id = *cursor.id.as_uuid();
            let branch_scope = principal.branch_scope.clone();
            let user_uuid = *principal.user_id.as_uuid();
            let rows = with_org_conn::<_, _, RealtimeError>(pool, org, move |tx| {
                Box::pin(async move {
                    let mut builder = message_select_builder();
                    builder.push(
                        r#"
                JOIN messenger_thread_members tm
                  ON tm.thread_id = m.thread_id
                 AND tm.user_id =
                "#,
                    );
                    builder.push_bind(user_uuid);
                    builder.push(" WHERE (m.sent_at, m.id) > (");
                    builder.push_bind(cursor_sent_at);
                    builder.push(", ");
                    builder.push_bind(cursor_id);
                    builder.push(")");
                    push_scope_filter(&mut builder, "m.branch_id", &branch_scope);
                    builder.push(" GROUP BY m.id, sender.display_name ORDER BY m.sent_at ASC, m.id ASC LIMIT ");
                    builder.push_bind(REPLAY_PAGE_SIZE);
                    Ok(builder.build().fetch_all(tx.as_mut()).await?)
                })
            })
            .await?;
            if rows.is_empty() {
                break;
            }

            let row_count = rows.len();
            for row in rows {
                let message = message_summary_from_row(&row)?;
                cursor = MessageCursor {
                    sent_at: message.sent_at,
                    id: message.id,
                };
                let event = RealtimeEvent::MessagePosted { message };
                if !self.send_replay_event(connection_id, event).await? {
                    return Ok(());
                }
            }

            if row_count < usize::try_from(REPLAY_PAGE_SIZE).unwrap_or(usize::MAX) {
                break;
            }
        }
        Ok(())
    }

    async fn fetch_message(
        &self,
        org: OrgId,
        message_id: MessageId,
        thread_id: ThreadId,
    ) -> Result<MessageSummary, RealtimeError> {
        let pool = self
            .pool
            .as_ref()
            .ok_or(RealtimeError::DatabaseNotConfigured)?;
        let message_uuid = *message_id.as_uuid();
        let thread_uuid = *thread_id.as_uuid();
        // The org is carried from the NOTIFY payload; arm it so this read sees
        // the publishing tenant's FORCE-RLS rows.
        with_org_conn::<_, _, RealtimeError>(pool, org, move |tx| {
            Box::pin(async move {
                let mut builder = message_select_builder();
                builder.push(" WHERE m.id = ");
                builder.push_bind(message_uuid);
                builder.push(" AND m.thread_id = ");
                builder.push_bind(thread_uuid);
                builder.push(" GROUP BY m.id, sender.display_name");
                let row = builder.build().fetch_one(tx.as_mut()).await?;
                message_summary_from_row(&row).map_err(|err| RealtimeError::Db(DbError::Sqlx(err)))
            })
        })
        .await
    }

    async fn dispatch_event(
        &self,
        org: OrgId,
        event: RealtimeEvent,
        authorized_users: Option<HashSet<UserId>>,
    ) -> Result<(), RealtimeError> {
        let branch_id = event.branch_id();
        let candidate_users = if authorized_users.is_some() || self.pool.is_none() {
            authorized_users
        } else {
            let candidates = {
                let connections = self.connections.lock().await;
                connections
                    .values()
                    .filter(|slot| slot.principal.branch_scope.allows(branch_id))
                    .map(|slot| slot.principal.user_id)
                    .collect::<Vec<_>>()
            };
            Some(
                self.authorized_thread_members(org, event.thread_id(), candidates)
                    .await?,
            )
        };

        let targets = {
            let connections = self.connections.lock().await;
            connections
                .iter()
                .filter(|(_, slot)| slot.principal.branch_scope.allows(branch_id))
                .filter(|(_, slot)| {
                    candidate_users
                        .as_ref()
                        .is_none_or(|users| users.contains(&slot.principal.user_id))
                })
                .map(|(id, _)| *id)
                .collect::<Vec<_>>()
        };

        for connection_id in targets {
            self.dispatch_to_connection(connection_id, event.clone(), None)
                .await;
        }
        Ok(())
    }

    async fn send_replay_event(
        &self,
        connection_id: uuid::Uuid,
        event: RealtimeEvent,
    ) -> Result<bool, RealtimeError> {
        let cursor = event.cursor();
        let events_tx = {
            let connections = self.connections.lock().await;
            let Some(slot) = connections.get(&connection_id) else {
                return Ok(false);
            };
            slot.events_tx.clone()
        };

        match tokio::time::timeout(REPLAY_SEND_TIMEOUT, events_tx.send(event)).await {
            Ok(Ok(())) => {
                self.mark_replay_cursor(connection_id, cursor).await;
                Ok(true)
            }
            Ok(Err(_)) => {
                self.remove_connection(connection_id).await;
                Err(RealtimeError::ConnectionClosed)
            }
            Err(_) => {
                let resume_after = self.replay_resume_after(connection_id).await;
                self.disconnect_connection(
                    connection_id,
                    DisconnectReason::LaggingConsumer,
                    resume_after,
                )
                .await;
                Err(RealtimeError::ReplayTimedOut {
                    timeout: REPLAY_SEND_TIMEOUT,
                })
            }
        }
    }

    async fn finish_replay(&self, connection_id: uuid::Uuid) -> Result<(), RealtimeError> {
        loop {
            let events = {
                let mut connections = self.connections.lock().await;
                let Some(slot) = connections.get_mut(&connection_id) else {
                    return Ok(());
                };
                match &mut slot.delivery_state {
                    ConnectionDeliveryState::Live => return Ok(()),
                    ConnectionDeliveryState::Replaying {
                        buffered_events,
                        replay_cursor,
                    } => {
                        if buffered_events.is_empty() {
                            slot.delivery_state = ConnectionDeliveryState::Live;
                            return Ok(());
                        }
                        let replay_cursor = *replay_cursor;
                        let mut events = std::mem::take(buffered_events);
                        events.sort_by_key(RealtimeEvent::cursor);
                        let mut seen = HashSet::new();
                        events.retain(|event| {
                            let cursor = event.cursor();
                            replay_cursor.is_none_or(|replay_cursor| cursor > replay_cursor)
                                && seen.insert(event.message_id())
                        });
                        events
                    }
                }
            };

            for event in events {
                if !self.send_replay_event(connection_id, event).await? {
                    return Ok(());
                }
            }
        }
    }

    async fn mark_replay_cursor(&self, connection_id: uuid::Uuid, cursor: MessageCursor) {
        let mut connections = self.connections.lock().await;
        if let Some(slot) = connections.get_mut(&connection_id)
            && let ConnectionDeliveryState::Replaying { replay_cursor, .. } =
                &mut slot.delivery_state
        {
            *replay_cursor = Some(cursor);
        }
    }

    async fn replay_resume_after(&self, connection_id: uuid::Uuid) -> Option<MessageId> {
        let connections = self.connections.lock().await;
        connections
            .get(&connection_id)
            .and_then(|slot| match &slot.delivery_state {
                ConnectionDeliveryState::Live => None,
                ConnectionDeliveryState::Replaying { replay_cursor, .. } => {
                    replay_cursor.map(|cursor| cursor.id)
                }
            })
    }

    async fn disconnect_connection(
        &self,
        connection_id: uuid::Uuid,
        reason: DisconnectReason,
        resume_after: Option<MessageId>,
    ) {
        let mut connections = self.connections.lock().await;
        if let Some(slot) = connections.remove(&connection_id) {
            let _ = slot.disconnect_tx.send(DisconnectNotice {
                reason,
                resume_after,
            });
        }
    }

    async fn dispatch_to_connection(
        &self,
        connection_id: uuid::Uuid,
        event: RealtimeEvent,
        resume_after: Option<MessageId>,
    ) {
        let mut connections = self.connections.lock().await;
        let Some(slot) = connections.get_mut(&connection_id) else {
            return;
        };

        let mut disconnect_resume_after = None;
        match &mut slot.delivery_state {
            ConnectionDeliveryState::Live => {
                if slot.events_tx.try_send(event).is_err() {
                    disconnect_resume_after = Some(resume_after);
                }
            }
            ConnectionDeliveryState::Replaying {
                buffered_events,
                replay_cursor,
            } => {
                if buffered_events.len() >= self.config.connection_buffer.max(1) {
                    disconnect_resume_after =
                        Some(replay_cursor.map(|cursor| cursor.id).or(resume_after));
                } else {
                    buffered_events.push(event);
                }
            }
        }

        if let Some(resume_after) = disconnect_resume_after
            && let Some(slot) = connections.remove(&connection_id)
        {
            let _ = slot.disconnect_tx.send(DisconnectNotice {
                reason: DisconnectReason::LaggingConsumer,
                resume_after,
            });
        }
    }

    async fn authorized_thread_members(
        &self,
        org: OrgId,
        thread_id: ThreadId,
        candidates: Vec<UserId>,
    ) -> Result<HashSet<UserId>, RealtimeError> {
        let Some(pool) = &self.pool else {
            return Ok(candidates.into_iter().collect());
        };
        if candidates.is_empty() {
            return Ok(HashSet::new());
        }
        let candidate_ids = candidates
            .into_iter()
            .map(|user_id| *user_id.as_uuid())
            .collect::<Vec<_>>();
        let thread_uuid = *thread_id.as_uuid();
        // The org is carried from the NOTIFY payload; arm it so the membership
        // read sees the publishing tenant's FORCE-RLS rows.
        let rows: Vec<uuid::Uuid> = with_org_conn::<_, _, RealtimeError>(pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    r#"
            SELECT user_id
            FROM messenger_thread_members
            WHERE thread_id = $1
              AND user_id = ANY($2)
            "#,
                )
                .bind(thread_uuid)
                .bind(candidate_ids)
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;

        Ok(rows.into_iter().map(UserId::from_uuid).collect())
    }
}

#[derive(Debug, Clone)]
pub struct PostgresBridgeHandle {
    shutdown_tx: watch::Sender<bool>,
}

impl PostgresBridgeHandle {
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

#[derive(Debug, Clone)]
pub struct RealtimeRestState {
    hub: Arc<PgRealtimeHub>,
    jwt_verifier: Option<JwtVerifier>,
}

impl RealtimeRestState {
    #[must_use]
    pub fn new(hub: Arc<PgRealtimeHub>, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self { hub, jwt_verifier }
    }

    #[must_use]
    pub fn hub(&self) -> &Arc<PgRealtimeHub> {
        &self.hub
    }
}

pub fn router(state: RealtimeRestState) -> Router {
    Router::new()
        .route("/api/v1/ws", get(websocket_handler))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    last_message_id: Option<MessageId>,
}

async fn websocket_handler(
    State(state): State<RealtimeRestState>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, RealtimeApiError> {
    let principal = principal_from_headers(&state, &headers).await?;
    Ok(ws
        // Browser clients carry the bearer token as a `Sec-WebSocket-Protocol`
        // subprotocol pair (`bearer, <token>`); the WebSocket handshake REQUIRES
        // the server to echo one offered subprotocol, so select `bearer` to
        // complete the handshake (without this the browser aborts with "Sent
        // non-empty 'Sec-WebSocket-Protocol' header but no response was received").
        .protocols(["bearer"])
        .on_upgrade(move |socket| {
            websocket_session(state, principal, query.last_message_id, socket)
        })
        .into_response())
}

async fn websocket_session(
    state: RealtimeRestState,
    principal: RealtimePrincipal,
    last_message_id: Option<MessageId>,
    mut socket: WebSocket,
) {
    let connection = match state.hub.connect(principal, last_message_id).await {
        Ok(connection) => connection,
        Err(err) => {
            tracing::warn!(error = %err, "realtime websocket connect failed");
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 1011,
                    reason: "realtime unavailable".into(),
                })))
                .await;
            return;
        }
    };
    let (connection_id, mut events_rx, mut disconnect_rx) = connection.into_parts();

    loop {
        tokio::select! {
            notice = disconnect_rx.recv() => {
                if let Some(notice) = notice {
                    let (code, reason) = close_frame_for_notice(&notice);
                    let _ = socket
                        .send(Message::Close(Some(CloseFrame { code, reason: reason.into() })))
                        .await;
                }
                break;
            }
            event = events_rx.recv() => {
                let Some(event) = event else {
                    break;
                };
                match serde_json::to_string(&event) {
                    Ok(json) => {
                        if socket.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(err) => {
                        tracing::error!(error = %err, "failed to serialize realtime event");
                        break;
                    }
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        tracing::debug!(error = %err, "websocket receive failed");
                        break;
                    }
                }
            }
        }
    }

    state.hub.remove_connection(connection_id).await;
}

fn close_frame_for_notice(notice: &DisconnectNotice) -> (u16, String) {
    match notice.reason {
        DisconnectReason::LaggingConsumer => (
            1013,
            "lagging_consumer; reconnect with last_message_id cursor".to_owned(),
        ),
        DisconnectReason::ReplayFailed => (
            1011,
            "replay_failed; reconnect with last_message_id cursor".to_owned(),
        ),
        DisconnectReason::ServerShutdown => (1001, "server_shutdown".to_owned()),
    }
}

async fn principal_from_headers(
    state: &RealtimeRestState,
    headers: &HeaderMap,
) -> Result<RealtimePrincipal, RealtimeApiError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RealtimeApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "JWT verification is not configured for realtime",
        )
    })?;
    let token = bearer_token(headers)?;
    let pool = state.hub.pool.as_ref().ok_or_else(|| {
        RealtimeApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "realtime database is not configured",
        )
    })?;
    let principal =
        mnt_platform_request_context::resolve_principal_from_bearer_token(verifier, pool, token)
            .await
            .map_err(realtime_error_from_request_context)?;
    Ok(RealtimePrincipal {
        user_id: principal.user_id,
        branch_scope: principal.branch_scope,
        org_id: principal.org_id,
    })
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, RealtimeApiError> {
    if let Some(token) = authorization_bearer_token(headers)? {
        return Ok(token);
    }
    if let Some(token) = websocket_protocol_bearer_token(headers)? {
        return Ok(token);
    }
    Err(RealtimeApiError::unauthorized("missing bearer token"))
}

fn authorization_bearer_token(headers: &HeaderMap) -> Result<Option<&str>, RealtimeApiError> {
    let Some(header_value) = headers.get(header::AUTHORIZATION) else {
        return Ok(None);
    };
    let header_value = header_value
        .to_str()
        .map_err(|_| RealtimeApiError::unauthorized("invalid authorization header"))?;
    let token = header_value
        .strip_prefix("Bearer ")
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| {
            RealtimeApiError::unauthorized("authorization header must use Bearer scheme")
        })?;
    Ok(Some(token))
}

fn websocket_protocol_bearer_token(headers: &HeaderMap) -> Result<Option<&str>, RealtimeApiError> {
    let Some(header_value) = headers.get(header::SEC_WEBSOCKET_PROTOCOL) else {
        return Ok(None);
    };
    let header_value = header_value
        .to_str()
        .map_err(|_| RealtimeApiError::unauthorized("invalid websocket protocol header"))?;
    let protocols = header_value.split(',').map(str::trim).collect::<Vec<_>>();
    let token = protocols
        .windows(2)
        .find_map(|pair| (pair[0] == "bearer" && !pair[1].is_empty()).then_some(pair[1]));
    Ok(token)
}

fn realtime_error_from_request_context(err: RequestContextError) -> RealtimeApiError {
    match err {
        RequestContextError::VerifierUnavailable => RealtimeApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "JWT verification is not configured for realtime",
        ),
        RequestContextError::WrongTokenTier => RealtimeApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "token tier is not valid for this route",
        ),
        RequestContextError::AccessScope(error) if error.kind == ErrorKind::Forbidden => {
            RealtimeApiError::new(StatusCode::FORBIDDEN, "forbidden", error.message)
        }
        RequestContextError::AccessScope(error) => {
            RealtimeApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", error.message)
        }
        RequestContextError::BranchScope(message)
        | RequestContextError::EffectivePolicy(message) => {
            RealtimeApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
        }
        RequestContextError::MissingOrg => RealtimeApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "no tenant context is bound to the current request",
        ),
        RequestContextError::MissingBearer => {
            RealtimeApiError::unauthorized("missing or malformed bearer token")
        }
        RequestContextError::InvalidToken => RealtimeApiError::unauthorized("invalid bearer token"),
        RequestContextError::InvalidClaim(message) => {
            RealtimeApiError::unauthorized(format!("token claim is invalid: {message}"))
        }
    }
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}

#[derive(Debug)]
struct RealtimeApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl RealtimeApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }
}

impl IntoResponse for RealtimeApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

fn message_select_builder() -> QueryBuilder<Postgres> {
    QueryBuilder::<Postgres>::new(
        r#"
        SELECT m.id, m.thread_id, m.branch_id, m.sender_id, m.body,
               m.quoted_message_id,
               m.sent_at, m.created_at, sender.display_name AS sender_name,
               COALESCE(
                   array_agg(a.evidence_id ORDER BY a.sort_order)
                       FILTER (WHERE a.evidence_id IS NOT NULL),
                   ARRAY[]::uuid[]
               ) AS attachment_evidence_ids,
               COUNT(DISTINCT tm_read_target.user_id)::BIGINT AS read_target_count,
               COUNT(DISTINCT tm_read_target.user_id) FILTER (
                   WHERE read_receipt_message.id IS NOT NULL
                     AND (read_receipt_message.sent_at, read_receipt_message.id) >= (m.sent_at, m.id)
               )::BIGINT AS read_count,
               (
                   SELECT COUNT(*)::BIGINT
                   FROM messenger_message_acks ma
                   WHERE ma.message_id = m.id
               ) AS ack_count,
               (
                   SELECT qm.body
                   FROM messenger_messages qm
                   WHERE qm.id = m.quoted_message_id
               ) AS quoted_body,
               (
                   SELECT qs.display_name
                   FROM messenger_messages qm2
                   LEFT JOIN users qs ON qs.id = qm2.sender_id
                   WHERE qm2.id = m.quoted_message_id
               ) AS quoted_sender_name
        FROM messenger_messages m
        LEFT JOIN messenger_message_attachments a ON a.message_id = m.id
        LEFT JOIN messenger_thread_members tm_read_target
          ON tm_read_target.thread_id = m.thread_id
         AND tm_read_target.user_id <> m.sender_id
        LEFT JOIN messenger_read_receipts read_receipt
          ON read_receipt.thread_id = m.thread_id
         AND read_receipt.user_id = tm_read_target.user_id
        LEFT JOIN messenger_messages read_receipt_message
          ON read_receipt_message.id = read_receipt.last_read_message_id
        -- Same-org JOIN: `users` is RLS-scoped to app.current_org like the
        -- messages, so a sender only resolves within the caller's tenant.
        LEFT JOIN users sender ON sender.id = m.sender_id
        "#,
    )
}

fn message_summary_from_row(row: &sqlx::postgres::PgRow) -> Result<MessageSummary, sqlx::Error> {
    let attachment_ids: Vec<uuid::Uuid> = row.try_get("attachment_evidence_ids")?;
    Ok(MessageSummary {
        id: MessageId::from_uuid(row.try_get("id")?),
        thread_id: ThreadId::from_uuid(row.try_get("thread_id")?),
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        sender_id: UserId::from_uuid(row.try_get("sender_id")?),
        sender_name: row.try_get("sender_name")?,
        body: row.try_get("body")?,
        read_count: row.try_get("read_count")?,
        read_target_count: row.try_get("read_target_count")?,
        ack_count: row.try_get("ack_count")?,
        // ponytail: the realtime fan-out payload has no per-recipient actor
        // (it broadcasts one row to a channel), so per-user ack state is left
        // false and the receiving client derives it from its own ack store.
        acked_by_me: false,
        quoted_message_id: row
            .try_get::<Option<uuid::Uuid>, _>("quoted_message_id")?
            .map(MessageId::from_uuid),
        quoted_body: row.try_get("quoted_body")?,
        quoted_sender_name: row.try_get("quoted_sender_name")?,
        attachment_evidence_ids: attachment_ids
            .into_iter()
            .map(mnt_kernel_core::EvidenceId::from_uuid)
            .collect(),
        sent_at: row.try_get("sent_at")?,
        created_at: row.try_get("created_at")?,
    })
}

fn push_scope_filter(builder: &mut QueryBuilder<Postgres>, column: &str, scope: &BranchScope) {
    match scope {
        BranchScope::All => {}
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push(" AND false");
        }
        BranchScope::Branches(branches) => {
            let branch_ids: Vec<uuid::Uuid> =
                branches.iter().map(|branch| *branch.as_uuid()).collect();
            builder.push(" AND ");
            builder.push(column);
            builder.push(" = ANY(");
            builder.push_bind(branch_ids);
            builder.push(")");
        }
    }
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn bearer_token_accepts_authorization_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer native-token"),
        );

        assert_eq!(bearer_token(&headers).expect("token"), "native-token");
    }

    #[test]
    fn bearer_token_accepts_websocket_subprotocol_pair() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("bearer, browser-token"),
        );

        assert_eq!(bearer_token(&headers).expect("token"), "browser-token");
    }
}
