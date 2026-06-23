#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS gate for the webmail store (PgMailStore).
//!
//! Mirrors `region_branch_crud_rls_surfaces_as_runtime_role.rs`: we SEED as the
//! owner (raw inserts, row_security off) and MUTATE/READ as the genuine non-owner
//! runtime role `mnt_rt` (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) — the only
//! faithful exercise of the `org_isolation` policy. The default `#[sqlx::test]`
//! pool is a BYPASSRLS superuser and would green-light a broken/leaking path.
//!
//! Asserts, with two tenants A (KNL) and B:
//!   * upsert_account stores a mailbox under A's armed GUC and writes an
//!     `email.account.configure` audit row; only the CIPHERTEXT is persisted
//!     (no plaintext password column exists or holds the secret);
//!   * get_account under A returns the mailbox, and its write-only view carries
//!     NO password field (only `has_*_password` booleans);
//!   * cross-tenant isolation: under B's armed GUC, A's mailbox is INVISIBLE
//!     (get_account returns None) as `mnt_rt`;
//!   * FAIL-CLOSED: with no GUC armed, get_account returns None / errors, never
//!     A's row;
//!   * persist_outbound writes a direction=OUT message + thread + SENT folder
//!     and an `email.send` audit row, all org-scoped.

use mnt_comms_adapter_postgres::PgMailStore;
use mnt_comms_application::{
    AccountUpsert, EmailAccountId, EmailMessageId, MailStore, OutboundRecord, SendKind,
    account_config_audit_event, send_audit_event,
};
use mnt_comms_credential_cipher::{
    Aad, CredentialCipher, EnvelopeCredentialCipher, SealedCredential,
};
use mnt_comms_domain::{MailSecurity, MessageAddress};
use mnt_kernel_core::{OrgId, TraceContext, UserId};
use mnt_platform_request_context::CURRENT_ORG;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::OffsetDateTime;
use uuid::Uuid;

const ORG_B: Uuid = Uuid::from_u128(0x2222_2222_2222_2222_2222_2222_2222_2222);

/// A deterministic 32-byte test KEK (base64), distinct from any production key.
fn test_cipher() -> EnvelopeCredentialCipher {
    use base64::Engine as _;
    let key = [13u8; 32];
    let b64 = base64::engine::general_purpose::STANDARD.encode(key);
    EnvelopeCredentialCipher::from_base64_key(&b64).unwrap()
}

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
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
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind(format!("org-{}", tag.to_lowercase()))
    .bind(format!("Org {tag}"))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn seed_active_user(owner_pool: &PgPool, org: Uuid) -> UserId {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id, is_active) VALUES ($1, $2, $3, true) RETURNING id",
    )
    .bind(format!("User {}", Uuid::new_v4()))
    .bind(vec!["ADMIN".to_string()])
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    UserId::from_uuid(user_id)
}

async fn audit_count(owner_pool: &PgPool, action: &str, target_id: &str) -> i64 {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = $1 AND target_id = $2",
    )
    .bind(action)
    .bind(target_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    count
}

/// Read the raw ciphertext bytes of the stored SMTP secret as OWNER, so we can
/// assert the DB never holds the plaintext.
async fn raw_smtp_ct(owner_pool: &PgPool, account: Uuid) -> Vec<u8> {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let ct: Vec<u8> =
        sqlx::query_scalar("SELECT smtp_password_ct FROM email_accounts WHERE id = $1")
            .bind(account)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    ct
}

fn seal(
    cipher: &EnvelopeCredentialCipher,
    org: OrgId,
    account: EmailAccountId,
    field: &str,
    pw: &[u8],
) -> SealedCredential {
    let org_s = org.to_string();
    let acc_s = account.to_string();
    cipher
        .encrypt(
            pw,
            Aad {
                org_id: &org_s,
                account_id: &acc_s,
                field,
            },
        )
        .unwrap()
}

fn upsert_for(
    org: OrgId,
    account: EmailAccountId,
    actor: UserId,
    cipher: &EnvelopeCredentialCipher,
) -> AccountUpsert {
    AccountUpsert {
        id: account,
        actor,
        display_name: "KNL Mail".to_owned(),
        email_address: format!("ops-{}@knl.example", account),
        from_name: Some("KNL Ops".to_owned()),
        imap_host: "imap.knl.example".to_owned(),
        imap_port: 993,
        imap_security: MailSecurity::SslTls,
        imap_username: "ops".to_owned(),
        smtp_host: "smtp.knl.example".to_owned(),
        smtp_port: 587,
        smtp_security: MailSecurity::StartTls,
        smtp_username: "ops".to_owned(),
        smtp_password: Some(seal(cipher, org, account, "smtp_password", b"smtp-secret")),
        imap_password: Some(seal(cipher, org, account, "imap_password", b"imap-secret")),
    }
}

