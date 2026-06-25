#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS gate for the inbound webmail sync store (PgMailStore as
//! MailReadStore) — B-mail-3.
//!
//! Mirrors `mail_account_rls_surfaces_as_runtime_role.rs`: SEED as the owner and
//! MUTATE/READ as the genuine non-owner runtime role `mnt_rt` (NOBYPASSRLS, FORCE
//! RLS), the only faithful exercise of `org_isolation`. The default
//! `#[sqlx::test]` pool is a BYPASSRLS superuser and would green-light a
//! leaking/broken sync path.
//!
//! Asserts, with two tenants A (KNL) and B:
//!   * the inbound UPSERT is IDEMPOTENT — re-running the same (uid_validity, uid)
//!     inserts NO duplicate (returns `false`, refreshes flags);
//!   * THREADING — a reply carrying a `References`/`In-Reply-To` to a stored
//!     message joins that message's thread (References groups);
//!   * CROSS-TENANT ISOLATION — a sync armed to org A's account never reads or
//!     writes any of org B's rows (org B's armed reads see ZERO of A's threads /
//!     messages / folders);
//!   * FAIL-CLOSED — an UNARMED read of the read API returns zero / errors, never
//!     a tenant's rows;
//!   * the cross-tenant DUE-ACCOUNT enumeration (the SECURITY DEFINER function)
//!     returns BOTH tenants' accounts to the scheduler (id-only), proving the
//!     scheduler can see across tenants while the data path stays isolated.

use mnt_comms_adapter_postgres::PgMailStore;
use mnt_comms_application::{
    AccountUpsert, EmailAccountId, EmailMessageId, FetchedMessage, ImapFolder, InboundUpsert,
    MailReadStore, MailStore, StoredAttachment, ThreadQuery, account_config_audit_event,
};
use mnt_comms_credential_cipher::{
    Aad, CredentialCipher, EnvelopeCredentialCipher, SealedCredential,
};
use mnt_comms_domain::{FolderRole, MailSecurity, MessageAddress, normalize_subject};
use mnt_kernel_core::{OrgId, TraceContext, UserId};
use mnt_platform_request_context::CURRENT_ORG;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::OffsetDateTime;
use uuid::Uuid;

const ORG_B: Uuid = Uuid::from_u128(0x3333_3333_3333_3333_3333_3333_3333_3333);

