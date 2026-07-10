-- Messenger Slack/Teams-parity slice: discoverable channels, per-message acks,
-- personal thread mutes, reply-quotes, and activity-derived presence.
--
-- Schema-only migration for code that already shipped in the messenger crates:
--   * messenger_threads.visibility   — 'channel' (discoverable, joinable) vs
--                                       'direct' (fixed member set: DM/group/WO).
--   * messenger_messages.quoted_message_id — same-thread reply-quote (the
--                                       same-thread invariant is enforced in the
--                                       application layer; a CHECK cannot span rows).
--   * messenger_thread_mutes         — a member's personal per-thread mute.
--   * messenger_message_acks         — a member's "확인" ack on a message.
--   * messenger_presence             — last real activity (send/read/ack) per
--                                       user; status is derived at read time.
--
-- Tenant isolation follows the messenger module: org_id NOT NULL + FORCE RLS +
-- an org_isolation policy gated on app.current_org.

-- ── messenger_threads.visibility ─────────────────────────────────────────────
ALTER TABLE messenger_threads
    ADD COLUMN visibility TEXT NOT NULL DEFAULT 'direct'
        CHECK (visibility IN ('channel', 'direct'));

-- A channel is a named team room; DM/group/work-order threads are always direct.
ALTER TABLE messenger_threads
    ADD CONSTRAINT messenger_threads_channel_is_titled_team
    CHECK (visibility = 'direct' OR (kind = 'team' AND title IS NOT NULL));

CREATE INDEX idx_messenger_threads_channel_discovery
    ON messenger_threads (branch_id, updated_at DESC)
    WHERE visibility = 'channel';

-- ── messenger_messages.quoted_message_id ─────────────────────────────────────
ALTER TABLE messenger_messages
    ADD COLUMN quoted_message_id UUID
        REFERENCES messenger_messages(id) ON DELETE SET NULL;

-- ── messenger_thread_mutes ───────────────────────────────────────────────────
-- mnt-gate: audited-table messenger_thread_mutes
CREATE TABLE messenger_thread_mutes (
    thread_id UUID        NOT NULL REFERENCES messenger_threads(id) ON DELETE CASCADE,
    user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id    UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    muted_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX idx_messenger_thread_mutes_user ON messenger_thread_mutes (user_id, thread_id);

ALTER TABLE messenger_thread_mutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE messenger_thread_mutes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON messenger_thread_mutes
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── messenger_message_acks ───────────────────────────────────────────────────
-- mnt-gate: audited-table messenger_message_acks
CREATE TABLE messenger_message_acks (
    message_id UUID        NOT NULL REFERENCES messenger_messages(id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    acked_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX idx_messenger_message_acks_user ON messenger_message_acks (user_id, message_id);

ALTER TABLE messenger_message_acks ENABLE ROW LEVEL SECURITY;
ALTER TABLE messenger_message_acks FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON messenger_message_acks
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── messenger_presence ───────────────────────────────────────────────────────
-- Volatile activity read-model (not directly audited): one row per user,
-- last_activity_at only ever moves forward (GREATEST on upsert).
CREATE TABLE messenger_presence (
    user_id          UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    org_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    last_activity_at TIMESTAMPTZ NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL
);

ALTER TABLE messenger_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE messenger_presence FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON messenger_presence
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
