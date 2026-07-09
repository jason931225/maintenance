-- Messenger Slack-parity, part 1: thread taxonomy (channel(#) vs direct).
--
-- The prototype sidebar splits threads into a channels(#) section and a direct
-- section (Slack/Teams benchmark). `kind` already records how a thread was
-- created (work_order/team/dm/group); `visibility` records how it is offered:
--   * channel = a named, branch-scoped room that any active branch member may
--     join (discover via GET /api/messenger/channels, join via .../join).
--   * direct  = a fixed member set (DMs, work-order auto-threads, ad-hoc groups)
--     with no join-by-discovery.
--
-- Honest backfill rule: a `team` thread that ALREADY has a name is exactly a
-- named branch room, so it becomes a channel; EVERY other existing thread
-- (work-order auto-threads, DMs, groups, and any untitled team thread) is a
-- fixed-member conversation and becomes direct. The channel-is-named invariant
-- then holds for every backfilled row.

ALTER TABLE messenger_threads ADD COLUMN visibility TEXT;

UPDATE messenger_threads
SET visibility = CASE
    WHEN kind = 'team' AND title IS NOT NULL THEN 'channel'
    ELSE 'direct'
END;

ALTER TABLE messenger_threads
    ALTER COLUMN visibility SET NOT NULL,
    ADD CONSTRAINT messenger_threads_visibility_check
        CHECK (visibility IN ('channel', 'direct')),
    -- A channel is named (has a title); a direct thread need not be.
    ADD CONSTRAINT messenger_threads_channel_named_check
        CHECK (visibility <> 'channel' OR title IS NOT NULL),
    -- DMs and work-order auto-threads are always a fixed member set.
    ADD CONSTRAINT messenger_threads_dm_direct_check
        CHECK (kind <> 'dm' OR visibility = 'direct'),
    ADD CONSTRAINT messenger_threads_work_order_direct_check
        CHECK (kind <> 'work_order' OR visibility = 'direct');

-- Channel discovery within a branch (the joinable browse list scans this).
CREATE INDEX idx_messenger_threads_channel
    ON messenger_threads (branch_id, updated_at DESC)
    WHERE visibility = 'channel';
