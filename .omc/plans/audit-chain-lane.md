# L20 `mnt-audit-chain` — Tamper-Evident Audit-Chain Lane (design charter)

Status: PR-1 MERGED (#204, `ab63633b`, migrations 0100/0101) — post-merge review verdict **SOUND**
(static pass on the merged commit, 2026-07-09). PR-2/PR-3 charters below MUST carry the review's
five findings:

## Post-merge review findings (fold into PR-2/PR-3 scope)

- **F1 (MEDIUM, → PR-3 anchor):** head/tail truncation is UNDETECTABLE by `verify_org_chain`
  alone (lib.rs:802-808, 936-940) — deleting the newest seal(s) keeps seq contiguous and at
  most sets `unsealed_tail`. Only the out-of-band anchor (head `seal_hash`+`seq` published
  where the DB writer can't reach) closes it. Name it as an explicit limitation of verify in
  the docs; add a truncation test when the anchor lands.
  **PR-2 note:** `verify_org_chain` is a FULL-CHAIN re-verify (re-derives every seal's batch
  from its whole `audit_events` range), so the new attestation endpoint's wall time scales
  with an org's total sealed history. Bounded today by ADMIN/SUPER_ADMIN-only access + the
  mnt_rt 30s statement_timeout (0112) capping one pass. A head-N-seals or cached-verdict
  variant for long-history orgs is a PR-3 item alongside the anchor — not built in PR-2.
- **F2 (MEDIUM, → PR-2):** the §2.2 "no gaps by construction" invariant rests on a
  statement_timeout that DOES NOT EXIST — `mnt_rt` has none (migration 0031) and the only
  repo-wide hits set it to 0; the sole real bound is the app's 30s tower HTTP TimeoutLayer,
  which does NOT cover background writers (dispatch worker, workflow_drain, mail_sync, apalis,
  the seal worker itself). A >60s background txn ⇒ committed row below an advanced cursor ⇒
  verify reports a FALSE-POSITIVE CoverageGap. Fix in PR-2 before attesting:
  `ALTER ROLE mnt_rt SET statement_timeout` (+ idle_in_transaction) below SEAL_LAG, or the
  xmin-snapshot watermark the ponytail comment already names. §2.2's claim overstates today.
- **F3 (LOW/MED, → PR-3, act early):** the "dark" worker is not truly dark — prod spawns it
  unconditionally with `InMemoryEd25519Signer::generate()`, writing REAL seals every 30s with
  `key_ref=test:ed25519:<hex>` and a fresh keypair per restart. PR-3 must resolve legacy
  `test:` key_refs, or re-genesis, or (reviewer rec) env-gate the spawn OFF until the real
  signer lands.
  **Early action landed in PR-2:** the seal-worker spawn in `run_dispatch_worker` is now
  gated by `AppConfig::audit_chain_seal_enabled` (`MNT_AUDIT_CHAIN_SEAL_ENABLED`, default
  `false`), so production no longer writes test-keyed seals every tick. The attestation REST
  endpoint (PR-2) is unaffected — it reads whatever the worker has sealed regardless of the
  gate. PR-3 still owns resolving/replacing the legacy `test:` key_refs once the real signer
  lands and a deployment flips the gate on.
- **F4 (LOW, → PR-2):** no concurrency test for the double-seal defenses (advisory xact lock +
  PK(org,seq) + UNIQUE(org,prev_seal_hash), lib.rs:485-493) — argued in comments only. Add a
  two-concurrent-`seal_org_once` test.
- **F5 (LOW, → PR-2 style parity):** seal worker loop (lib.rs:625-689) has no catch_unwind
  panic isolation, unlike the cedar shadow lane. No reachable panic today; wrap the per-org
  call to match precedent so one bad org can't kill the loop.

An executor built PR-1 from the design below (historical; §0.1's `00NN` resolved to 0100/0101).
Scope: a per-org, append-only, cryptographically-sealed hash chain over
`audit_events`, plus a worker that seals and a routine that verifies.

---

## 0. Corrections to the brief (verified against the repo)

1. **Migration head is `0099`, not `0096`.** `0097_create_workflow_compensating_documents`,
   `0098_create_me_workspace_layouts`, `0099_create_notifications` are all already
   merged to `origin/main` (notifications center #198). **`0097` is NOT free.** The
   next unclaimed number is `0100`, but the lead reserved `0100+`. → **This lane must
   get an explicit migration number assigned by the lead at implement time.** The doc
   uses the placeholder `00NN` throughout; provisionally the first number the lead
   hands out (likely `0100`+). Re-confirm `git ls-files backend/crates/platform/db/migrations/`
   is contiguous before writing the file — standard collision fix.

2. **`audit_events.id` is a random UUID (`gen_random_uuid()`), not monotonic.**
   (`0003_create_audit_events.sql:11`.) There is **no serial / insert-order column**.
   This is the crux constraint for the chain ordering — see §2. The `id`-ordering the
   brief assumed does not exist.

3. **No existing hash chain.** `grep -rn 'prev_hash|hash_chain|seal_hash|prev_seal'`
   over `migrations/` and `crates/` is empty. This lane is greenfield on top of the
   existing app-level append-only guarantees.

4. **No workspace `Cargo.toml` edit needed.** Members include the glob
   `crates/platform/*` (`backend/Cargo.toml:26`), so a new `crates/platform/audit-chain`
   is auto-registered.

---

## 1. Threat model

`audit_events` today is append-only via **two app/DB-level layers** — both are about
the *live* DB, neither is *evidentiary* against an attacker who owns the DB:

- Permission layer: `REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC`
  (`0003_create_audit_events.sql:34`); `mnt_rt` additionally cannot DELETE.
- Trigger layer: `audit_events_immutable()` raises on any UPDATE/DELETE
  (`0003_create_audit_events.sql:38-53`), with one narrow carve-out — an
  `app.audit_rehome`-guarded reference release that may NULL `actor`/`branch_id` and
  move `org_id` to the platform org (for tenant deletion; see `audit_tx.rs:740-917`).

**What the chain DEFENDS against** (a party with direct DB write access — the
`mnt_app` owner, a leaked superuser, a restored-from-backup-and-edited dump — who can
disable/bypass the triggers and grants):
- **Row edit** — changing `action`, `target_*`, `before/after_snap`, `actor`,
  `occurred_at`, etc. of an already-sealed event → recomputed `batch_hash` diverges.
- **Row delete** — removing a sealed event → `row_count`/`batch_hash` for its seal
  diverges (and the `(created_at,id)` cursor develops a hole).
- **Row insert / backdate** — splicing a forged event into a sealed range → same
  detection; a forged event *after* the head can only extend the chain, and only if
  the attacker also holds the signing key (see below).
- **Reorder** — the chain fixes a total order (§2); any reordering that changes the
  canonical byte stream diverges.

**What it explicitly does NOT defend against (custody boundary):**
- A party who holds **both** DB write access **and** the seal **signing key** can
  rewrite history *and* re-sign a fresh, internally-consistent chain. Detection then
  depends entirely on an **out-of-band anchor** (see §4: `key_ref`/signature published
  to an append-only external sink — Vault audit log / object store / notary). The
  crate's job is to make forgery *require* the signing key; **key custody is the
  security boundary and lives in OCI Vault, never in the crate or `/tmp`** (mirrors the
  cluster secret discipline — a lost-to-`/tmp` Talos credential is the cautionary tale).
- The pre-existing `app.audit_rehome` reference-release path (owner-only, separately
  audited, PIPA/개인정보보호법 tenant-deletion). A re-homed row legitimately leaves its
  tenant chain; verify treats it as expected drop-out for a *deleted* tenant, not
  tamper. Same custody tier as the key holder → **out of the threat model** (documented
  §5). Do not fight it.
- NULL-`org_id` legacy/system audit rows (`with_audit` allows `event.org_id = None`,
  `audit_tx.rs:72`). These are invisible under any armed `app.current_org` and are
  **out of scope for PR-1** (a platform-org chain could cover them later).

---

## 2. Hash-link scheme (the crux: canonicalization + ordering)

### 2.1 Total order — `(created_at, id)`
The chain orders each org's events by **`(created_at ASC, id ASC)`**:
- `created_at TIMESTAMPTZ DEFAULT now()` (`0003:28`) is **DB-authoritative** (set by
  Postgres = transaction start time), **immutable** (covered by the append-only
  trigger — no UPDATE reaches it), and total when tie-broken by the immutable PK `id`.
- `occurred_at` is **app-supplied** (`OffsetDateTime::now_utc()` at event
  construction) and may be equal or backdated across rows — it is *hashed as content*
  but is **not** the sort key.

### 2.2 Seal boundary — time-lag watermark (closes the concurrency gap)
A cursor-only scan (`(created_at,id) > last_cursor`) can permanently skip a row whose
transaction *started* before the cursor but *committed* after it advanced (commit
order ≠ `now()` order). Fix: **only seal rows old enough that their transaction has
certainly committed**:

```
WHERE org_id = <armed>                         -- RLS already enforces this
  AND (created_at, id) > (cursor_created_at, cursor_id)
  AND created_at <= now() - INTERVAL 'SEAL_LAG'   -- SEAL_LAG = 60s (const)
ORDER BY created_at ASC, id ASC
LIMIT SEAL_BATCH_MAX                            -- e.g. 500, bounds one txn
```

**Invariant:** `SEAL_LAG` > max audited-transaction duration ⟹ no gaps. The app
already bounds transaction duration well under 60s via statement/lock timeouts
(`lib.rs:1499` "a stuck handler cannot pin a worker"), so this holds by construction.
`// ponytail: SEAL_LAG watermark. Correct while max txn duration < SEAL_LAG (enforced
by statement timeout). If a long-running audited txn is ever introduced, upgrade to an
xmin-snapshot watermark: pg_snapshot_xmin(pg_current_snapshot()).`

### 2.3 Canonical encoding (unambiguous — this is where verification lives or dies)
Per row, in `(created_at,id)` order, build `row_bytes` from **length-prefixed** fields
so concatenation is injective (defeats the `H(a‖b)` boundary-ambiguity class):

```
LP(x)      := u32_be(len(x)) ‖ x
row_bytes  := LP(id.as_bytes()[16])              -- UUID as 16 raw bytes
           ‖ LP(actor 16 raw bytes | empty)      -- NULL → zero-length
           ‖ LP(action utf8)
           ‖ LP(target_type utf8)
           ‖ LP(target_id utf8)
           ‖ LP(branch_id 16 raw bytes | empty)
           ‖ LP(org_id 16 raw bytes | empty)
           ‖ LP(before_snap canonical-json | empty)
           ‖ LP(after_snap  canonical-json | empty)
           ‖ LP(trace_id utf8)                   -- CHAR(32)
           ‖ LP(span_id  utf8)                   -- CHAR(16)
           ‖ LP(occurred_at RFC3339 UTC, fixed 9-digit nanos)
           ‖ LP(created_at RFC3339 UTC, fixed 9-digit nanos)
row_hash   := SHA-256(DOMAIN ‖ row_bytes)        -- DOMAIN = b"mnt.audit-chain.row.v1"
```

- **Canonical JSON** for `before_snap`/`after_snap`: deserialize the JSONB into
  `serde_json::Value` and re-serialize with `serde_json::to_vec` (default =
  **sorted keys, no whitespace**, because the workspace does NOT enable serde_json's
  `preserve_order` — `backend/crates/platform/db/Cargo.toml:13` uses the plain
  workspace dep, `backend/Cargo.toml:40`). Verify this stays off. Do **not** hash
  Postgres's `jsonb::text` (couples canonicalization to the PG version).
- **Timestamps**: format both `occurred_at` and `created_at` via `time` with a fixed
  UTC offset and fixed 9-digit sub-second precision (a single shared formatter constant)
  so seal-time and verify-time bytes are identical regardless of trailing-zero
  normalization.

### 2.4 The seal
```
batch_hash := SHA-256(DOMAIN_BATCH ‖ row_hash_1 ‖ … ‖ row_hash_n)   -- n = row_count
seal_hash  := SHA-256(DOMAIN_SEAL
               ‖ org_id(16) ‖ u64_be(seq)
               ‖ from_created_at ‖ from_id(16) ‖ to_created_at ‖ to_id(16)
               ‖ u64_be(row_count) ‖ batch_hash ‖ prev_seal_hash)
signature  := signer.sign(seal_hash)
```
- Genesis: the first seal for an org has `seq = 1`, `prev_seal_hash = [0u8;32]`.
- `seal_hash` commits to `prev_seal_hash` → tampering with seal *k* breaks every
  seal ≥ *k* (standard hash chain). The signature covers `seal_hash`, so a forger
  needs the key to re-seal any suffix.
- **Batch-granular tamper report.** Only `batch_hash` is stored, so verify localizes
  to a *seal* ("seq 42, rows created_at ∈ [a,b], n=N: batch_hash mismatch"), not a
  single row. `// ponytail: batch-granular. Store per-row row_hash (Merkle leaves) if
  forensics ever needs single-row localization.`

### 2.5 Cadence
Worker-driven, same shape as `workflow_drain` (`app/src/workflow_drain.rs:45`): tick
every `SEAL_TICK_SECS` (30s), per org seal **at most `SEAL_BATCH_MAX` rows** older than
`SEAL_LAG`; if more remain, the next tick continues (multiple seals per org per tick is
fine and increments `seq` each time). No time-based "seal even if only 1 row" special
case needed — the lag watermark already bounds staleness to `SEAL_LAG + SEAL_TICK_SECS`.

---

## 3. Storage — `audit_chain_seals` (migration `00NN`)

Mirrors the RLS + GRANT + immutable-org governance of
`0096_create_subject_authz_versions.sql` **exactly**, with one tightening: seals are
**fully immutable** (no UPDATE at all — unlike the freshness counters which UPDATE on
bump, and unlike `audit_events` which permits the re-home UPDATE). So **REVOKE UPDATE
*and* DELETE** from `mnt_rt`, GRANT only SELECT + INSERT.

```sql
CREATE TABLE audit_chain_seals (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    seq             BIGINT      NOT NULL CHECK (seq >= 1),
    from_event_id   UUID        NOT NULL,          -- first row in range (inclusive)
    from_created_at TIMESTAMPTZ NOT NULL,
    to_event_id     UUID        NOT NULL,          -- last row in range (inclusive) = new cursor
    to_created_at   TIMESTAMPTZ NOT NULL,
    row_count       BIGINT      NOT NULL CHECK (row_count >= 1),
    batch_hash      BYTEA       NOT NULL,          -- 32 bytes
    prev_seal_hash  BYTEA       NOT NULL,          -- 32 bytes ([0;32] at genesis)
    seal_hash       BYTEA       NOT NULL,          -- 32 bytes
    signature       BYTEA       NOT NULL,
    key_ref         TEXT        NOT NULL,          -- opaque signer key identifier
    sealed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, seq),
    -- continuity uniqueness: exactly one seal starts where the previous ended
    UNIQUE (org_id, prev_seal_hash)
);

ALTER TABLE audit_chain_seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_seals FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON audit_chain_seals
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- Seals are append-only evidence: SELECT + INSERT only. 0031's ALTER DEFAULT
-- PRIVILEGES auto-grants full DML incl. UPDATE+DELETE to mnt_rt on owner-created
-- tables, so both must be revoked or the runtime role could silently rewrite/erase
-- a seal and re-point the chain.
GRANT SELECT, INSERT ON audit_chain_seals TO mnt_rt;
REVOKE UPDATE, DELETE ON audit_chain_seals FROM mnt_rt;

-- org_id is in the PK and never rewritten, but keep the shared guard (mirrors 0096).
CREATE TRIGGER trg_audit_chain_seals_org_immutable
    BEFORE UPDATE ON audit_chain_seals
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

CREATE INDEX idx_audit_chain_seals_org_seq ON audit_chain_seals (org_id, seq DESC);
```

**Append-only justification:** the seals are the evidence; if `mnt_rt` could UPDATE a
`seal_hash`/`batch_hash` or DELETE a seal, the runtime role that writes seals could also
launder a tampered `audit_events`. `PRIMARY KEY (org_id, seq)` blocks double-seal of a
sequence; `UNIQUE (org_id, prev_seal_hash)` blocks two seals both claiming the same
predecessor (chain fork). The owner (`mnt_app`) retains DELETE only for `ON DELETE
CASCADE` tenant teardown.

---

## 4. Signer trait (pluggable — test key in-crate, OCI Vault at deploy)

```rust
pub trait SealSigner: Send + Sync {
    /// Opaque identifier of the key that produced/should verify a signature,
    /// persisted in audit_chain_seals.key_ref (e.g. an OCI Vault key OCID+version).
    fn key_ref(&self) -> &str;
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, SealSignError>;
    /// Verify against the key named by `key_ref` (the seal's stored key_ref), so a
    /// chain signed under a rotated key still verifies with the right public key.
    fn verify(&self, message: &[u8], signature: &[u8], key_ref: &str)
        -> Result<bool, SealSignError>;
}
```

- **Asymmetric by design** (Ed25519): production holds the *private* key in OCI Vault;
  `verify` needs only the *public* key. This is what makes "DB owner ≠ can forge"
  meaningful — the owner does not hold the signer.
- **Test/dev impl** — `InMemoryEd25519Signer`: generate an Ed25519 keypair at
  construction, `key_ref = "test:ed25519:<hex pk>"`. Use **`ring`** (already in the
  dependency/vendor tree via `rustls`/`tokio-rustls`, `backend/Cargo.toml:145-146` —
  no new third-party to reindeer/buck2-vendor) for `Ed25519KeyPair::sign` /
  `signature::ED25519.verify`. (If a direct dep reads cleaner, `ed25519-dalek` —
  verify latest version live at add time per the workspace mandate.)
- **Production impl** — `OciVaultSigner` (NOT built in PR-1): `sign` calls the OCI KMS
  crypto endpoint (Vault holds the private key, never exported); `key_ref` = the key
  OCID+version; `verify` fetches/caches the public key. Wiring reference:
  `deploy/OPS-RUNBOOK.md` + the OCI Vault secret authority. The crate takes
  `Arc<dyn SealSigner>` so `app` injects `InMemoryEd25519Signer` in dev/test and
  `OciVaultSigner` in prod — **no live-Vault dependency in the crate.**
- **Out-of-band anchor (future, not PR-1):** after each seal, publish
  `(org_id, seq, seal_hash, key_ref, signature)` to an append-only external sink so a
  key-holding forger who re-signs is still caught by divergence from the anchor. Note
  as the completion of the custody-boundary story; do not build in PR-1.

---

## 5. Worker (seal loop) + verify routine

### 5.1 Seal worker — clone `workflow_drain`
New module/crate `spawn(pool, signer) -> AuditChainHandle`, wired in `run_dispatch_worker`
(`app/src/lib.rs:2206`) with a single line next to the existing
`workflow_drain::spawn(pool.clone())` (`lib.rs:2230`). **This is the worker-role
entrypoint — it does NOT touch `build_router` (`lib.rs:1273`).** Per tick:

1. Enumerate tenants: `SELECT id FROM platform_list_organizations()` (SECURITY DEFINER,
   the RLS-safe cross-tenant discovery — same call `workflow_drain` uses,
   `workflow_drain.rs:107`; defined `migrations/0036_platform_onboarding.sql`).
2. Per org, under `scope_org(org, …)` (`crates/platform/request-context/src/lib.rs:425`)
   run one **`with_org_conn`** txn (`audit_tx.rs:219` — arms `app.current_org` as
   `mnt_rt`, RLS-scoped) that:
   a. reads the org's head seal (`MAX(seq)` row) → `(cursor, prev_seal_hash, seq)`;
      absent ⇒ genesis `(cursor = (−∞ ⇒ from beginning), prev = [0;32], seq = 0)`.
   b. selects the next batch (§2.2 query).
   c. if empty → no-op (return 0). Else compute `batch_hash`/`seal_hash`/`signature`
      (§2.4) and **INSERT one seal** row with `seq+1`.
3. Advisory lock per org — `SELECT pg_advisory_xact_lock(hashtext('mnt.audit-chain'),
   hashtext(org::text))` at the top of the txn — so two worker replicas never seal the
   same org concurrently (belt-and-suspenders on top of the `PRIMARY KEY(org_id,seq)` /
   `UNIQUE(org_id,prev_seal_hash)` constraints, which already make a double-seal fail).

### 5.2 Idempotency + crash-safety
- **Progress == the head seal row.** There is no separate cursor store; `MAX(seq)`'s
  `to_(created_at,id)` *is* the resume point. Compute-then-insert in one txn.
- Die **before** insert → cursor unmoved → next tick recomputes the identical batch
  and inserts it. Safe.
- Die **after** commit → head advanced → next tick continues from it. Safe.
- A second concurrent run that races past the lock and tries to insert `seq+1` hits the
  PK/UNIQUE constraint → its txn aborts → no duplicate, no fork. Idempotent.

### 5.3 Verify routine (`verify_org_chain(pool, org, signer) -> ChainReport`)
Recompute-and-compare; **read-only**, runnable as a REST attestation handler (PR-2), a
CI/cron integrity job, or a test. Under `with_org_conn(org)` as `mnt_rt`:
1. Load all seals for the org ordered by `seq`.
2. Walk seals: assert `seq` contiguous from 1; assert `prev_seal_hash[k] ==
   seal_hash[k-1]` (continuity, genesis `[0;32]`); re-select the `audit_events` in each
   seal's `(from,to)` range, recompute `batch_hash`/`seal_hash` (§2.4) and compare to
   stored; `signer.verify(seal_hash, signature, key_ref)`.
3. Also check **no unsealed-but-old gap**: any `audit_events` row with `created_at <=
   now() - SEAL_LAG` and `(created_at,id) >` the head seal's cursor is an unsealed-tail
   finding (worker fell behind or was stopped) — reported, not necessarily tamper.
4. Return `ChainReport { org, ok, first_bad_seq, kind }` where `kind ∈
   {Ok, SealHashMismatch, BatchHashMismatch, BrokenContinuity, BadSignature,
   MissingSeq, UnsealedTail}`.

Re-homed / deleted-tenant note: a re-homed row (§1) drops out of its tenant chain under
RLS and would surface as `BatchHashMismatch` for the seal covering it. This is expected
for a *deleted* tenant (owner-only, separately audited) and is out of the threat model;
verify is meant for **live** tenants. Document in the report so an operator does not
chase a legitimate PIPA reference release as an attack.

---

## 6. Test plan (enterprise bar — real `mnt_rt` pool, NEVER BYPASSRLS)

`#[sqlx::test]` against the runtime role, mirroring the RLS discipline already in
`audit_tx.rs` tests and the repo's `mnt_rt`-as-runtime-role mandate. Signer =
`InMemoryEd25519Signer`.

1. **seal→verify happy path.** Seed org, write N `audit_events` via `with_audit`, run
   one seal tick, assert one seal row (`seq=1`, `row_count=N`, `prev=[0;32]`);
   `verify_org_chain` ⇒ `Ok`.
2. **detect row edit.** Seal; then as the owner test connection UPDATE one sealed
   `audit_events` field (the test harness owner can bypass the trigger to *simulate*
   the attacker — the point is that the CHAIN catches what the trigger is assumed
   bypassed); `verify` ⇒ `BatchHashMismatch` at the right `seq`.
3. **detect row delete.** Seal; owner DELETE a sealed row; `verify` ⇒
   `BatchHashMismatch` (recount/rehash diverges).
4. **detect forged seal / broken continuity.** Owner-tamper a stored `seal_hash` or
   splice a seal → `verify` ⇒ `SealHashMismatch` / `BrokenContinuity` / `BadSignature`.
5. **RLS org-isolation on seals.** Seal org A and org B; under armed org A,
   `SELECT * FROM audit_chain_seals` returns only A's; a cross-org INSERT (org_id = B
   while `app.current_org = A`) is rejected by the `WITH CHECK`. Prove as `mnt_rt`.
6. **immutability of seals.** As `mnt_rt`, `UPDATE`/`DELETE` on `audit_chain_seals`
   both fail (GRANT-revoked). (Owner-level immutability is not claimed — that's the §1
   custody boundary.)
7. **idempotency.** Run the seal tick twice with no new events between ⇒ second run
   creates **no** new seal (`MAX(seq)` unchanged); run again after adding rows ⇒
   `seq` advances by exactly 1 (per batch). Prove `prev_seal_hash` chains.
8. **watermark gap-freedom (targeted).** Insert a row, run seal within `SEAL_LAG`
   (row too fresh) ⇒ not sealed yet; advance clock/lag ⇒ sealed on the next tick, no
   gap. (Drive via a small injectable `now`/lag rather than real sleeps.)

---

## 7. PR slicing

- **PR-1 (this charter, worker-only, NO REST, NO `build_router`):**
  - new crate `backend/crates/platform/audit-chain/` (auto-registered by the
    `crates/platform/*` glob — no workspace edit),
  - migration `00NN_create_audit_chain_seals.sql` (§3, number assigned by lead),
  - `SealSigner` trait + `InMemoryEd25519Signer`, canonicalizer, seal worker
    (`spawn`), `verify_org_chain`,
  - the §6 `mnt_rt` tests,
  - **one line** in `run_dispatch_worker` (`app/src/lib.rs:2230`) to `spawn` it
    alongside `workflow_drain`. This is worker-role code, not `build_router`.
- **PR-2 (later, coordinated — the single `build_router` touch):** a read-only
  `GET /api/audit/attestation` (or platform-admin) endpoint returning `ChainReport`
  per org, mounted with one `.merge(...)` in `build_router` (`lib.rs:1273`). Deferred
  precisely because `build_router` is the monorepo collision hotspot.
- **PR-3 (later):** `OciVaultSigner` + out-of-band anchor publication (§4).

---

## 8. Collision surface

**New, owned solely by this lane:**
- `backend/crates/platform/audit-chain/**` (new crate; glob-registered).
- `backend/crates/platform/db/migrations/00NN_create_audit_chain_seals.sql` (one new
  migration; number TBD-by-lead).

**Shared files touched in PR-1 (exactly one, one line):**
- `backend/app/src/lib.rs` — a single `audit_chain::spawn(pool.clone(), signer)` line
  inside `run_dispatch_worker` (~`:2230`), next to `workflow_drain::spawn`. Does **not**
  touch `build_router`. If the lead is editing `lib.rs` concurrently, this one line is a
  trivial rebase; coordinate ordering only.

**Zero overlap confirmed with:**
- The **lead** (console / notification / messenger / person-card): those are REST +
  web + the `notifications`/`messenger` crates and their own migrations (`0099` already
  landed). No shared table, no shared crate. The only common file is `lib.rs`, and PR-1
  stays out of `build_router` where the lead's `.merge(...)` lines live.
- The **Cedar-freshness lane** (view-as / auth-rest / adapter / `0096`): that lane owns
  `subject_authz_versions` (`0096`) and the auth mint/guard read path
  (`read_subject_authz_freshness`, `audit_tx.rs:274`). This lane only *reads*
  `audit_events` and writes a disjoint new table; it shares `audit_tx.rs` as a
  read-reference (`with_org_conn`) but adds nothing to it. Different migration number,
  different crate, no auth-path edits.

Only genuine contention: the **migration number** (§0.1) and the one `lib.rs` line.
Both are standard rebase-order coordination, not design collisions.
