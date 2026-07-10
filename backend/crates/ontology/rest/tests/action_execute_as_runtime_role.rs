#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME proofs for the §2/§16 action execute path, exercised as the genuine
//! non-owner `mnt_rt` role (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) — the only
//! faithful exercise of RLS org-isolation. The default `#[sqlx::test]` pool is a
//! BYPASSRLS superuser that would green-light a broken policy.
//!
//! Proves:
//!   (a) execute happy-path appends a v1 revision + exactly one action audit row,
//!       atomically;
//!   (b) a failed gate (four-eyes required, no approval) ⇒ GateDenied AND zero
//!       rows written;
//!   (c) with the four-eyes approval present, the in-tx re-check admits and the
//!       revision commits (the TOCTOU re-check path is exercised on the DB);
//!   (d) a submission-criterion failure ⇒ CriteriaFailed AND zero rows;
//!   (e) a projected_usecase action ⇒ NotWiredYet AND zero rows (no domain write);
//!   (f) a cross-org action is invisible (NotFound) under another tenant's GUC.
//!
//! NOTE (migrations path): runs against the canonical
//! `../../platform/db/migrations` (the ship path). The earlier concurrent-lane
//! migration-number collision has been reconciled, so no deduplicated copy is
//! needed.

use std::collections::BTreeSet;

use mnt_governance_adapter_postgres::PgGovernanceStore;
use mnt_governance_application::{ApprovalDecision, DecideApprovalCommand};
use mnt_kernel_core::{BranchScope, OrgId, TraceContext, UserId};
use mnt_ontology_adapter_postgres::instances::PgInstanceStore;
use mnt_ontology_adapter_postgres::{
    ActionTypeInput, CreateObjectTypeDraft, PgOntologyStore, PropertyDefInput,
};
use mnt_ontology_domain::{ActionDispatch, BackingKind, ObjectTypeId};
use mnt_ontology_rest::{ActionCommand, ActionError, OntologyRestState};
use mnt_platform_authz::{Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::macros::datetime;
use uuid::Uuid;

const ORG_B: Uuid = Uuid::from_u128(0x4444_4444_4444_4444_4444_4444_4444_4444);
const AT: time::OffsetDateTime = datetime!(2026-07-10 12:00 UTC);

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

async fn seed_org_and_user(owner_pool: &PgPool, org: Uuid, tag: &str) -> UserId {
    let slug = format!("org-{}", &org.simple().to_string()[..12]);
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING")
        .bind(org)
        .bind(slug)
        .bind(format!("Org {tag}"))
        .execute(owner_pool)
        .await
        .unwrap();
    let user_id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("Admin {tag}"))
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .execute(owner_pool)
        .await
        .unwrap();
    user_id
}

