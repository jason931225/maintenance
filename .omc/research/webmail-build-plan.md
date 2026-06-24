All key facts verified: migration head 0052 (next is 0053), authz `ALL: [Self; 39]`, RLS template uses a `DO $$` loop with `org_isolation` + `enforce_org_id_immutable()`, messenger uses single-column `id PRIMARY KEY` form, `SmtpEmailConfig` exists at line 42 with `starttls_relay`. I have what I need to produce the merged spec.

# WEBMAIL SUBSYSTEM — RECONCILED BUILD PLAN

Lead-architect merge of DATA&SYNC + SECURITY + API/UX. Concrete, sequenced, committable on `feat/multi-tenant-phase1`. Verified against live repo: migration head is `0052` (next = `0053`); `Feature::ALL` is `[Self; 39]`; RLS template lives in `0035` (`DO $$` loop + `org_isolation` + `enforce_org_id_immutable()`); messenger uses single-column `id UUID PRIMARY KEY`; `SmtpEmailConfig` exists at `backend/crates/platform/email/src/lib.rs:42` with `starttls_relay`.

---

## 1. RECONCILED FINAL DESIGN (conflicts resolved)

### 1.1 Conflicts found across the three docs and the rulings

| # | Conflict | DATA&SYNC | SECURITY | API/UX | RULING |
|---|---|---|---|---|---|
| C1 | Migration number | `0053` | (unnumbered) | (unnumbered) | **`0053_create_comms_webmail.sql`** — verified next free. |
| C2 | Credential storage shape | single `*_password_ciphertext BYTEA` (nonce‖ct), `cipher_key_version` | **envelope**: per-row DEK wrapped by KEK; `smtp_password_ct/nonce`, `imap_password_ct/nonce`, `dek_wrapped`, `dek_nonce`, `key_version` | write-only `password`, `has_password` | **Adopt SECURITY's envelope scheme.** KEK-rotation re-wraps a small DEK, not every secret; AAD binds row identity. This is the higher bar and the enterprise standard. |
| C3 | AEAD cipher | `chacha20poly1305` OR `aes-gcm` (decide at impl) | **`XChaCha20Poly1305`** (192-bit nonce → safe random per-row) | n/a | **`XChaCha20Poly1305`** (`chacha20poly1305` crate, `XChaCha20Poly1305` type). Decisive. |
| C4 | Crate context name | `comms` (`mnt-comms-*`) | (agnostic) | `webmail` (`mnt-webmail-*`) | **`comms`** (`mnt-comms-*`). DATA&SYNC's argument (full bounded context, not extending the OTP relay) is correct and its crate split is the most complete. |
| C5 | Folder enum | `INBOX,SENT,DRAFTS,ARCHIVE,TRASH,JUNK,CUSTOM` | n/a | `INBOX,SENT,DRAFTS,ARCHIVE,TRASH,CUSTOM` (no JUNK) | **Include `JUNK`** (DB CHECK + domain enum). UI may collapse JUNK into a generic folder row; API exposes it. |
| C6 | TLS-mode enum | `TLS,STARTTLS` | **no plaintext variant at all** (`StartTls`/`ImplicitTls`) | `SSL_TLS,STARTTLS,NONE` ("NONE for internal relays") | **Resolve to `SSL_TLS, STARTTLS` only — NO `NONE`/plaintext.** SECURITY wins: plaintext must be unrepresentable. Drop API/UX's `NONE`. DB CHECK = `('TLS','STARTTLS')` internally; wire enum `MailSecurity { SSL_TLS, STARTTLS }` maps `SSL_TLS→'TLS'`. |
| C7 | authz Features + counts | (defers to others) | 3 features: `EmailAccountManage[D,D,D,A,D,A]`, `EmailAccess[D,A,L,A,A,A]`, `EmailAssignManage` → 39→42 | 2 features: `MailAccountManage[D,D,D,A,D,A]`, `MailUse[D,A,D,A,A,A]` → 39→41 | **2 features, 39→41**, naming `MailAccountManage` + `MailUse` (API/UX names). Drop the separate `EmailAssignManage` (assign is part of `MailUse`). On MECHANIC: **exclude MECHANIC from `MailUse` (`[D,A,D,A,A,A]`)** — API/UX is right that mechanics live in the messenger/WO surface; SECURITY's `Limited` WO-scoped mail adds a thread-membership gate we don't need in phase 1. Revisit as a follow-on. |
| C8 | Path prefix | `/api/v1/mail/**` | (agnostic) | `/api/v1/mail/*` | **`/api/v1/mail/*`** — agreed. |
| C9 | Threads grouping unit | per-account threads | n/a | per-tenant inbox (account implicit) | **Per-account threads** (DATA&SYNC schema), but **phase-1 ships exactly ONE account per tenant** (single corporate mailbox). API treats account as implicit/singleton (`GET /mail/account`, no account_id in thread paths). Schema keeps `account_id` FKs so multi-account is a later additive change, no migration churn. |
| C10 | Sync trigger | apalis `MailSync{org,account}` job + scheduler tick + optional IDLE | worker re-enters `scope_org` per tenant | IMAP poller "outside REST, like transcode worker" | **apalis `PlatformJob::MailSync{org_id,account_id}` on `mnt.dispatch`** + a scheduler tick (owner-conn enumeration of due accounts). IDLE deferred to a later batch (risk-flag 2: doesn't scale). Poll default `sync_cadence_secs=120`. |
| C11 | Extra tables (`email_message_flags`, `email_assignments`, `email_links`) | folds flags/assign/link into columns on messages/threads | lists them as separate tables | columns on thread | **Columns, not side tables.** `seen/flagged/answered` on `email_messages`; `assigned_user_id/linked_work_order_id/linked_customer_id` on `email_threads`. Matches messenger and keeps joins clean. |

### 1.2 Decisive crate choices (versions to RE-VERIFY live at build time)

| Need | Crate | Pin to verify | Notes |
|---|---|---|---|
| IMAP client | **`async-imap`** | `0.11.2` | Over **`tokio-rustls`** at the rustls major `lettre 0.11.22` already pulls. **Do NOT add native-tls/openssl.** Verify transitive rustls version before adding (risk R1). |
| MIME parse (in) | **`mail-parser`** | `0.11.4` | Only in `adapter-imap`. |
| MIME build (out) | **`lettre`** | `0.11.22` (in workspace) | Generalize `LettreSmtpSender` to send arbitrary `lettre::Message`. |
| AEAD | **`chacha20poly1305`** (`XChaCha20Poly1305`) | `0.10.1` | |
| Secret wrap | **`secrecy`** | `0.10.3` | `SecretBox` for KEK + decrypted passwords. |
| Zeroize | **`zeroize`** | `1.x` | |
| RNG | **`rand`** | `0.9` (`OsRng`) | nonce + DEK gen. |
| DNS (SSRF) | **`hickory-resolver`** | `0.26.1` | resolve-once, validate, pin IP. |
| IP ranges | **`ipnet`** | `2.12.0` | denylist match. |

All versions per the design docs' 2026-06-23 verification — **re-check crates.io / `cargo update -p` at build time** and pin in `backend/Cargo.toml` workspace deps.

### 1.3 Final crate layout (`comms` context)

```
backend/crates/comms/
  domain/            mnt-comms-domain         — enums/VOs only: MailDirection, MailFlag, FolderRole{Inbox,Sent,Drafts,Archive,Trash,Junk,Custom}, MailSecurity{SslTls,StartTls}, MessageAddress, normalize_subject(), thread-key
  application/       mnt-comms-application     — ports: MailStore, ImapClient, SmtpSender, CredentialCipher, MailNotifier; services: AccountService, SyncService, SendService, ThreadingService. NO sqlx/async-imap here.
  adapter-postgres/  mnt-comms-adapter-postgres — PgMailStore; ALL SQL via with_audit/with_audits/with_org_conn + current_org().
  adapter-imap/      mnt-comms-adapter-imap    — AsyncImapClient (async-imap + tokio-rustls); mail-parser; SSRF guard (hickory+ipnet). ONLY place async-imap/mail-parser appear.
  credential-cipher/ mnt-comms-credential-cipher — XChaCha20Poly1305 envelope; CredentialCipher impl; KEK from MNT_MAIL_MASTER_KEY.
  rest/              mnt-comms-rest            — axum router /api/v1/mail/**; authz-gated; OpenAPI.
```
Outbound SMTP: extend `backend/crates/platform/email` to expose a generic `send(message: lettre::Message)` on `LettreSmtpSender`; `comms/application::SmtpSender` port wraps it with a per-tenant `SmtpEmailConfig`.
Worker: extend `app/src/lib.rs` `CompositeJobHandler` with a `MailSyncWorker` arm + a scheduler tick next to `start_postgres_listener` (lines ~893-899).

---

## 2. THE MIGRATION (Build step B-mail-1) — `0053_create_comms_webmail.sql`

House style verified against `0035`/`0042`/`0012`: single-column `id UUID PRIMARY KEY` (messenger form), `org_id NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT`, a trailing `DO $$` loop that does `ENABLE`+`FORCE RLS`+`CREATE POLICY org_isolation`+`GRANT … TO mnt_rt`+`enforce_org_id_immutable` trigger for every table, composite `(org_id, hot-key)` indexes, `-- mnt-gate: audited-table` markers. **No Korean in SQL.**

```sql
-- 0053_create_comms_webmail.sql
-- Per-tenant corporate webmail (SMTP+IMAP). Postgres is source of truth; IMAP mirrored in.
-- Credentials: envelope AEAD (per-row DEK wrapped by Vault KEK). All tables: org_id +
-- FORCE RLS org_isolation + immutable-org trigger (mirrors 0035/0042). No Korean copy.

-- mnt-gate: audited-table email_accounts
CREATE TABLE email_accounts (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id             UUID REFERENCES branches(id) ON DELETE RESTRICT,  -- NULL = org-wide
    display_name          TEXT NOT NULL CHECK (btrim(display_name) <> '' AND length(display_name) <= 200),
    email_address         TEXT NOT NULL CHECK (btrim(email_address) <> '' AND length(email_address) <= 320),
    from_name             TEXT,
    -- IMAP (inbound)
    imap_host             TEXT NOT NULL CHECK (btrim(imap_host) <> ''),
    imap_port             INTEGER NOT NULL CHECK (imap_port IN (143,993)),
    imap_security         TEXT NOT NULL CHECK (imap_security IN ('TLS','STARTTLS')),
    imap_username         TEXT NOT NULL,
    -- SMTP (outbound)
    smtp_host             TEXT NOT NULL CHECK (btrim(smtp_host) <> ''),
    smtp_port             INTEGER NOT NULL CHECK (smtp_port IN (465,587,25)),
    smtp_security         TEXT NOT NULL CHECK (smtp_security IN ('TLS','STARTTLS')),
    smtp_username         TEXT NOT NULL,
    -- envelope-encrypted credentials (never plaintext)
    smtp_password_ct      BYTEA NOT NULL,
    smtp_password_nonce   BYTEA NOT NULL,
    imap_password_ct      BYTEA NOT NULL,
    imap_password_nonce   BYTEA NOT NULL,
    dek_wrapped           BYTEA NOT NULL,   -- XChaCha20Poly1305(KEK, DEK)
    dek_nonce             BYTEA NOT NULL,
    key_version           SMALLINT NOT NULL DEFAULT 1,
    -- sync lifecycle
    status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','ERROR','DISABLED')),
    last_sync_at          TIMESTAMPTZ,
    last_sync_error       TEXT,
    sync_status           TEXT NOT NULL DEFAULT 'NEVER_SYNCED'
                          CHECK (sync_status IN ('OK','AUTH_FAILED','UNREACHABLE','NEVER_SYNCED')),
    sync_cadence_secs     INTEGER NOT NULL DEFAULT 120 CHECK (sync_cadence_secs >= 30),
    backfill_window_days  INTEGER NOT NULL DEFAULT 90 CHECK (backfill_window_days BETWEEN 1 AND 3650),
    consecutive_auth_failures INTEGER NOT NULL DEFAULT 0,  -- circuit-breaker counter
    created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, email_address)
);

-- mnt-gate: audited-table email_folders
CREATE TABLE email_folders (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    account_id     UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    imap_path      TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'CUSTOM'
                   CHECK (role IN ('INBOX','SENT','DRAFTS','ARCHIVE','TRASH','JUNK','CUSTOM')),
    name           TEXT NOT NULL,
    uid_validity   BIGINT,
    last_seen_uid  BIGINT NOT NULL DEFAULT 0,
    highest_modseq BIGINT,
    unread_count   INTEGER NOT NULL DEFAULT 0,
    total_count    INTEGER NOT NULL DEFAULT 0,
    last_synced_at TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, account_id, imap_path)
);

-- mnt-gate: audited-table email_threads
CREATE TABLE email_threads (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    account_id           UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    normalized_subject   TEXT NOT NULL,
    subject              TEXT NOT NULL,
    last_message_at      TIMESTAMPTZ NOT NULL,
    message_count        INTEGER NOT NULL DEFAULT 0,
    unread_count         INTEGER NOT NULL DEFAULT 0,
    has_attachments      BOOLEAN NOT NULL DEFAULT FALSE,
    is_flagged           BOOLEAN NOT NULL DEFAULT FALSE,
    assigned_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    linked_work_order_id UUID REFERENCES work_orders(id) ON DELETE SET NULL,
    linked_customer_id   UUID REFERENCES registry_customers(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- mnt-gate: audited-table email_messages
CREATE TABLE email_messages (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    account_id        UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    folder_id         UUID NOT NULL REFERENCES email_folders(id) ON DELETE CASCADE,
    thread_id         UUID NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
    imap_uid          BIGINT,
    imap_uid_validity BIGINT,
    message_id        TEXT,
    in_reply_to       TEXT,
    references_ids    TEXT[] NOT NULL DEFAULT '{}',
    direction         TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
    from_address      TEXT NOT NULL,
    from_name         TEXT,
    to_addresses      JSONB NOT NULL DEFAULT '[]',
    cc_addresses      JSONB NOT NULL DEFAULT '[]',
    bcc_addresses     JSONB NOT NULL DEFAULT '[]',
    subject           TEXT NOT NULL DEFAULT '',
    snippet           TEXT NOT NULL DEFAULT '',
    body_text         TEXT,
    body_html         TEXT,
    seen              BOOLEAN NOT NULL DEFAULT FALSE,
    flagged           BOOLEAN NOT NULL DEFAULT FALSE,
    answered          BOOLEAN NOT NULL DEFAULT FALSE,
    draft             BOOLEAN NOT NULL DEFAULT FALSE,
    has_attachments   BOOLEAN NOT NULL DEFAULT FALSE,
    send_status       TEXT CHECK (send_status IN ('PENDING','SENT','FAILED')),  -- OUT only
    send_error        TEXT,
    received_at       TIMESTAMPTZ NOT NULL,
    sent_at           TIMESTAMPTZ,
    search_vector     TSVECTOR GENERATED ALWAYS AS (
                        to_tsvector('simple',
                          coalesce(subject,'') || ' ' || coalesce(snippet,'') || ' ' ||
                          coalesce(from_name,'') || ' ' || coalesce(from_address,''))
                      ) STORED,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- mnt-gate: audited-table email_attachments
CREATE TABLE email_attachments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    message_id   UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
    s3_key       TEXT NOT NULL,   -- orgs/{org}/mail/{account}/{message}/{n}-{filename}
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes   BIGINT NOT NULL CHECK (size_bytes >= 0),
    content_id   TEXT,
    is_inline    BOOLEAN NOT NULL DEFAULT FALSE,
    upload_state TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (upload_state IN ('PENDING','CONFIRMED')),
    sort_order   SMALLINT NOT NULL CHECK (sort_order > 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, message_id, sort_order)
);

-- RLS + immutable-org trigger on every table (the 0035/0042 inline pattern)
DO $$
DECLARE t TEXT;
        comms_tables TEXT[] := ARRAY[
            'email_accounts','email_folders','email_threads','email_messages','email_attachments'];
BEGIN
    FOREACH t IN ARRAY comms_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY org_isolation ON %I '
            || 'USING (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid) '
            || 'WITH CHECK (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid)', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO mnt_rt', t);
        EXECUTE format(
            'CREATE TRIGGER trg_%s_org_immutable BEFORE UPDATE ON %I '
            || 'FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable()', t, t);
    END LOOP;
END $$;

-- indexes (composite org_id-first)
CREATE UNIQUE INDEX idx_email_messages_imap_identity
    ON email_messages (org_id, account_id, folder_id, imap_uid_validity, imap_uid)
    WHERE imap_uid IS NOT NULL;
CREATE INDEX idx_email_messages_message_id
    ON email_messages (org_id, account_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_email_messages_thread_cursor
    ON email_messages (org_id, thread_id, received_at DESC, id DESC);
CREATE INDEX idx_email_messages_folder_list
    ON email_messages (org_id, folder_id, received_at DESC);
CREATE INDEX idx_email_messages_unseen
    ON email_messages (org_id, account_id) WHERE seen = FALSE;
CREATE INDEX idx_email_messages_search ON email_messages USING GIN (search_vector);
CREATE INDEX idx_email_threads_inbox
    ON email_threads (org_id, account_id, last_message_at DESC, id DESC);
CREATE INDEX idx_email_threads_assignee
    ON email_threads (org_id, assigned_user_id) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX idx_email_threads_linked_wo
    ON email_threads (org_id, linked_work_order_id) WHERE linked_work_order_id IS NOT NULL;
CREATE INDEX idx_email_threads_normsubj
    ON email_threads (org_id, account_id, normalized_subject);
CREATE INDEX idx_email_folders_account ON email_folders (org_id, account_id);
CREATE INDEX idx_email_accounts_org ON email_accounts (org_id, status);
CREATE INDEX idx_email_attachments_msg ON email_attachments (org_id, message_id);
```

> Confirm at build time: `registry_customers` and `work_orders` table names exist (the FK targets) — grep before applying. If a customer table differs (#50 CRUD), adjust the FK. Note `imap_port`/`smtp_port` use an `IN (...)` CHECK to enforce the SECURITY port-allowlist at the DB layer too (defense-in-depth; `25` allowed for SMTP only, can be dropped later).

---

## 3. SEQUENCED BATCH BREAKDOWN

Value-first ordering: **config+send first** (immediate user value, no IMAP risk), **then inbound IMAP read**, **then threads/assign/link**, **then search/badges/realtime/polish**. Each batch is independently committable; each ends with the full gate (backend `cargo fmt`+`clippy -D warnings`+tests-as-`mnt_rt` ; web `lint`+`build`+`test`; `check:openapi-app` file-equality + TS/Swift client regen when schema changes; Korean copy only in `ko.ts`).

### B-mail-1 — Migration + domain + credential-cipher (foundation, no endpoints)
- **Touches:** `0053_create_comms_webmail.sql`; new crates `comms/domain`, `comms/credential-cipher`, `comms/application` (ports only); `backend/Cargo.toml` (add async-imap/mail-parser/chacha20poly1305/secrecy/zeroize/rand/hickory-resolver/ipnet to workspace, behind features where possible); `deploy/SECRETS.md` (+ `MNT_MAIL_MASTER_KEY` to `mnt-secrets`, OCI Vault); `Cargo.toml` workspace members.
- **Schema:** all 5 tables + RLS. **Endpoints:** none.
- **Tests:** (a) **real `mnt_rt` RLS test** (new `comms/adapter-postgres/tests/...rls_surfaces_as_runtime_role.rs`, mirror `region_branch_crud_rls_surfaces_as_runtime_role.rs`): insert an `email_accounts` row under org A armed via `with_audit`; assert org B armed sees **zero** rows; assert an **unarmed** read returns zero/fails. (b) `credential-cipher` unit tests: round-trip encrypt/decrypt; **AAD mismatch (wrong org/account/field) fails auth**; KEK-rotation re-wrap keeps payload; `Debug` of secret types prints `[REDACTED]`.
- **Acceptance:** `migrate` applies clean on a fresh DB; RLS cross-tenant negative test green as `mnt_rt`; cipher tests green; rustls stays single-stack (`cargo tree -d | grep rustls` shows one major — risk R1 gate).

### B-mail-2 — Account config + test-connection + SMTP send/reply/forward (first user value)
- **Touches:** `comms/adapter-postgres` (PgMailStore: account CRUD, message insert for OUT), `comms/adapter-imap` (SSRF guard module + IMAP test-connect only), `comms/application` (AccountService, SendService), `platform/email` (generalize `LettreSmtpSender::send(lettre::Message)`), `comms/rest` (account + send + presign endpoints), `app/src/lib.rs` (mount router), `authz/src/lib.rs` (**`Feature::ALL` 39→41**, add `MailAccountManage`/`MailUse` + `matrix_row()` arms), `storage/src/lib.rs` (`mail_attachment_key` helper), `openapi.yaml` + TS + Swift clients; web: `MailSettingsPage.tsx`, `MailAccountForm`, `TestConnectionButton`, `ComposeDialog` (NEW/REPLY/FORWARD), nav gate `mail-settings`, `ko.ts` `mail.settings.*`/`mail.compose.*`/`mail.security.*`.
- **Endpoints:** `GET/PUT/DELETE /mail/account`, `POST /mail/account/test-connection`, `POST /mail/attachments/presign`, `POST /mail/attachments/{id}/confirm`, `POST /mail/messages` (NEW/REPLY/REPLY_ALL/FORWARD), `GET /mail/attachments/{id}/download`.
- **Tests:** mnt_rt account-CRUD RLS test (incl. **password write-only**: response DTO has no password field, verified by schema + a serde test); SSRF unit tests (reject `169.254.169.254`, `127.0.0.1`, RFC1918, `::ffff:169.254.169.254` un-mapped, non-allowlisted port); send-path test (From constrained to account address; SMTP failure marks `send_status='FAILED'` + audit, no orphan); rate-limit unit test; `check:openapi-app` equality.
- **Acceptance:** an admin configures a corporate mailbox (write-only creds), Test Connection returns structured `{ok,error_code}`, sends a real reply/forward with attachment via the tenant's SMTP, OUT row persisted + audited (`email.send`/`email.reply`/`email.forward`); SSRF + rate-limit gates pass.

### B-mail-3 — Inbound IMAP sync engine + worker wiring + folders/messages read
- **Touches:** `comms/adapter-imap` (AsyncImapClient: select/UIDVALIDITY/UID FETCH `BODY.PEEK[]`/CONDSTORE/backfill window/batched paging; mail-parser → MailMessage; attachment upload to RustFS org-prefixed key), `comms/application` (SyncService, ThreadingService), `comms/adapter-postgres` (idempotent UPSERT on `idx_email_messages_imap_identity` + Message-ID secondary dedupe; folder cursor updates; thread aggregate maintenance), `app/src/lib.rs` (`PlatformJob::MailSync{org,account}` arm in `CompositeJobHandler` wrapped in `scope_org`; scheduler tick by `start_postgres_listener`; `MNT_MAIL_ENABLED` flag + KEK-present gate; `Semaphore` cap), `jobs/src/lib.rs` (job variant), `comms/rest` (folders + thread/message read), web: `MailPage` three-pane (FolderRail/ThreadList/ReadingPane), `mail-format.ts`/`mail-state.ts`, nav `mail`, `ko.ts` `mail.folders.*`/`mail.toolbar.*`. Sanitize `body_html` (DOMPurify-class) before render.
- **Endpoints:** `GET /mail/folders`, `GET /mail/threads`, `GET /mail/threads/{id}`, `GET /mail/messages/{id}`, `PUT /mail/threads/{id}/read`, `PUT /mail/messages/{id}/read`, `PUT /mail/threads/{id}/flag`.
- **Tests:** **mnt_rt sync-worker isolation test** — worker armed to org A (via `scope_org`) sees zero of org B's accounts/messages; unarmed worker read returns zero (this is the R6 gate). Idempotency test: re-running sync over the same UID range inserts no duplicate (UPSERT refreshes flags). UIDVALIDITY-reset branch test. Threading test: References-walk + normalized-subject fallback (incl. Korean `회신:`/`전달:` strip). `BODY.PEEK[]` (no `\Seen` side-effect) asserted.
- **Acceptance:** with `MNT_MAIL_ENABLED=1` + KEK present, a configured mailbox backfills its window, inbox/threads render with sanitized bodies + presigned-GET attachments, read/flag round-trips to the server via `UID STORE`, re-sync is idempotent. Subsystem degrades to OFF when unconfigured (like email/push stubs).

### B-mail-4 — Threads: assign-to-staff + link-to-WO/customer
- **Touches:** `comms/adapter-postgres` (assignee/link updates), `comms/application`, `comms/rest`, `openapi.yaml`+clients; web: `AssignControl` (Combobox of org users), `LinkControl` (AsyncCombobox WO + customer), thread-row chips, `ko.ts` `mail.assign.*`/`mail.link.*`.
- **Endpoints:** `PUT /mail/threads/{id}/assignee`, `PUT /mail/threads/{id}/link`.
- **Tests:** mnt_rt test that assignee/linked WO/customer **resolve only within the caller's org** (cross-tenant FK set is rejected/invisible); response returns **human labels, never bare UUIDs**; audit codes `email.assign`/`email.link.work_order`/`email.link.customer`.
- **Acceptance:** a receptionist assigns a thread to a staff member and links it to a WO + customer; chips render labels; filters `assigned_to`/`linked_work_order_id`/`linked_customer_id` work.

### B-mail-5 — Search + unread badges + realtime + polish
- **Touches:** `comms/adapter-postgres` (FTS over `search_vector` + ILIKE Korean fallback; keyset pagination), `comms/rest` (`q` on threads, unread-count), `platform/realtime` (`mail_message_posted` channel; hub re-read under `with_org_conn`), worker `pg_notify` on new inbound; web `useMailUnreadPoll` nav badge + per-folder/per-thread counts, search bar, live refresh; `ko.ts` `mail.unread`/`mail.syncStatus.*`.
- **Endpoints:** `GET /mail/unread-count`, `q=` param on `GET /mail/threads`.
- **Tests:** mnt_rt search returns only same-org hits; unread-count aggregate matches; realtime push re-reads under armed org (no cross-tenant leak).
- **Acceptance:** search returns relevant same-org threads; nav badge + folder/thread unread counts live-update on new inbound mail; sync-status surfaces (`OK/AUTH_FAILED/UNREACHABLE/NEVER_SYNCED`).

### B-mail-6 (optional, deferred) — IMAP IDLE + KEK rotation job + bounce/auto-reply detection + per-tenant suppression
Bounded IDLE set for high-priority accounts; `mail.key.rotate` audited maintenance job (re-wrap DEKs); DSN/`Auto-Submitted`/`Precedence: bulk` parsing → per-tenant soft-suppression (never cross-tenant); circuit-breaker surfacing ("재인증이 필요합니다"). Ship only after B-mail-1..5 are green.

---

## 4. SECURITY-REVIEW CHECKLIST (must pass before EACH backend batch commits)

**Credential encryption at rest** (gate B-mail-1, re-checked every batch touching accounts)
- [ ] `email_accounts` stores only AEAD ct+nonce+`dek_wrapped`+`dek_nonce`+`key_version`; **no plaintext password column**.
- [ ] `XChaCha20Poly1305`; per-row 24-byte `OsRng` nonce; **AAD binds `org_id‖account_id‖field`** (copied-ciphertext fails auth).
- [ ] KEK from `MNT_MAIL_MASTER_KEY` (OCI Vault → `mnt-secrets` env); never git/`/tmp`/logs; held in `SecretBox`.
- [ ] Decrypted password lives only inside the transport-build closure; zeroized on drop.

**Write-only API surface** (gate B-mail-2)
- [ ] Account response schema **omits** password (not nulled); `check:openapi-app` passes; TS+Swift regenerated.
- [ ] Empty password on `PUT` = unchanged; non-empty = re-encrypt; existing secret never round-tripped.
- [ ] No secret/username/recipient/body logged at `info`; the `email/src/lib.rs:143` stub-log leak NOT replicated; transport errors mapped to fixed strings.

**Connection security** (gate B-mail-2/B-mail-3)
- [ ] SMTP via lettre rustls `starttls_relay`/`relay`; IMAP via `async-imap`+`tokio-rustls`; **`cargo tree -d` shows ONE rustls major** (R1).
- [ ] `MailSecurity` enum has **no plaintext/None/opportunistic** variant; no `builder_dangerous`/custom cert verifier.
- [ ] Cert failure → distinct `TlsVerification{host}` error + Korean i18n string; never raw rustls strings to client.

**SSRF / abuse** (gate B-mail-2)
- [ ] Port allowlist enforced at validation **and** DB CHECK (`993,143` / `465,587,25`).
- [ ] Host resolved via `hickory-resolver`; resolved IPs denylisted via `ipnet` (RFC1918, loopback, **`169.254/16`**, `fc00::/7`, CGNAT, **IPv4-mapped-IPv6 un-mapped before check**).
- [ ] DNS-rebind safe: resolve once, dial pinned IP, SNI=original host; re-validate each sync cycle.
- [ ] Test-connection: `MailAccountManage`-gated, per-org rate-limited, short timeout, `{ok,error_code}` only.

**Multi-tenant isolation** (gate EVERY backend batch)
- [ ] Every `email_*` table: `org_id NOT NULL` + ENABLE+FORCE RLS + `org_isolation` (matches `0035`).
- [ ] **No raw-pool** read/write of any `email_*` table; reads `with_org_conn(current_org()?)`, writes `with_audit`/`with_audits`.
- [ ] Sync worker **re-enters `scope_org(org_id,…)` per tenant**; credential decrypt only after GUC armed to that org; no cross-account secret cache; account enumeration is an explicit owner-conn `(org_id,account_id)`-only read.
- [ ] **Isolation test runs as real `mnt_rt`** (NOBYPASSRLS): org A sees zero of org B; unarmed read = zero. (R6)

**AuthZ + audit** (gate B-mail-2 onward)
- [ ] `MailAccountManage [D,D,D,A,D,A]` + `MailUse [D,A,D,A,A,A]` added; `Feature::ALL` 39→41; `matrix_row()` arms added; count literal updated.
- [ ] Every config/send/reply/forward/assign/link routed through `with_audit`/`with_audits` with `email.*` action codes; credential-change audit records `{has_credential:true}` only.

**Abuse** (gate B-mail-2)
- [ ] Per-org + per-user outbound rate-limits (persisted); recipient-count cap (≤50).
- [ ] `From` constrained to the configured account address/domain (no arbitrary sender/relay).
- [ ] Attachments reuse storage content-type allowlist + size cap + org-prefixed keys; served only via presigned GET.

---

## 5. OPEN RISKS / DECISIONS TO CONFIRM

1. **R1 — rustls single-stack (highest friction).** Before adding `async-imap`+`tokio-rustls`, run `cargo tree -d | grep -E 'rustls|ring'` and pin `tokio-rustls` to the rustls major `lettre 0.11.22` already pulls. Two rustls/ring versions = bloat + the buck2 `include_bytes` holdout pain (project memory). **Gate B-mail-1.**
2. **FK target names.** Confirm `registry_customers` and `work_orders` are the exact live table names before writing the migration FKs (the `linked_*` columns). Grep at B-mail-1.
3. **`registry_customers` vs #50 customer CRUD.** API/UX assumes a customer search exists (#50). If the customer table is named differently, adjust both the FK and the `LinkControl` autocomplete source.
4. **Single-account phase-1 vs multi-account schema.** Confirmed ruling: schema carries `account_id` everywhere but API/UX ships ONE mailbox per tenant in phase 1. Confirm this is acceptable (it is additive-safe).
5. **MECHANIC mail access.** Ruling excludes MECHANIC from `MailUse`. If the business wants mechanics to see WO-linked mail threads, that's a follow-on (SECURITY's `Limited`+thread-membership gate) — confirm deferral.
6. **Audit volume for reads.** `email.read`/`email.thread.open` auditing can be high-volume. Ruling: audit **thread-open**, not every message render. Confirm acceptable granularity.
7. **Egress NetworkPolicy (ops backstop).** App-level SSRF checks are necessary-not-sufficient; recommend an ops-side egress rule denying cluster CIDR + `169.254.0.0/16` from the worker pod, allowing only public `:465/:587/:993/:143/:25`. Track as an ops ticket parallel to B-mail-3.
8. **IDLE deferral.** Phase-1 is poll-only (`sync_cadence_secs` default 120). IDLE (B-mail-6) only if near-realtime inbound is required and the bounded-connection cap is enforced.
9. **`smtp_port=25` allowance.** DB CHECK currently permits 25 for SMTP. If authed submission only, drop to `(465,587)` to shrink the SSRF surface — confirm.

Migration file (first build step): `backend/crates/platform/db/migrations/0053_create_comms_webmail.sql`. New crates root: `backend/crates/comms/{domain,application,adapter-postgres,adapter-imap,credential-cipher,rest}`. Worker/scheduler wiring: `backend/app/src/lib.rs` (`CompositeJobHandler` ~2018-2171, `start_postgres_listener` ~893-899). Authz: `backend/crates/platform/authz/src/lib.rs` (`ALL: [Self; 39]`→41). RLS template copied from `backend/crates/platform/db/migrations/0035_enable_rls_rollout.sql`.