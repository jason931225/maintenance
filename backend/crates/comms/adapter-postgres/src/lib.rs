//! Postgres adapter for the webmail store.
//!
//! Every method is org-scoped: reads go through `with_org_conn(current_org()?)`
//! and writes through `with_audit` (which arms `app.current_org` for the audited
//! transaction). A missing request-context org fails closed. The adapter never
//! touches an `email_*` table on the raw pool.
//!
//! # Write-only credentials
//!
//! `upsert_account` persists ONLY the ciphertext the cipher produced
//! (`smtp_password_ct/nonce` + `dek_wrapped/dek_nonce` for the SMTP secret;
//! `imap_password_ct/nonce` + `imap_dek_wrapped/imap_dek_nonce` for the IMAP
//! secret — each secret keeps its own wrapped per-row DEK). `get_account` reads
//! those sealed columns back (the service needs them to decrypt for a send) but
//! the REST layer projects them to a DTO that omits every secret, so the
//! password is never returned to a client.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_comms_application::{
    AccountUpsert, EmailAccountId, MailServiceError, MailStore, OutboundRecord, StoredAccount,
};
use mnt_comms_credential_cipher::SealedCredential;
use mnt_comms_domain::{MailSecurity, normalize_subject};
use mnt_kernel_core::{AuditEvent, ErrorKind, KernelError, OrgId};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use mnt_platform_request_context::current_org;
use sqlx::{PgPool, Postgres, Row, Transaction};

/// Adapter error. Mirrors `PgOrgError`: domain failures carry safe messages;
/// sqlx errors are mapped to a coarse [`ErrorKind`] for the REST surface and
/// never leaked verbatim.
#[derive(Debug, thiserror::Error)]
pub enum PgMailError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl PgMailError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(error) => error.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(DbError::Sqlx(sqlx::Error::Database(error)))
                if error.code().is_some_and(|code| code == "23505") =>
            {
                ErrorKind::Conflict
            }
            Self::Db(DbError::Sqlx(sqlx::Error::Database(error)))
                if error.code().is_some_and(|code| code == "23503") =>
            {
                ErrorKind::Validation
            }
            Self::Db(_) => ErrorKind::Internal,
        }
    }
}

impl From<sqlx::Error> for PgMailError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

impl From<PgMailError> for MailServiceError {
    fn from(value: PgMailError) -> Self {
        match value {
            PgMailError::Domain(err) => MailServiceError::Domain(err),
            // Db errors are server-internal; the application surface collapses
            // them into a coarse, caller-safe variant.
            PgMailError::Db(_) => MailServiceError::Store,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PgMailStore {
    pool: PgPool,
}

impl PgMailStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    async fn get_account_inner(&self) -> Result<Option<StoredAccount>, PgMailError> {
        let org = current_org().map_err(KernelError::from)?;
        let row = with_org_conn::<_, _, PgMailError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(ACCOUNT_SELECT_LATEST)
                    .fetch_optional(tx.as_mut())
                    .await?;
                Ok(row)
            })
        })
        .await?;
        row.map(account_from_row).transpose()
    }

    async fn upsert_account_inner(
        &self,
        upsert: AccountUpsert,
        audit: AuditEvent,
    ) -> Result<StoredAccount, PgMailError> {
        let org = audit
            .org_id
            .ok_or_else(|| KernelError::internal("account upsert audit is missing the org id"))?;
        let org_uuid = *org.as_uuid();
        let account_uuid = *upsert.id.as_uuid();

        with_audit::<_, StoredAccount, PgMailError>(&self.pool, audit, move |tx| {
            Box::pin(async move {
                let exists = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM email_accounts WHERE id = $1",
                )
                .bind(account_uuid)
                .fetch_one(tx.as_mut())
                .await?
                    > 0;

                if exists {
                    update_account_tx(tx, &upsert).await?;
                } else {
                    // A brand-new account requires both sealed secrets (the DB
                    // columns are NOT NULL); the service already enforced this.
                    let smtp = upsert.smtp_password.as_ref().ok_or_else(|| {
                        KernelError::validation("new mailbox requires an SMTP password")
                    })?;
                    let imap = upsert.imap_password.as_ref().ok_or_else(|| {
                        KernelError::validation("new mailbox requires an IMAP password")
                    })?;
                    insert_account_tx(tx, org_uuid, &upsert, smtp, imap).await?;
                }
                fetch_account_tx(tx, account_uuid).await
            })
        })
        .await
    }

    async fn persist_outbound_inner(
        &self,
        record: OutboundRecord,
        audit: AuditEvent,
    ) -> Result<(), PgMailError> {
        let org = audit
            .org_id
            .ok_or_else(|| KernelError::internal("outbound audit is missing the org id"))?;
        let org_uuid = *org.as_uuid();

        with_audit::<_, (), PgMailError>(&self.pool, audit, move |tx| {
            Box::pin(async move {
                let account_uuid = *record.account_id.as_uuid();

                // Resolve (or create) the SENT folder so the OUT message has a
                // folder home even before IMAP sync (B-mail-3) runs.
                let folder_id = ensure_sent_folder_tx(tx, org_uuid, account_uuid).await?;

                let normalized = normalize_subject(&record.subject);
                let thread_id = ensure_thread_tx(
                    tx,
                    org_uuid,
                    account_uuid,
                    &normalized,
                    &record.subject,
                    record.sent_at,
                )
                .await?;

                insert_outbound_message_tx(
                    tx,
                    org_uuid,
                    account_uuid,
                    folder_id,
                    thread_id,
                    &record,
                )
                .await?;
                Ok(())
            })
        })
        .await
    }
}

