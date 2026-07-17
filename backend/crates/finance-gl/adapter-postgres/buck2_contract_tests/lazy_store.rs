use mnt_finance_gl_adapter_postgres::PgVoucherStore;
use sqlx::postgres::PgPoolOptions;

#[tokio::test]
async fn voucher_store_construction_is_lazy_and_does_not_require_a_database() {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://buck2:unused@127.0.0.1/never_connected")
        .expect("a syntactically valid lazy pool must be constructible offline");
    let store = PgVoucherStore::new(pool);
    assert!(!store.pool().is_closed());
}
