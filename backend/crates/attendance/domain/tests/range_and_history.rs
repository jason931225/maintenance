use mnt_attendance_domain::{AttendanceDateRange, HistoricalAbsence, SubstitutionWindow};
use time::{Date, Duration, Month};
use uuid::Uuid;

#[test]
fn selected_month_plus_d7_is_the_only_default_listing_window() {
    let range = AttendanceDateRange::selected_month_with_buffer("2026-07").unwrap();
    assert_eq!(range.from.to_string(), "2026-07-01");
    assert_eq!(range.to_exclusive.to_string(), "2026-08-08");
    assert!(AttendanceDateRange::new(range.from, range.to_exclusive + Duration::days(1)).is_err());
}

#[test]
fn historical_substitution_requires_full_same_day_coverage() {
    let date = Date::from_calendar_date(2026, Month::July, 2).unwrap();
    let window = SubstitutionWindow::new(date, 540, 1020).unwrap();
    assert!(
        HistoricalAbsence {
            employee_id: Uuid::new_v4(),
            work_date: date,
            covered_minutes: 480
        }
        .is_fully_covered(&window)
    );
    assert!(
        !HistoricalAbsence {
            employee_id: Uuid::new_v4(),
            work_date: date,
            covered_minutes: 1
        }
        .is_fully_covered(&window)
    );
}