impl MailStore for PgMailStore {
    fn get_account(
        &self,
    ) -> mnt_comms_application::MailFuture<'_, Result<Option<StoredAccount>, MailServiceError>>
    {
        Box::pin(async move { self.get_account_inner().await.map_err(Into::into) })
    }

    fn upsert_account(
        &self,
        upsert: AccountUpsert,
        audit: AuditEvent,
    ) -> mnt_comms_application::MailFuture<'_, Result<StoredAccount, MailServiceError>> {
        Box::pin(async move {
            self.upsert_account_inner(upsert, audit)
                .await
                .map_err(Into::into)
        })
    }

    fn persist_outbound(
        &self,
        record: OutboundRecord,
        audit: AuditEvent,
    ) -> mnt_comms_application::MailFuture<'_, Result<(), MailServiceError>> {
        Box::pin(async move {
            self.persist_outbound_inner(record, audit)
                .await
                .map_err(Into::into)
        })
    }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/// The full sealed-account column list. Both selects below are spelled out as
/// `&'static str` (sqlx 0.9 requires a statically-known SQL string).
const ACCOUNT_SELECT_LATEST: &str = r#"
    SELECT id, org_id, display_name, email_address, from_name,
           imap_host, imap_port, imap_security, imap_username,
           smtp_host, smtp_port, smtp_security, smtp_username,
           smtp_password_ct, smtp_password_nonce, dek_wrapped, dek_nonce,
           imap_password_ct, imap_password_nonce, imap_dek_wrapped, imap_dek_nonce,
           key_version, status
    FROM email_accounts
    ORDER BY created_at ASC
    LIMIT 1
"#;

const ACCOUNT_SELECT_BY_ID: &str = r#"
    SELECT id, org_id, display_name, email_address, from_name,
           imap_host, imap_port, imap_security, imap_username,
           smtp_host, smtp_port, smtp_security, smtp_username,
           smtp_password_ct, smtp_password_nonce, dek_wrapped, dek_nonce,
           imap_password_ct, imap_password_nonce, imap_dek_wrapped, imap_dek_nonce,
           key_version, status
    FROM email_accounts
    WHERE id = $1
"#;

