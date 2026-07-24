use mnt_platform_db::PeriodLockDomain;
use sha2::{Digest, Sha256};

include!("canonical_migration_identities.generated.rs");

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

fn lowercase_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn canonical_migration_identity_is_exact() {
    let migrations = MIGRATOR.iter().collect::<Vec<_>>();
    assert_eq!(CANONICAL_SQLX_MIGRATION_IDENTITIES.len(), migrations.len());
    assert_eq!(168, migrations.len());

    for (index, (migration, (path, expected_sha256))) in migrations
        .iter()
        .zip(CANONICAL_SQLX_MIGRATION_IDENTITIES)
        .enumerate()
    {
        let version = i64::try_from(index + 1).expect("migration index fits i64");
        assert_eq!(
            version, migration.version,
            "non-contiguous version at {path}"
        );
        let expected_path = format!(
            "backend/crates/platform/db/migrations/{version:04}_{}.sql",
            migration.description.replace(' ', "_")
        );
        assert_eq!(
            &expected_path, path,
            "filename/description drift at version {version}"
        );
        assert_eq!(
            *expected_sha256,
            lowercase_hex(&Sha256::digest(migration.sql.as_str().as_bytes())),
            "content drift at {path}",
        );
    }

    for (migration, expected_sha384) in [
        (
            migrations[0],
            "3a0113a4ccfa33c60918f873847653d4a23ca6a8e526e2b7389e7138f7041823901b9fbefaffaae3a056da8878791ed8",
        ),
        (
            migrations[25],
            "98bbb40d53a0604798e5126d514a80000002b3887b9cb6ed4fe800be2fe02d0b8dbc4d756fa044c5ecced0de57b56892",
        ),
        (
            migrations[167],
            "f3bf7fd565fc32cac05b52e934546801ebb0fc08eba17428e139ed7b63d1887d9d807db556331a1c8dd845f2ce1b45a7",
        ),
    ] {
        assert_eq!(expected_sha384, lowercase_hex(&migration.checksum));
    }
}

#[test]
fn period_lock_domain_parser_is_exact_and_fail_closed() {
    assert_eq!(
        PeriodLockDomain::parse("payroll").expect("payroll must be supported"),
        PeriodLockDomain::Payroll,
    );
    assert_eq!(
        PeriodLockDomain::parse("accounting").expect("accounting must be supported"),
        PeriodLockDomain::Accounting,
    );
    assert!(PeriodLockDomain::parse("Payroll").is_err());
    assert!(PeriodLockDomain::parse("unknown").is_err());
}

#[sqlx::test]
async fn canonical_migrations_create_foundation_relations(pool: sqlx::PgPool) {
    MIGRATOR
        .run(&pool)
        .await
        .expect("the exact embedded canonical migration set must apply");

    let (regions, organizations, applied): (bool, bool, i64) = sqlx::query_as(
        "SELECT \
            to_regclass('public.regions') IS NOT NULL, \
            to_regclass('public.organizations') IS NOT NULL, \
            (SELECT count(*) FROM _sqlx_migrations WHERE success)",
    )
    .fetch_one(&pool)
    .await
    .expect("canonical migration relations and ledger must be queryable");

    assert!(regions, "migration 0001 must create public.regions");
    assert!(
        organizations,
        "migration 0026 must create public.organizations"
    );
    assert_eq!(168, applied, "every canonical migration must be applied");
}
