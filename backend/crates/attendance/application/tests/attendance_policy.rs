use mnt_attendance_application::{
    CallerScope, CloseChecks, IdempotencyDecision, ensure_scope, idempotency_decision,
};
use uuid::Uuid;

#[test]
fn branch_authority_cannot_be_widened_by_requested_branch() {
    let allowed = Uuid::new_v4();
    let caller = CallerScope {
        org_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        branch_ids: vec![allowed],
        org_wide: false,
    };
    assert!(ensure_scope(&caller, Some(allowed)).is_ok());
    assert!(ensure_scope(&caller, Some(Uuid::new_v4())).is_err());
}

#[test]
fn duplicate_assignment_is_only_a_replay_when_the_fingerprint_matches() {
    assert_eq!(
        idempotency_decision(Some("same"), "same"),
        IdempotencyDecision::Replay
    );
    assert_eq!(
        idempotency_decision(Some("same"), "changed"),
        IdempotencyDecision::Conflict
    );
}

#[test]
fn close_gate_rejects_open_exceptions() {
    assert!(
        !CloseChecks {
            open_exceptions: 1,
            pending_leave: 0,
            already_closed: false
        }
        .ready()
    );
    assert!(
        CloseChecks {
            open_exceptions: 0,
            pending_leave: 1,
            already_closed: false
        }
        .ready()
    );
}

#[test]
fn branch_limited_caller_cannot_omit_branch_or_read_another_branch() {
    let allowed = Uuid::new_v4();
    let other = Uuid::new_v4();
    let caller = CallerScope {
        org_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        branch_ids: vec![allowed],
        org_wide: false,
    };
    assert!(ensure_scope(&caller, None).is_err());
    assert!(ensure_scope(&caller, Some(allowed)).is_ok());
    assert!(ensure_scope(&caller, Some(other)).is_err());
}

#[test]
fn org_wide_caller_may_query_all_branches() {
    let caller = CallerScope {
        org_id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        branch_ids: vec![],
        org_wide: true,
    };
    assert!(ensure_scope(&caller, None).is_ok());
    assert!(ensure_scope(&caller, Some(Uuid::new_v4())).is_ok());
}
