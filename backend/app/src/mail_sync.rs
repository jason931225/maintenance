//! Inbound webmail sync worker wiring (B-mail-3).
//!
//! A single background task (mirroring how `start_postgres_listener` is spawned)
//! ticks on a fixed cadence. Each tick:
//!   1. ENUMERATES the accounts due for a sync pass across ALL tenants via the
//!      `comms_due_email_accounts` SECURITY DEFINER function (id-only, no
//!      secrets) — the one read that legitimately spans tenants;
//!   2. for each `(org, account)`, ARMS `app.current_org` to that tenant (every
//!      store call runs through `with_org_conn`/`with_audit` armed to the org, so
//!      a pass for org A can never read or write org B), re-reads the FULL sealed
//!      account under RLS, decrypts the IMAP password in-memory, and runs ONE
//!      incremental sync pass (`SyncService::sync_account`).
//!
//! A bounded [`Semaphore`] caps concurrent passes so a burst of due accounts
//! cannot exhaust connections/CPU. The whole worker is GRACEFUL: it only starts
//! when the master KEK is present, storage is configured, and `MNT_MAIL_ENABLED`
//! is truthy — otherwise it is a no-op (the app boots normally, mail endpoints
//! still mount and return 503/empty as appropriate).
//!
//! No secret, recipient, body, or host is logged here — only non-secret counts +
//! the org/account ids + a fixed transport code on failure.

use std::sync::Arc;
use std::time::Duration;

use mnt_comms_adapter_imap::AsyncImapClient;
use mnt_comms_adapter_postgres::PgMailStore;
use mnt_comms_application::{
    MailAttachmentStore, MailFuture, MailReadStore, MailServiceError, MailStore, SyncService,
};
use mnt_comms_credential_cipher::EnvelopeCredentialCipher;
use mnt_kernel_core::Timestamp;
use mnt_platform_request_context::scope_org;
use mnt_platform_storage::{PresignGetRequest, S3ObjectStore, SeaweedS3Storage};
use tokio::sync::{Semaphore, watch};

/// Default seconds between scheduler ticks. Each tick dispatches the due batch;
/// per-account cadence is enforced by the `comms_due_email_accounts` function
/// (an account is "due" only when `last_sync_at` is older than its own
/// `sync_cadence_secs`, default 120). 120s here keeps the tick aligned.
const DEFAULT_TICK_SECS: u64 = 120;

/// Max concurrent account sync passes per tick (bounds connections/CPU).
const MAX_CONCURRENT_SYNCS: usize = 4;

/// Presigned-GET lifetime for inbound attachments served to the UI.
const ATTACHMENT_GET_TTL: Duration = Duration::from_secs(300);

/// A handle that stops the sync worker on drop / explicit shutdown.
#[derive(Debug)]
pub struct MailSyncHandle {
    shutdown_tx: watch::Sender<bool>,
}

impl MailSyncHandle {
    /// Signal the worker loop to stop.
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

/// The object-storage adapter bridging `mnt-platform-storage`'s `S3ObjectStore`
/// to the application's [`MailAttachmentStore`] port. Uploads inbound attachment
/// bytes under org-prefixed keys and issues short-lived presigned GETs.
#[derive(Clone)]
pub struct S3MailAttachmentStore {
    store: SeaweedS3Storage,
    bucket: String,
}

impl S3MailAttachmentStore {
    #[must_use]
    pub fn new(store: SeaweedS3Storage, bucket: String) -> Self {
        Self { store, bucket }
    }
}

impl MailAttachmentStore for S3MailAttachmentStore {
    fn put<'a>(
        &'a self,
        key: String,
        content_type: String,
        bytes: Vec<u8>,
    ) -> MailFuture<'a, Result<(), MailServiceError>> {
        Box::pin(async move {
            self.store
                .put_object(self.bucket.clone(), key, content_type, bytes)
                .await
                .map_err(|_| MailServiceError::Transport {
                    code: "attachment_upload_failed",
                })
        })
    }

    fn presign_get<'a>(&'a self, key: &'a str) -> MailFuture<'a, Result<String, MailServiceError>> {
        Box::pin(async move {
            self.store
                .presign_get(PresignGetRequest {
                    bucket: self.bucket.clone(),
                    key: key.to_owned(),
                    expires_in: ATTACHMENT_GET_TTL,
                })
                .await
                .map_err(|_| MailServiceError::Transport {
                    code: "attachment_presign_failed",
                })
        })
    }
}