fn super_admin(user_id: UserId, org: OrgId) -> Principal {
    Principal::new(
        user_id,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
}

fn state(pool: &PgPool) -> OntologyRestState {
    OntologyRestState::new(
        PgOntologyStore::new(pool.clone()),
        PgInstanceStore::new(pool.clone()),
        PgGovernanceStore::new(pool.clone()),
        None,
    )
}

/// Publish an instance-backed object type with one required `priority` choice
/// property and one action (`action_key`) that writes `priority` from a param.
async fn seed_instance_type_with_action(
    owner_pool: &PgPool,
    org: OrgId,
    actor: UserId,
    key: &str,
    action_key: &str,
    control_points: Value,
    submission_criteria: Value,
) -> ObjectTypeId {
    mnt_platform_request_context::scope_org(org, async {
        let store = PgOntologyStore::new(owner_pool.clone());
        let draft = CreateObjectTypeDraft {
            stable_key: key.to_owned(),
            title: "작업지시".to_owned(),
            title_property_key: Some("title".to_owned()),
            backing_kind: BackingKind::Instance,
            backing_table: None,
            primary_key_property: None,
            properties: vec![PropertyDefInput {
                key: "priority".to_owned(),
                title: "우선순위".to_owned(),
                field_type: "choice".to_owned(),
                config: json!({"choices": [{"id": "hi", "name": "높음"}, {"id": "lo", "name": "낮음"}]}),
                backing_column: None,
                required: true,
                in_property_policy: false,
            }],
            links: Vec::new(),
            actions: vec![ActionTypeInput {
                stable_key: action_key.to_owned(),
                title: "우선순위 설정".to_owned(),
                params_schema: json!({"priority": {"required": true}, "count": {}}),
                edits: json!([{"property": "priority", "param": "priority"}]),
                submission_criteria,
                side_effects: json!([]),
                dispatch: ActionDispatch::InstanceRevision,
                dispatch_target: None,
                control_points,
            }],
            analytics: Vec::new(),
        };
        store
            .create_object_type(actor, draft, TraceContext::generate(), AT)
            .await
            .expect("create object type")
            .id
    })
    .await
}

/// Publish a projected object type with a projected_usecase action.
async fn seed_projected_type_with_action(
    owner_pool: &PgPool,
    org: OrgId,
    actor: UserId,
    key: &str,
    action_key: &str,
) -> ObjectTypeId {
    mnt_platform_request_context::scope_org(org, async {
        let store = PgOntologyStore::new(owner_pool.clone());
        let draft = CreateObjectTypeDraft {
            stable_key: key.to_owned(),
            title: "장비".to_owned(),
            title_property_key: None,
            backing_kind: BackingKind::Projected,
            backing_table: Some("registry_equipment".to_owned()),
            primary_key_property: Some("id".to_owned()),
            properties: Vec::new(),
            links: Vec::new(),
            actions: vec![ActionTypeInput {
                stable_key: action_key.to_owned(),
                title: "장비 갱신".to_owned(),
                params_schema: json!({}),
                edits: json!([]),
                submission_criteria: json!([]),
                side_effects: json!([]),
                dispatch: ActionDispatch::ProjectedUsecase,
                dispatch_target: Some("registry.update_equipment".to_owned()),
                control_points: json!(["authority"]),
            }],
            analytics: Vec::new(),
        };
        store
            .create_object_type(actor, draft, TraceContext::generate(), AT)
            .await
            .expect("create projected object type")
            .id
    })
    .await
}

async fn count_instances(owner_pool: &PgPool, org: OrgId) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM ont_instances WHERE org_id = $1")
        .bind(*org.as_uuid())
        .fetch_one(owner_pool)
        .await
        .unwrap()
}

async fn count_execute_audits(owner_pool: &PgPool, org: OrgId) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND action = 'ontology.action.execute'",
    )
    .bind(*org.as_uuid())
    .fetch_one(owner_pool)
    .await
    .unwrap()
}

