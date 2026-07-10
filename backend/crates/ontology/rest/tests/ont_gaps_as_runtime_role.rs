#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME proofs for the Phase-C ontology gap endpoints, exercised as the
//! genuine non-owner `mnt_rt` role (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) — the
//! only faithful exercise of RLS org-isolation.
//!
//! Proves:
//!   * lifecycle commit: a configured edge commits (state advances + audit row);
//!     an UNCONFIGURED edge is fail-closed (GateDenied, zero state change); an
//!     illegal base-FSM edge is rejected;
//!   * acting-read: the workflow bound to the type key + the attached object
//!     policy both surface;
//!   * code→instance resolve: another tenant's code resolves to `None` (the
//!     handler renders 404 — no existence leak).
//!
//! NOTE (migrations path): runs against the canonical
//! `../../platform/db/migrations` (the ship path). The earlier concurrent-lane
//! migration-number collision has been reconciled, so no deduplicated copy is
//! needed.

use std::collections::BTreeSet;

use mnt_governance_adapter_postgres::PgGovernanceStore;
use mnt_governance_application::ConfigureTransitionCommand;
use mnt_governance_domain::{LifecycleState, TransitionRequirements};
use mnt_kernel_core::{BranchScope, OrgId, TraceContext, UserId};
use mnt_ontology_adapter_postgres::instances::{CreateInstance, InstanceState, PgInstanceStore};
use mnt_ontology_adapter_postgres::{
    ActingKind, CreateObjectTypeDraft, PgOntologyStore, PropertyDefInput,
};
use mnt_ontology_domain::{BackingKind, InstanceLifecycleState, ObjectTypeId};
use mnt_ontology_rest::{ActionError, LifecycleCommand, OntologyRestState};
use mnt_platform_authz::{Principal, Role};
use mnt_platform_request_context::scope_org;
use serde_json::json;
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