async fn insert_account_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    upsert: &AccountUpsert,
    smtp: &SealedCredential,
    imap: &SealedCredential,
) -> Result<(), PgMailError> {
    // Both secrets share one `key_version` (the cipher stamps the same current
    // version on every fresh seal in a single configure call).
    sqlx::query(
        r#"
        INSERT INTO email_accounts (
            id, org_id, display_name, email_address, from_name,
            imap_host, imap_port, imap_security, imap_username,
            smtp_host, smtp_port, smtp_security, smtp_username,
            smtp_password_ct, smtp_password_nonce, dek_wrapped, dek_nonce,
            imap_password_ct, imap_password_nonce, imap_dek_wrapped, imap_dek_nonce,
            key_version, created_by
        ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15, $16, $17,
            $18, $19, $20, $21,
            $22, $23
        )
        "#,
    )
    .bind(*upsert.id.as_uuid())
    .bind(org_uuid)
    .bind(&upsert.display_name)
    .bind(&upsert.email_address)
    .bind(upsert.from_name.as_deref())
    .bind(&upsert.imap_host)
    .bind(i32::from(upsert.imap_port))
    .bind(upsert.imap_security.as_db_str())
    .bind(&upsert.imap_username)
    .bind(&upsert.smtp_host)
    .bind(i32::from(upsert.smtp_port))
    .bind(upsert.smtp_security.as_db_str())
    .bind(&upsert.smtp_username)
    .bind(&smtp.ciphertext)
    .bind(&smtp.nonce)
    .bind(&smtp.dek_wrapped)
    .bind(&smtp.dek_nonce)
    .bind(&imap.ciphertext)
    .bind(&imap.nonce)
    .bind(&imap.dek_wrapped)
    .bind(&imap.dek_nonce)
    .bind(smtp.key_version)
    .bind(*upsert.actor.as_uuid())
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

async fn update_account_tx(
    tx: &mut Transaction<'_, Postgres>,
    upsert: &AccountUpsert,
) -> Result<(), PgMailError> {
    sqlx::query(
        r#"
        UPDATE email_accounts
        SET display_name = $2, email_address = $3, from_name = $4,
            imap_host = $5, imap_port = $6, imap_security = $7, imap_username = $8,
            smtp_host = $9, smtp_port = $10, smtp_security = $11, smtp_username = $12,
            updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(*upsert.id.as_uuid())
    .bind(&upsert.display_name)
    .bind(&upsert.email_address)
    .bind(upsert.from_name.as_deref())
    .bind(&upsert.imap_host)
    .bind(i32::from(upsert.imap_port))
    .bind(upsert.imap_security.as_db_str())
    .bind(&upsert.imap_username)
    .bind(&upsert.smtp_host)
    .bind(i32::from(upsert.smtp_port))
    .bind(upsert.smtp_security.as_db_str())
    .bind(&upsert.smtp_username)
    .execute(tx.as_mut())
    .await?;

    // Secrets update ONLY when a fresh sealed credential was supplied; a `None`
    // leaves the stored ciphertext untouched (write-only contract).
    if let Some(smtp) = &upsert.smtp_password {
        sqlx::query(
            r#"
            UPDATE email_accounts
            SET smtp_password_ct = $2, smtp_password_nonce = $3,
                dek_wrapped = $4, dek_nonce = $5, key_version = $6, updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(*upsert.id.as_uuid())
        .bind(&smtp.ciphertext)
        .bind(&smtp.nonce)
        .bind(&smtp.dek_wrapped)
        .bind(&smtp.dek_nonce)
        .bind(smtp.key_version)
        .execute(tx.as_mut())
        .await?;
    }
    if let Some(imap) = &upsert.imap_password {
        sqlx::query(
            r#"
            UPDATE email_accounts
            SET imap_password_ct = $2, imap_password_nonce = $3,
                imap_dek_wrapped = $4, imap_dek_nonce = $5, updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(*upsert.id.as_uuid())
        .bind(&imap.ciphertext)
        .bind(&imap.nonce)
        .bind(&imap.dek_wrapped)
        .bind(&imap.dek_nonce)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

async fn fetch_account_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_uuid: uuid::Uuid,
) -> Result<StoredAccount, PgMailError> {
    let row = sqlx::query(ACCOUNT_SELECT_BY_ID)
        .bind(account_uuid)
        .fetch_one(tx.as_mut())
        .await?;
    account_from_row(row)
}

async fn ensure_sent_folder_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    account_uuid: uuid::Uuid,
) -> Result<uuid::Uuid, PgMailError> {
    if let Some(id) = sqlx::query_scalar::<_, uuid::Uuid>(
        "SELECT id FROM email_folders WHERE account_id = $1 AND role = 'SENT' LIMIT 1",
    )
    .bind(account_uuid)
    .fetch_optional(tx.as_mut())
    .await?
    {
        return Ok(id);
    }
    let id = sqlx::query_scalar::<_, uuid::Uuid>(
        r#"
        INSERT INTO email_folders (org_id, account_id, imap_path, role, name)
        VALUES ($1, $2, 'Sent', 'SENT', 'Sent')
        RETURNING id
        "#,
    )
    .bind(org_uuid)
    .bind(account_uuid)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(id)
}

async fn ensure_thread_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    account_uuid: uuid::Uuid,
    normalized: &str,
    subject: &str,
    sent_at: time::OffsetDateTime,
) -> Result<uuid::Uuid, PgMailError> {
    if let Some(id) = sqlx::query_scalar::<_, uuid::Uuid>(
        r#"
        SELECT id FROM email_threads
        WHERE account_id = $1 AND normalized_subject = $2
        ORDER BY last_message_at DESC
        LIMIT 1
        "#,
    )
    .bind(account_uuid)
    .bind(normalized)
    .fetch_optional(tx.as_mut())
    .await?
    {
        sqlx::query(
            r#"
            UPDATE email_threads
            SET last_message_at = GREATEST(last_message_at, $2),
                message_count = message_count + 1, updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(id)
        .bind(sent_at)
        .execute(tx.as_mut())
        .await?;
        return Ok(id);
    }
    let id = sqlx::query_scalar::<_, uuid::Uuid>(
        r#"
        INSERT INTO email_threads (
            org_id, account_id, normalized_subject, subject,
            last_message_at, message_count
        ) VALUES ($1, $2, $3, $4, $5, 1)
        RETURNING id
        "#,
    )
    .bind(org_uuid)
    .bind(account_uuid)
    .bind(normalized)
    .bind(subject)
    .bind(sent_at)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(id)
}

async fn insert_outbound_message_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    account_uuid: uuid::Uuid,
    folder_id: uuid::Uuid,
    thread_id: uuid::Uuid,
    record: &OutboundRecord,
) -> Result<(), PgMailError> {
    let snippet: String = record.body_text.chars().take(200).collect();
    let to_json = serde_json::to_value(&record.to)
        .map_err(|_| PgMailError::Domain(KernelError::internal("could not encode recipients")))?;
    let cc_json = serde_json::to_value(&record.cc)
        .map_err(|_| PgMailError::Domain(KernelError::internal("could not encode cc")))?;
    let bcc_json = serde_json::to_value(&record.bcc)
        .map_err(|_| PgMailError::Domain(KernelError::internal("could not encode bcc")))?;

    sqlx::query(
        r#"
        INSERT INTO email_messages (
            id, org_id, account_id, folder_id, thread_id,
            message_id, in_reply_to, references_ids, direction,
            from_address, from_name, to_addresses, cc_addresses, bcc_addresses,
            subject, snippet, body_text, seen, answered,
            has_attachments, send_status, received_at, sent_at
        ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, 'OUT',
            $9, $10, $11, $12, $13,
            $14, $15, $16, TRUE, FALSE,
            $17, 'SENT', $18, $18
        )
        "#,
    )
    .bind(*record.id.as_uuid())
    .bind(org_uuid)
    .bind(account_uuid)
    .bind(folder_id)
    .bind(thread_id)
    .bind(nullable(&record.rfc_message_id))
    .bind(record.in_reply_to.as_deref())
    .bind(&record.references)
    .bind(&record.from_address)
    .bind(record.from_name.as_deref())
    .bind(&to_json)
    .bind(&cc_json)
    .bind(&bcc_json)
    .bind(&record.subject)
    .bind(&snippet)
    .bind(&record.body_text)
    .bind(record.has_attachments)
    .bind(record.sent_at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

fn nullable(value: &str) -> Option<&str> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn account_from_row(row: sqlx::postgres::PgRow) -> Result<StoredAccount, PgMailError> {
    let imap_security = MailSecurity::parse(row.try_get::<String, _>("imap_security")?.as_str())?;
    let smtp_security = MailSecurity::parse(row.try_get::<String, _>("smtp_security")?.as_str())?;
    let key_version: i16 = row.try_get("key_version")?;

    let smtp_password = SealedCredential {
        ciphertext: row.try_get("smtp_password_ct")?,
        nonce: row.try_get("smtp_password_nonce")?,
        dek_wrapped: row.try_get("dek_wrapped")?,
        dek_nonce: row.try_get("dek_nonce")?,
        key_version,
    };
    let imap_password = SealedCredential {
        ciphertext: row.try_get("imap_password_ct")?,
        nonce: row.try_get("imap_password_nonce")?,
        // The IMAP secret keeps its OWN wrapped DEK (0054); both columns are
        // NOT NULL and always written by `insert_account_tx`/`update_account_tx`.
        dek_wrapped: row.try_get("imap_dek_wrapped")?,
        dek_nonce: row.try_get("imap_dek_nonce")?,
        key_version,
    };

    Ok(StoredAccount {
        id: EmailAccountId::from_uuid(row.try_get("id")?),
        org_id: OrgId::from_uuid(row.try_get("org_id")?),
        display_name: row.try_get("display_name")?,
        email_address: row.try_get("email_address")?,
        from_name: row.try_get("from_name")?,
        imap_host: row.try_get("imap_host")?,
        imap_port: u16::try_from(row.try_get::<i32, _>("imap_port")?).unwrap_or(993),
        imap_security,
        imap_username: row.try_get("imap_username")?,
        smtp_host: row.try_get("smtp_host")?,
        smtp_port: u16::try_from(row.try_get::<i32, _>("smtp_port")?).unwrap_or(587),
        smtp_security,
        smtp_username: row.try_get("smtp_username")?,
        smtp_password,
        imap_password,
        status: row.try_get("status")?,
    })
}