fn create_command(object_type_id: ObjectTypeId, priority: &str) -> ActionCommand {
    ActionCommand {
        object_type_id,
        instance_id: None,
        title: Some("WO-1".to_owned()),
        params: json!({"priority": priority, "count": 5}),
        reason: Some("via action".to_owned()),
        valid_from: Some(AT),
        checklist_all_acknowledged: None,
        four_eyes_request_ref: None,
    }
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn execute_happy_path_appends_revision_and_one_audit_atomically(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let actor = seed_org_and_user(&owner_pool, *org.as_uuid(), "a").await;
    let type_id = seed_instance_type_with_action(
        &owner_pool,
        org,
        actor,
        "wo.exec",
        "set_priority",
        json!(["authority"]),
        json!([]),
    )
    .await;

    let outcome = mnt_platform_request_context::scope_org(org, async {
        state(&rt)
            .execute_action(
                &super_admin(actor, org),
                "set_priority",
                create_command(type_id, "hi"),
            )
            .await
    })
    .await
    .expect("execute must succeed");

    assert!(outcome.gates.allow);
    assert_eq!(outcome.instance.revision.version, 1);
    assert_eq!(outcome.instance.revision.attributes["priority"], "hi");
    assert_eq!(
        count_instances(&owner_pool, org).await,
        1,
        "exactly one instance was created"
    );
    assert_eq!(
        count_execute_audits(&owner_pool, org).await,
        1,
        "exactly one action-execute audit row landed in the same tx"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn missing_four_eyes_denies_and_writes_zero_rows(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let actor = seed_org_and_user(&owner_pool, *org.as_uuid(), "a").await;
    let type_id = seed_instance_type_with_action(
        &owner_pool,
        org,
        actor,
        "wo.foureyes",
        "set_priority",
        json!(["authority", "four_eyes"]),
        json!([]),
    )
    .await;

    let err = mnt_platform_request_context::scope_org(org, async {
        state(&rt)
            .execute_action(
                &super_admin(actor, org),
                "set_priority",
                create_command(type_id, "hi"), // four_eyes_request_ref: None
            )
            .await
    })
    .await
    .expect_err("a required-but-unapproved four-eyes gate must deny");
    assert!(matches!(err, ActionError::GateDenied(_)), "got {err:?}");
    assert_eq!(
        count_instances(&owner_pool, org).await,
        0,
        "a denied gate must write zero rows"
    );

    // (c) Now record an approved four-eyes decision and pass its ref: the in-tx
    // re-check reads it and the revision commits.
    let request_ref = Uuid::new_v4();
    let approver = seed_org_and_user(&owner_pool, *org.as_uuid(), "b").await;
    mnt_platform_request_context::scope_org(org, async {
        PgGovernanceStore::new(rt.clone())
            .decide_approval(DecideApprovalCommand {
                approver,
                request_ref,
                kind: "ontology.action".to_owned(),
                requested_by: actor,
                decision: ApprovalDecision::Approved,
                trace: TraceContext::generate(),
                occurred_at: AT,
            })
            .await
            .expect("record four-eyes approval");
    })
    .await;

    let mut approved = create_command(type_id, "hi");
    approved.four_eyes_request_ref = Some(request_ref);
    let outcome = mnt_platform_request_context::scope_org(org, async {
        state(&rt)
            .execute_action(&super_admin(actor, org), "set_priority", approved)
            .await
    })
    .await
    .expect("an approved four-eyes gate must admit the writeback (in-tx re-check)");
    assert!(outcome.gates.allow);
    assert_eq!(count_instances(&owner_pool, org).await, 1);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn submission_criteria_failure_denies_with_zero_rows(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let actor = seed_org_and_user(&owner_pool, *org.as_uuid(), "a").await;
    // Require count >= 10, but the command supplies count = 5.
    let type_id = seed_instance_type_with_action(
        &owner_pool,
        org,
        actor,
        "wo.crit",
        "set_priority",
        json!(["authority"]),
        json!([{"field": "count", "op": "gte", "value": 10}]),
    )
    .await;

    let err = mnt_platform_request_context::scope_org(org, async {
        state(&rt)
            .execute_action(
                &super_admin(actor, org),
                "set_priority",
                create_command(type_id, "hi"),
            )
            .await
    })
    .await
    .expect_err("a failed submission criterion must deny");
    assert!(matches!(err, ActionError::CriteriaFailed(_)), "got {err:?}");
    assert_eq!(count_instances(&owner_pool, org).await, 0);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn projected_dispatch_is_not_wired_yet_and_writes_nothing(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let actor = seed_org_and_user(&owner_pool, *org.as_uuid(), "a").await;
    let type_id =
        seed_projected_type_with_action(&owner_pool, org, actor, "equip.proj", "update_equipment")
            .await;

    let err = mnt_platform_request_context::scope_org(org, async {
        state(&rt)
            .execute_action(
                &super_admin(actor, org),
                "update_equipment",
                ActionCommand {
                    object_type_id: type_id,
                    instance_id: None,
                    title: None,
                    params: json!({}),
                    reason: None,
                    valid_from: Some(AT),
                    checklist_all_acknowledged: None,
                    four_eyes_request_ref: None,
                },
            )
            .await
    })
    .await
    .expect_err("projected dispatch is a v1 stub");
    match err {
        ActionError::NotWiredYet { target } => {
            assert_eq!(target.as_deref(), Some("registry.update_equipment"));
        }
        other => panic!("expected NotWiredYet, got {other:?}"),
    }
    assert_eq!(
        count_instances(&owner_pool, org).await,
        0,
        "a not-wired projected dispatch must write nothing"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn cross_org_action_is_invisible(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let org_a = OrgId::knl();
    let org_b = OrgId::from_uuid(ORG_B);
    let actor_a = seed_org_and_user(&owner_pool, *org_a.as_uuid(), "a").await;
    let actor_b = seed_org_and_user(&owner_pool, *org_b.as_uuid(), "b").await;
    let type_a = seed_instance_type_with_action(
        &owner_pool,
        org_a,
        actor_a,
        "wo.a",
        "set_priority",
        json!(["authority"]),
        json!([]),
    )
    .await;

    // Under org-B's GUC, org-A's action type does not resolve → NotFound.
    let err = mnt_platform_request_context::scope_org(org_b, async {
        state(&rt)
            .execute_action(
                &super_admin(actor_b, org_b),
                "set_priority",
                create_command(type_a, "hi"),
            )
            .await
    })
    .await
    .expect_err("org-A's action must be invisible to org-B");
    assert!(matches!(err, ActionError::NotFound), "got {err:?}");
    assert_eq!(count_instances(&owner_pool, org_b).await, 0);
}