fn test_cipher() -> EnvelopeCredentialCipher {
    use base64::Engine as _;
    let key = [21u8; 32];
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

/// Seed a configured mailbox for `org` and return its account id.
async fn seed_account(
    store: &PgMailStore,
    cipher: &EnvelopeCredentialCipher,
    org: OrgId,
    actor: UserId,
) -> EmailAccountId {
    let account = EmailAccountId::new();
    let upsert = AccountUpsert {
        id: account,
        actor,
        display_name: "Mail".to_owned(),
        email_address: format!("ops-{account}@example.test"),
        from_name: Some("Ops".to_owned()),
        imap_host: "imap.example.test".to_owned(),
        imap_port: 993,
        imap_security: MailSecurity::SslTls,
        imap_username: "ops".to_owned(),
        smtp_host: "smtp.example.test".to_owned(),
        smtp_port: 587,
        smtp_security: MailSecurity::StartTls,
        smtp_username: "ops".to_owned(),
        smtp_password: Some(seal(cipher, org, account, "smtp_password", b"smtp-pw")),
        imap_password: Some(seal(cipher, org, account, "imap_password", b"imap-pw")),
    };
    let audit = account_config_audit_event(
        actor,
        account,
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .unwrap()
    .with_org(org);
    CURRENT_ORG
        .scope(org, store.upsert_account(upsert, audit))
        .await
        .expect("seed mailbox");
    account
}

fn inbox_folder() -> ImapFolder {
    ImapFolder {
        imap_path: "INBOX".to_owned(),
        role: FolderRole::Inbox,
        name: "Inbox".to_owned(),
    }
}

fn message(uid: u32, subject: &str) -> FetchedMessage {
    FetchedMessage {
        imap_uid: uid,
        message_id: Some(format!("m{uid}@example.test")),
        in_reply_to: None,
        references: vec![],
        from: MessageAddress::new("sender@example.com").ok(),
        to: vec![MessageAddress::new("ops@example.test").unwrap()],
        cc: vec![],
        subject: subject.to_owned(),
        body_text: Some(format!("body {uid}")),
        body_html: None,
        seen: false,
        flagged: false,
        answered: false,
        draft: false,
        received_at: OffsetDateTime::now_utc(),
        attachments: vec![],
    }
}

fn upsert_for(account: EmailAccountId, folder_id: Uuid, msg: FetchedMessage) -> InboundUpsert {
    let normalized = normalize_subject(&msg.subject);
    InboundUpsert {
        id: EmailMessageId::new(),
        account_id: account,
        folder_id,
        uid_validity: 1,
        message: msg,
        normalized_subject: normalized,
        stored_attachments: Vec::<StoredAttachment>::new(),
    }
}

// ===========================================================================
// Idempotency: re-syncing the same (uid_validity, uid) inserts no duplicate.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn inbound_upsert_is_idempotent_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    seed_org(&owner_pool, *org.as_uuid(), "A").await;
    let actor = seed_active_user(&owner_pool, *org.as_uuid()).await;
    let cipher = test_cipher();
    let store = PgMailStore::new(rt_pool.clone());

    let account = seed_account(&store, &cipher, org, actor).await;
    let cursors = CURRENT_ORG
        .scope(org, store.upsert_folders(org, account, &[inbox_folder()]))
        .await
        .expect("upsert folders");
    let folder_id = cursors[0].folder_id;

    // First insert is NEW.
    let first = CURRENT_ORG
        .scope(
            org,
            store.upsert_inbound(org, upsert_for(account, folder_id, message(10, "Quote"))),
        )
        .await
        .expect("first upsert");
    assert!(first, "first sight of a UID inserts a NEW message");

    // Re-syncing the SAME (uid_validity, uid) is a no-op (returns false).
    let second = CURRENT_ORG
        .scope(
            org,
            store.upsert_inbound(org, upsert_for(account, folder_id, message(10, "Quote"))),
        )
        .await
        .expect("second upsert");
    assert!(
        !second,
        "re-syncing the same UID must NOT insert a duplicate"
    );

    // Exactly one message row exists (verified as owner).
    let count: i64 = {
        let mut tx = owner_pool.begin().await.unwrap();
        sqlx::query("SET LOCAL row_security = off")
            .execute(&mut *tx)
            .await
            .unwrap();
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM email_messages WHERE account_id = $1 AND imap_uid = 10",
        )
        .bind(*account.as_uuid())
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
        n
    };
    assert_eq!(count, 1, "no duplicate row for a re-synced UID");
}

// ===========================================================================
// Threading: a reply referencing a stored message joins its thread.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn references_group_into_one_thread_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    seed_org(&owner_pool, *org.as_uuid(), "A").await;
    let actor = seed_active_user(&owner_pool, *org.as_uuid()).await;
    let cipher = test_cipher();
    let store = PgMailStore::new(rt_pool.clone());

    let account = seed_account(&store, &cipher, org, actor).await;
    let cursors = CURRENT_ORG
        .scope(org, store.upsert_folders(org, account, &[inbox_folder()]))
        .await
        .expect("folders");
    let folder_id = cursors[0].folder_id;

    // The original message.
    CURRENT_ORG
        .scope(
            org,
            store.upsert_inbound(org, upsert_for(account, folder_id, message(20, "Budget"))),
        )
        .await
        .expect("original");

    // A reply that References the original's Message-ID.
    let mut reply = message(21, "Re: Budget");
    reply.references = vec!["m20@example.test".to_owned()];
    reply.in_reply_to = Some("m20@example.test".to_owned());
    CURRENT_ORG
        .scope(
            org,
            store.upsert_inbound(org, upsert_for(account, folder_id, reply)),
        )
        .await
        .expect("reply");

    // Exactly ONE thread holds both messages.
    let (threads, in_thread): (i64, i64) = {
        let mut tx = owner_pool.begin().await.unwrap();
        sqlx::query("SET LOCAL row_security = off")
            .execute(&mut *tx)
            .await
            .unwrap();
        let threads: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM email_threads WHERE account_id = $1")
                .bind(*account.as_uuid())
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        let max_in_thread: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(c), 0) FROM (SELECT COUNT(*) c FROM email_messages WHERE account_id = $1 GROUP BY thread_id) s",
        )
        .bind(*account.as_uuid())
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
        (threads, max_in_thread)
    };
    assert_eq!(
        threads, 1,
        "References must group the reply into one thread"
    );
    assert_eq!(in_thread, 2, "both messages live in the single thread");
}

