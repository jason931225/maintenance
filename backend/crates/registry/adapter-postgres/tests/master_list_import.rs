#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};

use mnt_registry_adapter_postgres::{PgRegistryStore, parse_master_list};
use sqlx::PgPool;

fn master_list_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../docs/reference/master-list_251120.xlsx")
}

#[test]
fn parser_self_checks_prefix_formulas_against_the_real_workbook() {
    let parsed = parse_master_list(master_list_path()).unwrap();

    assert_eq!(parsed.input_rows, 486);
    assert_eq!(parsed.equipment.len(), 445);
    assert!(parsed.errors.is_empty(), "{:#?}", parsed.errors);
    assert_eq!(parsed.prefix_checked_rows, 486);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn real_master_list_import_is_idempotent_queryable_and_audited(pool: PgPool) {
    let store = PgRegistryStore::new(pool.clone());

    let first = store.import_master_list(&master_list_path()).await.unwrap();
    assert_eq!(first.added, 445);
    assert_eq!(first.updated, 0);
    assert_eq!(first.unchanged, 0);
    assert_eq!(first.orphaned, 0);
    assert!(first.errors.is_empty(), "{:#?}", first.errors);

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM registry_equipment")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 445);

    let lookup = store.find_model_by_management_no("290").await.unwrap();
    assert_eq!(lookup.as_deref(), Some("GTS25DE"));

    let residual = store
        .residual_value_by_equipment_no("CFB18-0006")
        .await
        .unwrap();
    assert_eq!(residual, Some(-10_650_084));

    let second = store.import_master_list(&master_list_path()).await.unwrap();
    assert_eq!(second.added, 0);
    assert_eq!(second.updated, 0);
    assert_eq!(second.unchanged, 445);
    assert_eq!(second.orphaned, 0);
    assert!(second.errors.is_empty(), "{:#?}", second.errors);

    let audit_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = 'registry.import'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(audit_count, 2);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn modified_copy_reports_single_update(pool: PgPool) {
    let store = PgRegistryStore::new(pool.clone());
    store.import_master_list(&master_list_path()).await.unwrap();

    let modified = copy_master_list("registry-modified-copy.xlsx");
    rewrite_cell(
        &modified,
        "K&L 지게차 Master list",
        "Q291",
        "GTS25DE-UPDATED",
    );

    let report = store.import_master_list(&modified).await.unwrap();
    assert_eq!(report.added, 0);
    assert_eq!(report.updated, 1);
    assert_eq!(report.unchanged, 444);
    assert!(report.errors.is_empty(), "{:#?}", report.errors);

    let lookup = store.find_model_by_management_no("290").await.unwrap();
    assert_eq!(lookup.as_deref(), Some("GTS25DE-UPDATED"));
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn dirty_rows_are_reported_without_writing_the_failed_row(pool: PgPool) {
    let dirty = copy_master_list("registry-dirty-copy.xlsx");
    rewrite_cell(&dirty, "K&L 지게차 Master list", "F4", "");

    let store = PgRegistryStore::new(pool.clone());
    let report = store.import_master_list(&dirty).await.unwrap();

    assert_eq!(report.added, 444);
    assert_eq!(report.errors.len(), 1);
    assert_eq!(report.errors[0].sheet, "K&L 지게차 Master list");
    assert_eq!(report.errors[0].row, 4);

    let missing: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM registry_equipment WHERE equipment_no = 'CFB30-0001'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(missing, 0);
}

fn copy_master_list(filename: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "mnt-registry-test-{}-{}",
        std::process::id(),
        filename
    ));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).unwrap();
    }
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join(filename);
    std::fs::copy(master_list_path(), &target).unwrap();
    target
}

fn rewrite_cell(path: &Path, sheet: &str, cell: &str, value: &str) {
    let mut workbook = umya_spreadsheet::reader::xlsx::read(path).unwrap();
    workbook
        .sheet_by_name_mut(sheet)
        .expect("sheet should exist")
        .cell_mut(cell)
        .set_value(value);
    umya_spreadsheet::writer::xlsx::write(&workbook, path).unwrap();
}