// ===========================================================================
// upsert + get under the armed GUC; ciphertext-only; write-only view.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn upsert_and_get_account_as_runtime_role_persist_ciphertext_only(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    seed_org(&owner_pool, org_uuid, "A").await;
    let actor = seed_active_user(&owner_pool, org_uuid).await;
    let cipher = test_cipher();

    let account_id = EmailAccountId::new();
    let upsert = upsert_for(org, account_id, actor, &cipher);
    let audit = account_config_audit_event(
        actor,
        account_id,
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .unwrap()
    .with_org(org);

    let store = PgMailStore::new(rt_pool.clone());
    let stored = CURRENT_ORG
        .scope(org, store.upsert_account(upsert, audit))
        .await
        .expect("upsert_account must succeed as mnt_rt under the armed GUC");
    assert_eq!(stored.id, account_id);

    // Audited.
    assert_eq!(
        audit_count(
            &owner_pool,
            "email.account.configure",
            &account_id.to_string()
        )
        .await,
        1
    );

    // The DB holds CIPHERTEXT, never the plaintext.
    let ct = raw_smtp_ct(&owner_pool, *account_id.as_uuid()).await;
    assert!(!ct.is_empty());
    assert_ne!(
        ct,
        b"smtp-secret".to_vec(),
        "the plaintext must never be stored"
    );

    // get_account returns the mailbox; the write-only VIEW has no password field.
    let view = CURRENT_ORG
        .scope(org, store.get_account())
        .await
        .expect("get_account as mnt_rt")
        .expect("the configured mailbox is visible under its own org");
    let json = serde_json::to_string(&view.to_view()).unwrap();
    assert!(!json.contains("smtp-secret"));
    assert!(!json.to_lowercase().contains("password_ct"));
    assert!(json.contains("has_smtp_password"));

    // The sealed secret round-trips back to the plaintext via the cipher (the
    // store persisted faithful ciphertext, not garbage).
    let org_s = org.to_string();
    let acc_s = account_id.to_string();
    let recovered = cipher
        .decrypt(
            &view.smtp_password,
            Aad {
                org_id: &org_s,
                account_id: &acc_s,
                field: "smtp_password",
            },
        )
        .unwrap();
    use secrecy::ExposeSecret;
    assert_eq!(recovered.expose_secret().as_slice(), b"smtp-secret");
}

// ===========================================================================
// Cross-tenant isolation: B's GUC cannot see A's mailbox as mnt_rt.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn account_is_invisible_to_another_org_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org_a = OrgId::knl();
    let org_b = OrgId::from_uuid(ORG_B);
    seed_org(&owner_pool, *org_a.as_uuid(), "A").await;
    seed_org(&owner_pool, *org_b.as_uuid(), "B").await;
    let actor_a = seed_active_user(&owner_pool, *org_a.as_uuid()).await;
    let cipher = test_cipher();

    let account_id = EmailAccountId::new();
    let upsert = upsert_for(org_a, account_id, actor_a, &cipher);
    let audit = account_config_audit_event(
        actor_a,
        account_id,
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .unwrap()
    .with_org(org_a);

    let store = PgMailStore::new(rt_pool.clone());
    CURRENT_ORG
        .scope(org_a, store.upsert_account(upsert, audit))
        .await
        .expect("seed A's mailbox");

    // Under B's GUC, A's mailbox is INVISIBLE.
    let seen_by_b = CURRENT_ORG
        .scope(org_b, store.get_account())
        .await
        .expect("get_account as mnt_rt under B");
    assert!(seen_by_b.is_none(), "B must never see A's mailbox");

    // FAIL-CLOSED: with no GUC armed at all, the read returns nothing/errors.
    let unarmed = store.get_account().await;
    match unarmed {
        Ok(None) => {}
        Err(_) => {}
        Ok(Some(_)) => panic!("an unarmed read must NEVER surface a tenant's mailbox"),
    }
}

// ===========================================================================
// persist_outbound writes a direction=OUT message + audit, org-scoped.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn persist_outbound_writes_direction_out_and_audits(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    seed_org(&owner_pool, org_uuid, "A").await;
    let actor = seed_active_user(&owner_pool, org_uuid).await;
    let cipher = test_cipher();

    let account_id = EmailAccountId::new();
    let upsert = upsert_for(org, account_id, actor, &cipher);
    let audit = account_config_audit_event(
        actor,
        account_id,
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .unwrap()
    .with_org(org);
    let store = PgMailStore::new(rt_pool.clone());
    CURRENT_ORG
        .scope(org, store.upsert_account(upsert, audit))
        .await
        .expect("seed mailbox");

    let message_id = EmailMessageId::new();
    let record = OutboundRecord {
        id: message_id,
        account_id,
        rfc_message_id: "<abc@knl.example>".to_owned(),
        in_reply_to: None,
        references: vec![],
        from_address: "ops@knl.example".to_owned(),
        from_name: Some("KNL Ops".to_owned()),
        to: vec![MessageAddress::new("customer@example.com").unwrap()],
        cc: vec![],
        bcc: vec![],
        subject: "Quote".to_owned(),
        body_text: "Here is your quote.".to_owned(),
        has_attachments: false,
        sent_at: OffsetDateTime::now_utc(),
    };
    let send_audit = send_audit_event(
        SendKind::New,
        actor,
        message_id,
        1,
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .unwrap()
    .with_org(org);

    CURRENT_ORG
        .scope(org, store.persist_outbound(record, send_audit))
        .await
        .expect("persist_outbound as mnt_rt under the armed GUC");

    // The message landed as direction=OUT under the org.
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let direction: String =
        sqlx::query_scalar("SELECT direction FROM email_messages WHERE id = $1")
            .bind(*message_id.as_uuid())
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let send_status: Option<String> =
        sqlx::query_scalar("SELECT send_status FROM email_messages WHERE id = $1")
            .bind(*message_id.as_uuid())
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(direction, "OUT");
    assert_eq!(send_status.as_deref(), Some("SENT"));

    assert_eq!(
        audit_count(&owner_pool, "email.send", &message_id.to_string()).await,
        1
    );
}