/// Spawn the inbound sync worker. Returns `None` (a no-op, app boots normally)
/// when the feature is not fully configured. The worker is GRACEFUL: missing KEK
/// / storage / disabled flag → not spawned; a failing pass logs a non-secret code
/// and the loop continues.
#[must_use]
pub fn spawn(
    pool: sqlx::PgPool,
    cipher: Option<Arc<EnvelopeCredentialCipher>>,
    storage: Option<(SeaweedS3Storage, String)>,
    enabled: bool,
) -> Option<MailSyncHandle> {
    if !enabled {
        tracing::info!("MNT_MAIL_ENABLED is not set; the inbound webmail sync worker is OFF");
        return None;
    }
    let Some(cipher) = cipher else {
        tracing::info!(
            "MNT_MAIL_MASTER_KEY absent; the inbound webmail sync worker is OFF (no credential cipher)"
        );
        return None;
    };
    let Some((object_store, bucket)) = storage else {
        tracing::info!("object storage is not configured; the inbound webmail sync worker is OFF");
        return None;
    };

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let attachments = S3MailAttachmentStore::new(object_store, bucket);
    let store = PgMailStore::new(pool);

    tokio::spawn(async move {
        let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_SYNCS));
        let mut ticker = tokio::time::interval(Duration::from_secs(DEFAULT_TICK_SECS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        tracing::info!(
            tick_secs = DEFAULT_TICK_SECS,
            "inbound webmail sync worker started"
        );

        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        tracing::info!("inbound webmail sync worker stopping");
                        break;
                    }
                }
                _ = ticker.tick() => {
                    run_tick(&store, &attachments, &cipher, &semaphore).await;
                }
            }
        }
    });

    Some(MailSyncHandle { shutdown_tx })
}

/// One scheduler tick: enumerate the due accounts (cross-tenant, id-only), then
/// dispatch a bounded set of per-(org, account) sync passes.
async fn run_tick(
    store: &PgMailStore,
    attachments: &S3MailAttachmentStore,
    cipher: &Arc<EnvelopeCredentialCipher>,
    semaphore: &Arc<Semaphore>,
) {
    let now = Timestamp::now_utc();
    let due = match store.list_due_accounts(now).await {
        Ok(due) => due,
        Err(err) => {
            tracing::warn!(
                code = err.transport_code(),
                "mail sync: enumerate due accounts failed"
            );
            return;
        }
    };
    if due.is_empty() {
        return;
    }
    tracing::debug!(due = due.len(), "mail sync tick: dispatching due accounts");

    let mut handles = Vec::new();
    for account in due {
        let Ok(permit) = Arc::clone(semaphore).acquire_owned().await else {
            break;
        };
        let store = store.clone();
        let attachments = attachments.clone();
        let cipher = Arc::clone(cipher);
        handles.push(tokio::spawn(async move {
            // Hold the permit for the whole pass; dropped on completion.
            let _permit = permit;
            sync_one_account(store, attachments, cipher, account).await;
        }));
    }
    for handle in handles {
        let _ = handle.await;
    }
}

/// Run ONE account's sync pass under its tenant's armed org. This is the critical
/// RLS-in-a-background-loop step: `scope_org` enters the tenant scope so the
/// account re-read + every sync write is RLS-armed to exactly this org; a pass
/// for org A can therefore never touch org B's rows. The IMAP password is
/// decrypted only inside `SyncService` and dropped when the pass ends.
async fn sync_one_account(
    store: PgMailStore,
    attachments: S3MailAttachmentStore,
    cipher: Arc<EnvelopeCredentialCipher>,
    account: mnt_comms_application::DueAccount,
) {
    let org = account.org_id;
    let result = scope_org(org, async move {
        // Re-read the full sealed account under the armed org (the enumeration
        // gave us only ids). If it vanished/paused since enumeration, skip.
        let Some(stored) = store.get_account().await? else {
            return Ok::<_, MailServiceError>(None);
        };
        if stored.id != account.account_id {
            // The tenant's single mailbox changed identity since enumeration;
            // skip this stale dispatch rather than syncing the wrong account.
            return Ok(None);
        }
        // Owned values satisfy the SyncService bounds directly; the cipher is
        // shared via the Arc blanket `CredentialCipher` impl.
        let service = SyncService::new(store, AsyncImapClient::new(), attachments, cipher);
        let outcome = service.sync_account(&stored).await?;
        Ok(Some(outcome))
    })
    .await;

    match result {
        Ok(Some(outcome)) => {
            tracing::info!(
                org = %org,
                account = %account.account_id,
                folders = outcome.folders_synced,
                upserted = outcome.messages_upserted,
                duplicates = outcome.messages_skipped_duplicate,
                "mail sync pass complete"
            );
        }
        Ok(None) => {}
        Err(err) => {
            // The lifecycle status was already stamped inside sync_account; here we
            // log only the non-secret code + ids.
            tracing::warn!(
                org = %org,
                account = %account.account_id,
                code = err.transport_code(),
                "mail sync pass failed"
            );
        }
    }
}
