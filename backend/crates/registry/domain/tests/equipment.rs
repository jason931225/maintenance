#![allow(clippy::unwrap_used)]

use mnt_registry_domain::{EquipmentNo, EquipmentStatus, MoneyWon, Ton};

#[test]
fn equipment_no_derives_the_same_mid_formula_columns_as_the_workbook() {
    let equipment_no = EquipmentNo::parse("CFO25-0290").unwrap();

    assert_eq!(equipment_no.manufacturer_code(), "C");
    assert_eq!(equipment_no.kind_code(), "F");
    assert_eq!(equipment_no.power_code(), "O");
    assert_eq!(equipment_no.sequence_code(), "290");
}

#[test]
fn equipment_no_rejects_values_that_cannot_produce_prefix_columns() {
    let err = EquipmentNo::parse("CF-290").unwrap_err();

    assert!(err.message.contains("equipment number"));
}

#[test]
fn equipment_status_covers_actual_master_list_values() {
    for status in ["임대", "예비", "폐기", "대체", "매각"] {
        assert!(
            EquipmentStatus::parse(status).is_ok(),
            "{status} should parse"
        );
    }

    assert!(EquipmentStatus::parse("상태").is_err());
}

#[test]
fn money_won_allows_negative_residual_values() {
    let residual = MoneyWon::new(-10_650_084);

    assert_eq!(residual.amount(), -10_650_084);
}

#[test]
fn ton_keeps_original_text_and_derives_milli_tons_when_numeric() {
    let numeric = Ton::parse("2.5T");
    assert_eq!(numeric.as_text(), "2.5T");
    assert_eq!(numeric.milli_tons(), Some(2500));

    let undecided = Ton::parse("미정");
    assert_eq!(undecided.as_text(), "미정");
    assert_eq!(undecided.milli_tons(), None);
}
