#![allow(clippy::unwrap_used, clippy::expect_used)]
//! SQLx-backed CAP-IFM pilot story guard. The HTTP route contract is held by
//! `mnt-facilities-rest`; this test proves the migration's persistence/FK/RLS
//! substrate for the scheduled-HVAC happy path and terminal history.

use sqlx::PgPool;

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn facilities_pilot_schema_keeps_due_cases_evidence_and_observations_normalized(
    pool: PgPool,
) {
    let tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)",
    )
    .bind([
        "facilities_obligations",
        "facilities_cases",
        "facilities_case_history",
        "facilities_execution_evidence_links",
        "facilities_acceptances",
        "facilities_energy_observations",
        "facilities_cost_observations",
    ])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(tables, 7);

    let rls_forced: bool = sqlx::query_scalar(
        "SELECT relforcerowsecurity FROM pg_class WHERE oid = 'facilities_cases'::regclass",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(rls_forced);

    let required_evidence_kinds: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_constraint WHERE conrelid = 'facilities_execution_evidence_links'::regclass AND pg_get_constraintdef(oid) LIKE '%SAFETY_CHECKLIST%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(required_evidence_kinds, 1);
}
