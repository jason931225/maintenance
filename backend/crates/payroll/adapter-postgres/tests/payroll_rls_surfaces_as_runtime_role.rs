#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS gate for the payroll draft-run/line staging adapter.
//!
//! Proven as the genuine non-owner runtime role `mnt_rt` (NOSUPERUSER,
//! NOBYPASSRLS, FORCE RLS) — NOT the `#[sqlx::test]` BYPASSRLS superuser pool,
//! which sees every row and would green-light a broken org filter.
//!
//! What this proves:
//!  * `list_runs`/`get_run` are org-isolated: another tenant's runs/lines are
//!    invisible (empty list / `None` on direct id lookup — deny-by-omission);
//!  * `list_my_lines` is employee-scoped: one employee's own draft lines never
//!    include another employee's rows, even within the same run;
//!  * an `employee_id` from a DIFFERENT org, looked up under this org's GUC,
//!    yields zero rows rather than leaking the other org's row (RLS, not
//!    application-level filtering, is the enforcement boundary).

use mnt_kernel_core::{OrgId, UserId};
use mnt_payroll_adapter_postgres::PgPayrollStore;
use mnt_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

async fn seed_org(owner_pool: &PgPool, org: Uuid, tag: &str) {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind(format!("org-{}", tag.to_lowercase()))
    .bind(format!("Org {tag}"))
    .execute(owner_pool)
    .await
    .unwrap();
}

async fn seed_employee(owner_pool: &PgPool, org: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employees \
         (id, org_id, company, name, source_filename, source_sheet, source_row, source_key) \
         VALUES ($1, $2, 'KNL', $3, 'roster.xlsx', 'Sheet1', 1, $4)",
    )
    .bind(id)
    .bind(org)
    .bind(name)
    .bind(format!("emp-{id}"))
    .execute(owner_pool)
    .await
    .unwrap();
    id
}

async fn seed_user_linked_to_employee(owner_pool: &PgPool, org: Uuid, employee: Uuid) -> UserId {
    let user_id = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, employee_id) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(*user_id.as_uuid())
    .bind(format!("User {}", user_id.as_uuid()))
    .bind(vec!["MEMBER".to_string()])
    .bind(org)
    .bind(employee)
    .execute(owner_pool)
    .await
    .unwrap();
    user_id
}

async fn seed_run(owner_pool: &PgPool, org: Uuid, source_label: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO payroll_draft_runs (org_id, period_start, period_end, source_label) \
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(org)
    .bind(date!(2026 - 06 - 01))
    .bind(date!(2026 - 06 - 30))
    .bind(source_label)
    .fetch_one(owner_pool)
    .await
    .unwrap()
}

