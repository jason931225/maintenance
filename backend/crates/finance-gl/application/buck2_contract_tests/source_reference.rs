use mnt_finance_gl_application::VoucherSourceRef;

#[test]
fn voucher_source_reference_preserves_canonical_object_identity() {
    let source = VoucherSourceRef {
        object_type: "approved_expense".to_owned(),
        object_id: "expense-2026-0042".to_owned(),
    };
    assert_eq!(source.object_type, "approved_expense");
    assert_eq!(source.object_id, "expense-2026-0042");
}