/// Publish an instance-backed object type with a single optional `code` property
/// (dot-free stable_key so a workflow definition can bind to it).
async fn seed_type(owner_pool: &PgPool, org: OrgId, actor: UserId, key: &str) -> ObjectTypeId {
    scope_org(org, async {
        let store = PgOntologyStore::new(owner_pool.clone());
        let draft = CreateObjectTypeDraft {
            stable_key: key.to_owned(),
            title: "작업지시".to_owned(),
            title_property_key: None,
            backing_kind: BackingKind::Instance,
            backing_table: None,
            primary_key_property: None,
            properties: vec![PropertyDefInput {
                key: "code".to_owned(),
                title: "코드".to_owned(),
                field_type: "text".to_owned(),
                config: json!({}),
                backing_column: None,
                required: false,
                in_property_policy: false,
            }],
            links: Vec::new(),
            actions: Vec::new(),
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

async fn seed_instance(
    owner_pool: &PgPool,
    org: OrgId,
    actor: UserId,
    type_id: ObjectTypeId,
    code: &str,
) -> InstanceState {
    scope_org(org, async {
        PgInstanceStore::new(owner_pool.clone())
            .create_instance(
                actor,
                CreateInstance {
                    object_type_id: type_id,
                    title: format!("WO {code}"),
                    attributes: json!({ "code": code }),
                    valid_from: Some(AT),
                    action_type_id: None,
                    reason: None,
                },
                TraceContext::generate(),
                AT,
            )
            .await
            .expect("create instance")
    })
    .await
}

async fn configure_edge(
    owner_pool: &PgPool,
    org: OrgId,
    actor: UserId,
    type_id: ObjectTypeId,
    from: LifecycleState,
    to: LifecycleState,
) {
    scope_org(org, async {
        PgGovernanceStore::new(owner_pool.clone())
            .configure_transition(ConfigureTransitionCommand {
                actor,
                object_type_id: *type_id.as_uuid(),
                from_state: from,
                to_state: to,
                requirements: TransitionRequirements {
                    requires_reason: false,
                    requires_four_eyes: false,
                    requires_checklist: false,
                },
                trace: TraceContext::generate(),
                occurred_at: AT,
            })
            .await
            .expect("configure lifecycle edge");
    })
    .await
}

async fn lifecycle_state(owner_pool: &PgPool, instance_id: Uuid) -> String {
    sqlx::query_scalar("SELECT lifecycle_state FROM ont_instances WHERE id = $1")
        .bind(instance_id)
        .fetch_one(owner_pool)
        .await
        .unwrap()
}

// ---- Gap 1: lifecycle commit -------------------------------------------------

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn configured_edge_commits_and_unconfigured_is_fail_closed(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let actor = seed_org_and_user(&owner_pool, *org.as_uuid(), "a").await;
    let type_id = seed_type(&owner_pool, org, actor, "workorder").await;
    let instance = seed_instance(&owner_pool, org, actor, type_id, "WO-1").await;
    let instance_id = *instance.instance.id.as_uuid();
    // Only draft→active is configured.
    configure_edge(
        &owner_pool,
        org,
        actor,
        type_id,
        LifecycleState::Draft,
        LifecycleState::Active,
    )
    .await;

    // Configured edge commits: state advances to active.
    let outcome = scope_org(org, async {
        state(&rt)
            .commit_lifecycle(
                &super_admin(actor, org),
                instance.instance.id,
                LifecycleCommand {
                    to_state: InstanceLifecycleState::Active,
                    reason: None,
                    checklist_all_acknowledged: None,
                    four_eyes_request_ref: None,
                },
            )
            .await
    })
    .await
    .expect("configured draft→active must commit");
    assert_eq!(
        outcome.instance.lifecycle_state,
        InstanceLifecycleState::Active
    );
    assert_eq!(lifecycle_state(&owner_pool, instance_id).await, "active");

    // Unconfigured edge (active→locked) is fail-closed: GateDenied, no state change.
    let err = scope_org(org, async {
        state(&rt)
            .commit_lifecycle(
                &super_admin(actor, org),
                instance.instance.id,
                LifecycleCommand {
                    to_state: InstanceLifecycleState::Locked,
                    reason: None,
                    checklist_all_acknowledged: None,
                    four_eyes_request_ref: None,
                },
            )
            .await
    })
    .await
    .expect_err("an unconfigured edge must be denied");
    assert!(matches!(err, ActionError::GateDenied(_)), "got {err:?}");
    assert_eq!(
        lifecycle_state(&owner_pool, instance_id).await,
        "active",
        "a denied transition must not change state"
    );

    // Illegal base-FSM edge (active→draft) is rejected before config even matters.
    let err = scope_org(org, async {
        state(&rt)
            .commit_lifecycle(
                &super_admin(actor, org),
                instance.instance.id,
                LifecycleCommand {
                    to_state: InstanceLifecycleState::Draft,
                    reason: None,
                    checklist_all_acknowledged: None,
                    four_eyes_request_ref: None,
                },
            )
            .await
    })
    .await
    .expect_err("an illegal base-FSM edge must be rejected");
    assert!(matches!(err, ActionError::Store(_)), "got {err:?}");
}

// ---- Gap 2: acting-read ------------------------------------------------------

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn acting_surfaces_workflow_and_object_policy(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    let actor = seed_org_and_user(&owner_pool, org_uuid, "a").await;
    let type_id = seed_type(&owner_pool, org, actor, "workorder").await;
    let instance = seed_instance(&owner_pool, org, actor, type_id, "WO-1").await;

    // A workflow definition bound to the type key (automation).
    sqlx::query(
        r#"
        INSERT INTO workflow_definitions (org_id, workflow_key, display_name, object_type, status)
        VALUES ($1, 'wf.wo.review', 'WO Review', 'workorder', 'ACTIVE')
        "#,
    )
    .bind(org_uuid)
    .execute(&owner_pool)
    .await
    .unwrap();

    // A catalog policy attached to the type as an object policy (policy).
    let cedar_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO cedar_policy_catalog_entries
            (org_id, stable_key, title, natural_language_rule, effect, status, source,
             principal, action, resource, conditions, validation_status, generated_policy_text)
        VALUES ($1, 'pbac.wo_edit', 'WO Edit', 'authored in test', 'permit', 'draft', 'no_code_draft',
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 'valid', 'permit(principal,action,resource);')
        RETURNING id
        "#,
    )
    .bind(org_uuid)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO ont_object_policies (org_id, object_type_id, cedar_policy_id, effect) VALUES ($1, $2, $3, 'permit')",
    )
    .bind(org_uuid)
    .bind(*type_id.as_uuid())
    .bind(cedar_id)
    .execute(&owner_pool)
    .await
    .unwrap();

    let acting = scope_org(org, async {
        PgOntologyStore::new(rt.clone())
            .acting_on_instance(*instance.instance.id.as_uuid())
            .await
    })
    .await
    .expect("acting read");

    assert!(
        acting
            .iter()
            .any(|r| r.kind == ActingKind::Automation && r.label == "WO Review"),
        "the bound workflow must surface: {acting:?}"
    );
    assert!(
        acting
            .iter()
            .any(|r| r.kind == ActingKind::Policy && r.label == "WO Edit"),
        "the attached object policy must surface: {acting:?}"
    );
}

// ---- Gap 3: code→instance resolve (deny-by-omission) -------------------------

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn resolve_is_rls_scoped_and_denies_by_omission(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let org_a = OrgId::knl();
    let org_b = OrgId::from_uuid(ORG_B);
    let actor_a = seed_org_and_user(&owner_pool, *org_a.as_uuid(), "a").await;
    let actor_b = seed_org_and_user(&owner_pool, *org_b.as_uuid(), "b").await;
    let type_a = seed_type(&owner_pool, org_a, actor_a, "workorder").await;
    let _ = seed_instance(&owner_pool, org_a, actor_a, type_a, "WO-77").await;
    let _ = seed_type(&owner_pool, org_b, actor_b, "workorder").await;

    // Under org A, the code resolves.
    let found = scope_org(org_a, async {
        PgOntologyStore::new(rt.clone())
            .resolve_by_code("WO-77")
            .await
    })
    .await
    .expect("resolve query")
    .expect("org A resolves its own code");
    assert_eq!(found.type_key, "workorder");
    assert_eq!(found.title, "WO WO-77");

    // Under org B's GUC, org A's code is invisible ⇒ None ⇒ 404 (no existence leak).
    let cross = scope_org(org_b, async {
        PgOntologyStore::new(rt.clone())
            .resolve_by_code("WO-77")
            .await
    })
    .await
    .expect("resolve query");
    assert!(cross.is_none(), "another tenant's code must not resolve");

    // An unknown code is likewise None.
    let missing = scope_org(org_a, async {
        PgOntologyStore::new(rt.clone())
            .resolve_by_code("NOPE-0")
            .await
    })
    .await
    .expect("resolve query");
    assert!(missing.is_none(), "an unknown code must not resolve");
}
