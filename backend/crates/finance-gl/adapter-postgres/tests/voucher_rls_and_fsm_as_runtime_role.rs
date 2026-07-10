#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS + FSM gate for the finance-GL voucher (전표) domain, exercised as
//! the genuine non-owner runtime role `mnt_rt` (NOSUPERUSER / NOBYPASSRLS / FORCE
//! RLS) — the only faithful exercise of the tenant policy. The default
//! `#[sqlx::test]` pool connects as a BYPASSRLS superuser that sees every row and
//! would green-light a broken policy, so we SEED as the owner and DO EVERYTHING
//! ELSE as `mnt_rt`.
//!
//! Proves the lane's binding invariants:
//!   (a) BALANCE GATE — an unbalanced voucher cannot advance past 차대검증, both
//!       via the use-case (`submit`) and via a raw status UPDATE (the DB trigger).
//!   (b) POSTED IMMUTABILITY — a posted voucher rejects further FSM steps and its
//!       lines cannot be inserted/mutated (append-only, draft-only trigger).
//!   (c) REVERSAL — reversing a posted voucher creates a linked contra voucher
//!       (sides swapped) that nets the pair to zero; the original is marked
//!       REVERSED and points at its contra. The posted voucher is never mutated.
//!   (d) CROSS-ORG ISOLATION — under org A's armed GUC, org B's voucher is
//!       not-found, and the account drill never sees B's lines.
//!   (e) FAIL-CLOSED — with no tenant scope armed, every read/write errors.

use mnt_finance_gl_adapter_postgres::PgVoucherStore;
use mnt_finance_gl_application::{
    CreateVoucherDraftCommand, ReverseVoucherCommand, VoucherLineInput, VoucherSourceRef,
    VoucherTransitionCommand,
};
use mnt_finance_gl_domain::{DebitCredit, VoucherId, VoucherStatus};
use mnt_kernel_core::{BranchId, OrgId, TraceContext, UserId};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::macros::datetime;
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0x0A11_0A11_0A11_0A11_0A11_0A11_0A11_0A11);
const ORG_B: Uuid = Uuid::from_u128(0x0B22_0B22_0B22_0B22_0B22_0B22_0B22_0B22);

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
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING")
        .bind(org)
        .bind(format!("org-{}", tag.to_lowercase()))
        .bind(format!("Org {tag}"))
        .execute(owner_pool)
        .await
        .unwrap();
}

async fn seed_branch(owner_pool: &PgPool, org: Uuid) -> BranchId {
    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("Region {}", Uuid::new_v4()))
            .bind(org)
            .fetch_one(owner_pool)
            .await
            .unwrap();
    let branch_id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(format!("Branch {}", Uuid::new_v4()))
    .bind(org)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user(owner_pool: &PgPool, org: Uuid) -> UserId {
    let user_id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("User {}", Uuid::new_v4()))
        .bind(Vec::from(["ADMIN"]))
        .bind(org)
        .execute(owner_pool)
        .await
        .unwrap();
    user_id
}

fn line(account: &str, side: DebitCredit, amount_won: i64) -> VoucherLineInput {
    VoucherLineInput {
        account_code: account.to_owned(),
        side,
        amount_won,
        memo: String::new(),
    }
}

fn draft(
    actor: UserId,
    branch_id: BranchId,
    lines: Vec<VoucherLineInput>,
    source: Option<VoucherSourceRef>,
) -> CreateVoucherDraftCommand {
    CreateVoucherDraftCommand {
        actor,
        branch_id,
        memo: "test voucher".to_owned(),
        source,
        lines,
        trace: TraceContext::generate(),
        occurred_at: datetime!(2026-07-10 09:00 UTC),
    }
}

fn step(actor: UserId, voucher_id: VoucherId) -> VoucherTransitionCommand {
    VoucherTransitionCommand {
        actor,
        voucher_id,
        trace: TraceContext::generate(),
        occurred_at: datetime!(2026-07-10 09:00 UTC),
    }
}