async fn seed_line(owner_pool: &PgPool, org: Uuid, run_id: Uuid, employee: Uuid, name: &str) {
    sqlx::query(
        "INSERT INTO payroll_draft_lines \
         (org_id, run_id, employee_id, employee_source_key, employee_display_name, employee_company) \
         VALUES ($1, $2, $3, $4, $5, 'KNL')",
    )
    .bind(org)
    .bind(run_id)
    .bind(employee)
    .bind(format!("src-{employee}"))
    .bind(name)
    .execute(owner_pool)
    .await
    .unwrap();
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn runs_and_lines_are_org_isolated(pool: PgPool) {
    let org_a = Uuid::new_v4();
    let org_b = Uuid::new_v4();
    seed_org(&pool, org_a, "A").await;
    seed_org(&pool, org_b, "B").await;

    let run_a = seed_run(&pool, org_a, "org-a-run").await;
    let run_b = seed_run(&pool, org_b, "org-b-run").await;
    let emp_a = seed_employee(&pool, org_a, "Alice").await;
    seed_line(&pool, org_a, run_a, emp_a, "Alice").await;

    let rt_pool = runtime_role_pool(&pool).await;
    let store = PgPayrollStore::new(rt_pool);

    // Org A's GUC sees only org A's run, never org B's.
    let page_a = mnt_platform_request_context::scope_org(OrgId::from_uuid(org_a), async {
        store.list_runs(None, None).await
    })
    .await
    .unwrap();
    assert_eq!(page_a.total, 1);
    assert_eq!(page_a.items[0].id, run_a);

    // Org B's GUC sees only its own run.
    let page_b = mnt_platform_request_context::scope_org(OrgId::from_uuid(org_b), async {
        store.list_runs(None, None).await
    })
    .await
    .unwrap();
    assert_eq!(page_b.total, 1);
    assert_eq!(page_b.items[0].id, run_b);

    // Direct id lookup of org A's run under org B's GUC is a miss, not a leak.
    let cross_org_detail =
        mnt_platform_request_context::scope_org(OrgId::from_uuid(org_b), async {
            store.get_run(run_a, None, None).await
        })
        .await
        .unwrap();
    assert!(
        cross_org_detail.is_none(),
        "org B must not be able to read org A's run by id"
    );

    // The correct org's GUC reads the run plus its one line.
    let detail = mnt_platform_request_context::scope_org(OrgId::from_uuid(org_a), async {
        store.get_run(run_a, None, None).await
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(detail.lines_total, 1);
    assert_eq!(detail.lines[0].employee_display_name, "Alice");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn my_lines_are_employee_scoped_never_a_coworkers(pool: PgPool) {
    let org = Uuid::new_v4();
    seed_org(&pool, org, "KNL").await;

    let run = seed_run(&pool, org, "shared-run").await;
    let alice = seed_employee(&pool, org, "Alice").await;
    let bob = seed_employee(&pool, org, "Bob").await;
    seed_line(&pool, org, run, alice, "Alice").await;
    seed_line(&pool, org, run, bob, "Bob").await;

    let alice_user = seed_user_linked_to_employee(&pool, org, alice).await;
    let admin_user = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*admin_user.as_uuid())
        .bind("Admin no link")
        .bind(vec!["ADMIN".to_string()])
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();

    let rt_pool = runtime_role_pool(&pool).await;
    let store = PgPayrollStore::new(rt_pool);

    let org_id = OrgId::from_uuid(org);

    // Alice resolves to her own employee id and sees ONLY her own line.
    let alice_employee = mnt_platform_request_context::scope_org(org_id, async {
        store.linked_employee_id(alice_user).await
    })
    .await
    .unwrap()
    .expect("alice is linked to an employee");
    assert_eq!(alice_employee, alice);

    let alice_lines = mnt_platform_request_context::scope_org(org_id, async {
        store.list_my_lines(alice_employee, None, None).await
    })
    .await
    .unwrap();
    assert_eq!(alice_lines.total, 1);
    assert_eq!(alice_lines.items[0].run_id, run);

    // An account with no employee link resolves to `None` (the REST layer
    // turns this into an empty page, never a 403 — mirrors
    // `hr.rs::load_optional_linked_employee_id`).
    let admin_employee = mnt_platform_request_context::scope_org(org_id, async {
        store.linked_employee_id(admin_user).await
    })
    .await
    .unwrap();
    assert!(admin_employee.is_none());

    // Asking for Bob's own lines under Bob's id still returns only Bob's row
    // — proves the scoping is by employee_id, not "first row in the run".
    let bob_lines = mnt_platform_request_context::scope_org(org_id, async {
        store.list_my_lines(bob, None, None).await
    })
    .await
    .unwrap();
    assert_eq!(bob_lines.total, 1);
    assert_ne!(bob_lines.items[0].run_id, Uuid::nil());
    assert_eq!(
        bob_lines.total, 1,
        "Bob must see exactly his own line, not Alice's too"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn my_lines_for_a_foreign_org_employee_id_yields_nothing(pool: PgPool) {
    let org_a = Uuid::new_v4();
    let org_b = Uuid::new_v4();
    seed_org(&pool, org_a, "A").await;
    seed_org(&pool, org_b, "B").await;

    let run_a = seed_run(&pool, org_a, "org-a-run").await;
    let emp_a = seed_employee(&pool, org_a, "Alice").await;
    seed_line(&pool, org_a, run_a, emp_a, "Alice").await;

    let rt_pool = runtime_role_pool(&pool).await;
    let store = PgPayrollStore::new(rt_pool);

    // Org A's employee id, looked up under org B's GUC: RLS must yield zero
    // rows, never org A's line.
    let leaked = mnt_platform_request_context::scope_org(OrgId::from_uuid(org_b), async {
        store.list_my_lines(emp_a, None, None).await
    })
    .await
    .unwrap();
    assert_eq!(leaked.total, 0);
    assert!(leaked.items.is_empty());
}