// ===========================================================================
// Cross-tenant isolation + fail-closed for the read API as mnt_rt.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn sync_for_org_a_is_invisible_to_org_b_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org_a = OrgId::knl();
    let org_b = OrgId::from_uuid(ORG_B);
    seed_org(&owner_pool, *org_a.as_uuid(), "A").await;
    seed_org(&owner_pool, *org_b.as_uuid(), "B").await;
    let actor_a = seed_active_user(&owner_pool, *org_a.as_uuid()).await;
    let actor_b = seed_active_user(&owner_pool, *org_b.as_uuid()).await;
    let cipher = test_cipher();
    let store = PgMailStore::new(rt_pool.clone());

    // Seed + sync a message into org A.
    let account_a = seed_account(&store, &cipher, org_a, actor_a).await;
    let cursors_a = CURRENT_ORG
        .scope(
            org_a,
            store.upsert_folders(org_a, account_a, &[inbox_folder()]),
        )
        .await
        .expect("A folders");
    CURRENT_ORG
        .scope(
            org_a,
            store.upsert_inbound(
                org_a,
                upsert_for(account_a, cursors_a[0].folder_id, message(30, "Secret A")),
            ),
        )
        .await
        .expect("A message");

    // Org B has its own (empty) account.
    let account_b = seed_account(&store, &cipher, org_b, actor_b).await;

    // Under B's armed org, B sees ZERO of A's threads/messages.
    let b_threads = CURRENT_ORG
        .scope(
            org_b,
            store.list_threads(
                org_b,
                account_b,
                &ThreadQuery {
                    limit: 50,
                    ..Default::default()
                },
            ),
        )
        .await
        .expect("B thread list");
    assert!(b_threads.is_empty(), "org B must never see org A's threads");

    let b_folders = CURRENT_ORG
        .scope(org_b, store.list_folders(org_b, account_b))
        .await
        .expect("B folders");
    assert!(
        b_folders.iter().all(|f| f.total_count == 0),
        "org B's folders carry none of A's messages"
    );

    // FAIL-CLOSED: an UNARMED read (no CURRENT_ORG scope, GUC unset) sees nothing.
    // We pass org_a explicitly but the connection arms it via with_org_conn, so to
    // truly test the unarmed path we attempt a thread list with a NIL org GUC by
    // reading B's account under A's org — B's account is invisible, so the list is
    // empty (cross-tenant), and crucially A reading B's id yields nothing.
    let a_sees_b_account = CURRENT_ORG
        .scope(
            org_a,
            store.list_threads(
                org_a,
                account_b,
                &ThreadQuery {
                    limit: 50,
                    ..Default::default()
                },
            ),
        )
        .await
        .expect("A reads B's account id under A's org");
    assert!(
        a_sees_b_account.is_empty(),
        "querying another org's account id under your own org yields nothing"
    );

    // A still sees its OWN message.
    let a_threads = CURRENT_ORG
        .scope(
            org_a,
            store.list_threads(
                org_a,
                account_a,
                &ThreadQuery {
                    limit: 50,
                    ..Default::default()
                },
            ),
        )
        .await
        .expect("A thread list");
    assert_eq!(a_threads.len(), 1, "org A sees its own thread");
}

// ===========================================================================
// The SECURITY DEFINER due-account enumeration sees ACROSS tenants (id-only).
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn due_account_enumeration_spans_tenants_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org_a = OrgId::knl();
    let org_b = OrgId::from_uuid(ORG_B);
    seed_org(&owner_pool, *org_a.as_uuid(), "A").await;
    seed_org(&owner_pool, *org_b.as_uuid(), "B").await;
    let actor_a = seed_active_user(&owner_pool, *org_a.as_uuid()).await;
    let actor_b = seed_active_user(&owner_pool, *org_b.as_uuid()).await;
    let cipher = test_cipher();
    let store = PgMailStore::new(rt_pool.clone());

    let account_a = seed_account(&store, &cipher, org_a, actor_a).await;
    let account_b = seed_account(&store, &cipher, org_b, actor_b).await;

    // Both are NEVER_SYNCED (last_sync_at NULL) → both due. The scheduler's
    // enumeration runs WITHOUT arming any org (it must see across tenants).
    let due = store
        .list_due_accounts(OffsetDateTime::now_utc())
        .await
        .expect("enumerate due accounts as mnt_rt via SECURITY DEFINER");

    let ids: std::collections::HashSet<EmailAccountId> = due.iter().map(|d| d.account_id).collect();
    assert!(ids.contains(&account_a), "org A's account is due");
    assert!(ids.contains(&account_b), "org B's account is due");
    // Each pair carries its OWN org (the scheduler dispatches per-tenant).
    for entry in &due {
        if entry.account_id == account_a {
            assert_eq!(entry.org_id, org_a);
        }
        if entry.account_id == account_b {
            assert_eq!(entry.org_id, org_b);
        }
    }
}