/// Drive a balanced draft all the way to POSTED and return its id.
async fn seed_posted_voucher(
    store: &PgVoucherStore,
    org: OrgId,
    actor: UserId,
    branch_id: BranchId,
) -> VoucherId {
    mnt_platform_request_context::scope_org(org, async {
        let created = store
            .create_draft(draft(
                actor,
                branch_id,
                vec![
                    line("1000", DebitCredit::Debit, 10_000),
                    line("4000", DebitCredit::Credit, 10_000),
                ],
                Some(VoucherSourceRef {
                    object_type: "expense_approval".to_owned(),
                    object_id: "EXP-1".to_owned(),
                }),
            ))
            .await
            .unwrap();
        store.submit(step(actor, created.id)).await.unwrap();
        store.approve(step(actor, created.id)).await.unwrap();
        let posted = store.post(step(actor, created.id)).await.unwrap();
        assert_eq!(posted.status, VoucherStatus::Posted);
        assert!(posted.posted_at.is_some());
        created.id
    })
    .await
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn balance_gate_blocks_unbalanced_advance(owner_pool: PgPool) {
    seed_org(&owner_pool, ORG_A, "A").await;
    let branch = seed_branch(&owner_pool, ORG_A).await;
    let actor = seed_user(&owner_pool, ORG_A).await;
    let rt = runtime_role_pool(&owner_pool).await;
    let store = PgVoucherStore::new(rt);
    let org = OrgId::from_uuid(ORG_A);

    let unbalanced_id = mnt_platform_request_context::scope_org(org, async {
        let created = store
            .create_draft(draft(
                actor,
                branch,
                vec![
                    line("1000", DebitCredit::Debit, 10_000),
                    line("4000", DebitCredit::Credit, 9_000),
                ],
                None,
            ))
            .await
            .unwrap();
        // Use-case balance gate: submit (기표 → 차대검증) must fail closed.
        let submitted = store.submit(step(actor, created.id)).await;
        assert!(
            submitted.is_err(),
            "unbalanced voucher must not clear 차대검증"
        );
        // Still DRAFT after the rejected submit.
        let reread = store.get(created.id).await.unwrap();
        assert_eq!(reread.status, VoucherStatus::Draft);
        created.id
    })
    .await;

    // Defense in depth: a raw status UPDATE past 차대검증 is rejected by the DB
    // trigger even if the use-case gate were bypassed. Arm the GUC ourselves so
    // the row is visible to RLS and the trigger — not RLS — is what rejects it.
    let mut tx = store.pool().begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let raw =
        sqlx::query("UPDATE finance_gl_vouchers SET status = 'BALANCE_CHECKED' WHERE id = $1")
            .bind(*unbalanced_id.as_uuid())
            .execute(tx.as_mut())
            .await;
    assert!(raw.is_err(), "DB trigger must reject unbalanced advance");
    let _ = tx.rollback().await;
    let _ = org;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn posted_voucher_is_immutable(owner_pool: PgPool) {
    seed_org(&owner_pool, ORG_A, "A").await;
    let branch = seed_branch(&owner_pool, ORG_A).await;
    let actor = seed_user(&owner_pool, ORG_A).await;
    let rt = runtime_role_pool(&owner_pool).await;
    let store = PgVoucherStore::new(rt);
    let org = OrgId::from_uuid(ORG_A);

    let posted_id = seed_posted_voucher(&store, org, actor, branch).await;

    // No further FSM step except reverse (use-case gate).
    mnt_platform_request_context::scope_org(org, async {
        assert!(
            store.approve(step(actor, posted_id)).await.is_err(),
            "posted voucher must reject 승인"
        );
        assert!(
            store.submit(step(actor, posted_id)).await.is_err(),
            "posted voucher must reject 차대검증"
        );
    })
    .await;

    // Lines are append-only + draft-only: a raw INSERT into a posted voucher is
    // rejected by the trigger (posted lines immutable). Arm the GUC so the
    // trigger — not RLS — is what rejects it.
    let mut tx = store.pool().begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let inject = sqlx::query(
        r#"INSERT INTO finance_gl_voucher_lines
             (id, org_id, voucher_id, line_no, account_code, side, amount_won, memo)
           VALUES (gen_random_uuid(), $1, $2, 99, '9999', 'DEBIT', 1, '')"#,
    )
    .bind(ORG_A)
    .bind(*posted_id.as_uuid())
    .execute(tx.as_mut())
    .await;
    assert!(
        inject.is_err(),
        "posted voucher lines must be immutable (draft-only INSERT)"
    );
    let _ = tx.rollback().await;

    // A raw UPDATE of a posted line is impossible — mnt_rt holds no UPDATE grant
    // on the lines table (append-only), so it errors regardless of tenant scope.
    let mut tx = store.pool().begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let mutate =
        sqlx::query("UPDATE finance_gl_voucher_lines SET amount_won = 1 WHERE voucher_id = $1")
            .bind(*posted_id.as_uuid())
            .execute(tx.as_mut())
            .await;
    assert!(mutate.is_err(), "mnt_rt must not UPDATE posted lines");
    let _ = tx.rollback().await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn reversal_links_and_nets_to_zero(owner_pool: PgPool) {
    seed_org(&owner_pool, ORG_A, "A").await;
    let branch = seed_branch(&owner_pool, ORG_A).await;
    let actor = seed_user(&owner_pool, ORG_A).await;
    let rt = runtime_role_pool(&owner_pool).await;
    let store = PgVoucherStore::new(rt);
    let org = OrgId::from_uuid(ORG_A);

    let posted_id = seed_posted_voucher(&store, org, actor, branch).await;

    mnt_platform_request_context::scope_org(org, async {
        let contra = store
            .reverse(ReverseVoucherCommand {
                actor,
                voucher_id: posted_id,
                memo: "역분개 사유".to_owned(),
                trace: TraceContext::generate(),
                occurred_at: datetime!(2026-07-10 10:00 UTC),
            })
            .await
            .unwrap();

        // Contra links back to the original and is itself posted.
        assert_eq!(contra.reversal_of_voucher_id, Some(posted_id));
        assert_eq!(contra.status, VoucherStatus::Posted);

        // Original is now REVERSED and points at its contra — never mutated lines.
        let original = store.get(posted_id).await.unwrap();
        assert_eq!(original.status, VoucherStatus::Reversed);
        assert_eq!(original.reversed_by_voucher_id, Some(contra.id));

        // Sides are swapped, so the pair nets to zero.
        assert_eq!(original.debit_total_won, contra.credit_total_won);
        assert_eq!(original.credit_total_won, contra.debit_total_won);
        assert_eq!(
            original.debit_total_won + contra.debit_total_won,
            original.credit_total_won + contra.credit_total_won,
            "reversed pair must net to zero"
        );

        // Reversing again is rejected (REVERSED is terminal).
        assert!(
            store
                .reverse(ReverseVoucherCommand {
                    actor,
                    voucher_id: posted_id,
                    memo: "again".to_owned(),
                    trace: TraceContext::generate(),
                    occurred_at: datetime!(2026-07-10 10:00 UTC),
                })
                .await
                .is_err(),
            "a reversed voucher cannot be reversed twice"
        );
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn cross_org_isolation_and_fail_closed(owner_pool: PgPool) {
    seed_org(&owner_pool, ORG_A, "A").await;
    seed_org(&owner_pool, ORG_B, "B").await;
    let branch_a = seed_branch(&owner_pool, ORG_A).await;
    let branch_b = seed_branch(&owner_pool, ORG_B).await;
    let actor_a = seed_user(&owner_pool, ORG_A).await;
    let actor_b = seed_user(&owner_pool, ORG_B).await;
    let rt = runtime_role_pool(&owner_pool).await;
    let store = PgVoucherStore::new(rt);
    let org_a = OrgId::from_uuid(ORG_A);
    let org_b = OrgId::from_uuid(ORG_B);

    // Each tenant posts one voucher on distinct accounts.
    let a_id = mnt_platform_request_context::scope_org(org_a, async {
        store
            .create_draft(draft(
                actor_a,
                branch_a,
                vec![
                    line("1000", DebitCredit::Debit, 5_000),
                    line("4000", DebitCredit::Credit, 5_000),
                ],
                None,
            ))
            .await
            .unwrap()
            .id
    })
    .await;
    let b_id = mnt_platform_request_context::scope_org(org_b, async {
        store
            .create_draft(draft(
                actor_b,
                branch_b,
                vec![
                    line("7000", DebitCredit::Debit, 3_000),
                    line("8000", DebitCredit::Credit, 3_000),
                ],
                None,
            ))
            .await
            .unwrap()
            .id
    })
    .await;

    // Under org A's armed GUC, org B's voucher is NOT visible.
    mnt_platform_request_context::scope_org(org_a, async {
        assert!(store.get(a_id).await.is_ok(), "A sees its own voucher");
        assert!(
            store.get(b_id).await.is_err(),
            "A must not see B's voucher under RLS as mnt_rt"
        );
        // The account drill for B's account returns nothing under A's scope.
        let drill = store.account_drill("7000").await.unwrap();
        assert!(drill.is_empty(), "A must not drill B's account entries");
        // A's list only contains A's rows.
        let listed = store.list(None, None).await.unwrap();
        assert!(listed.iter().all(|v| v.id == a_id));
    })
    .await;

    // FAIL-CLOSED: with no tenant scope armed, every access errors.
    assert!(
        store.get(a_id).await.is_err(),
        "read with unset app.current_org must fail closed"
    );
    assert!(
        store.list(None, None).await.is_err(),
        "list with unset app.current_org must fail closed"
    );
}
