#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS gate for the ontology registry read/write paths.
//!
//! Every registry mutation wraps `with_audit` (arms `app.current_org`) and every
//! read wraps `with_org_conn`. A static gate proves the wrapping is present in
//! source; THIS test proves it WORKS AT RUNTIME as the genuine non-owner
//! `mnt_rt` role (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) — the only faithful
//! exercise of the org_isolation policy. The default `#[sqlx::test]` pool is a
//! BYPASSRLS superuser that would green-light a totally broken policy.
//!
//! Proves, with two tenants A and B:
//!   (a) under org-A's armed GUC, A sees its own object type (list + get);
//!   (b) under org-A's armed GUC, B's object type is INVISIBLE (get → not found,
//!       list → zero B rows) — cross-tenant isolation holds under RLS as mnt_rt;
//!   (c) FAIL-CLOSED: with NO GUC armed the read errors (MissingOrg), never leaks;
//!   (d) the schema-lifecycle FSM advances draft → review_pending → published as
//!       mnt_rt, and a v+1 revision stages independently of the published head.

use mnt_kernel_core::{OrgId, TraceContext, UserId};
use mnt_ontology_adapter_postgres::{
    CreateObjectTypeDraft, LinkTypeInput, PgOntologyStore, PropertyDefInput,
};
use mnt_ontology_domain::{BackingKind, LinkCardinality, SchemaLifecycleState};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::macros::datetime;
use uuid::Uuid;

const ORG_B: Uuid = Uuid::from_u128(0x2222_2222_2222_2222_2222_2222_2222_2222);

/// Every connection becomes the genuine non-owner `mnt_rt` (BYPASSRLS does not
/// apply, FORCE RLS does). The migration itself grants mnt_rt the registry
/// privileges, so no manual GRANT is needed here.
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
    // Slug must match the organizations slug CHECK (no dots/underscores), so
    // derive a sanitized, per-org-unique slug rather than echoing the tag.
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

fn work_order_draft(stable_key: &str) -> CreateObjectTypeDraft {
    CreateObjectTypeDraft {
        stable_key: stable_key.to_owned(),
        title: "작업지시".to_owned(),
        title_property_key: Some("title".to_owned()),
        backing_kind: BackingKind::Instance,
        backing_table: None,
        primary_key_property: None,
        properties: vec![PropertyDefInput {
            key: "priority".to_owned(),
            title: "우선순위".to_owned(),
            field_type: "choice".to_owned(),
            config: serde_json::json!({"choices": [{"id": "hi", "name": "높음", "color": "red"}]}),
            backing_column: None,
            required: true,
            in_property_policy: false,
        }],
        links: vec![LinkTypeInput {
            stable_key: "assigned_to".to_owned(),
            title: "담당자".to_owned(),
            reverse_title: Some("담당 작업".to_owned()),
            to_object_type_id: None,
            cardinality: LinkCardinality::ManyMany,
            traversable: true,
        }],
        actions: Vec::new(),
        analytics: Vec::new(),
    }
}

/// Create a draft object type for `org` under the armed GUC (owner pool, so the
/// write succeeds; the GUC is armed exactly as the org middleware would).
async fn seed_object_type(owner_pool: &PgPool, org: OrgId, stable_key: &str) {
    let actor = seed_org_and_user(owner_pool, *org.as_uuid(), stable_key).await;
    mnt_platform_request_context::scope_org(org, async {
        let store = PgOntologyStore::new(owner_pool.clone());
        store
            .create_object_type(
                actor,
                work_order_draft(stable_key),
                TraceContext::generate(),
                datetime!(2026-07-09 12:00 UTC),
            )
            .await
            .expect("create_object_type must succeed under armed owner pool");
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn own_object_type_is_visible_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org_a = OrgId::knl();
    seed_object_type(&owner_pool, org_a, "wo.work_order").await;

    let (list, detail) = mnt_platform_request_context::scope_org(org_a, async {
        let store = PgOntologyStore::new(rt_pool.clone());
        let list = store.list_object_types().await.unwrap();
        let detail = store.get_object_type("wo.work_order", None).await.unwrap();
        (list, detail)
    })
    .await;

    assert_eq!(list.len(), 1, "org-A sees exactly its own object type");
    assert_eq!(list[0].stable_key, "wo.work_order");
    assert_eq!(list[0].lifecycle_state, SchemaLifecycleState::Draft);
    assert_eq!(detail.properties.len(), 1);
    assert_eq!(detail.properties[0].key, "priority");
    assert!(detail.properties[0].field_kind.is_known());
    // Reverse (back-)link name round-trips through create → read (change-log 74).
    assert_eq!(detail.links.len(), 1);
    assert_eq!(detail.links[0].stable_key, "assigned_to");
    assert_eq!(detail.links[0].reverse_title.as_deref(), Some("담당 작업"));
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn cross_tenant_object_type_is_invisible_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org_a = OrgId::knl();
    let org_b = OrgId::from_uuid(ORG_B);
    seed_object_type(&owner_pool, org_a, "wo.work_order").await;
    seed_object_type(&owner_pool, org_b, "wo.b_secret").await;

    let (list, cross) = mnt_platform_request_context::scope_org(org_a, async {
        let store = PgOntologyStore::new(rt_pool.clone());
        let list = store.list_object_types().await.unwrap();
        let cross = store.get_object_type("wo.b_secret", None).await;
        (list, cross)
    })
    .await;

    // A's list never contains B's rows.
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].stable_key, "wo.work_order");
    // B's type is not found under A's GUC (RLS isolates tenants as mnt_rt).
    assert!(
        cross.is_err(),
        "org-B's object type must be INVISIBLE under org-A's GUC as mnt_rt"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn registry_read_fails_closed_without_org_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    seed_object_type(&owner_pool, OrgId::knl(), "wo.work_order").await;

    // No scope_org wrapper: current_org() is unset, so the read must fail closed.
    let store = PgOntologyStore::new(rt_pool.clone());
    assert!(
        store.list_object_types().await.is_err(),
        "with no org armed the list must fail closed, never leak"
    );
    assert!(
        store.get_object_type("wo.work_order", None).await.is_err(),
        "with no org armed the get must fail closed, never leak"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn lifecycle_fsm_and_revision_staging_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org_a = OrgId::knl();
    let actor = seed_org_and_user(&owner_pool, *org_a.as_uuid(), "fsm").await;
    let at = datetime!(2026-07-09 12:00 UTC);

    mnt_platform_request_context::scope_org(org_a, async {
        let store = PgOntologyStore::new(rt_pool.clone());

        // Create v1 draft.
        let v1 = store
            .create_object_type(
                actor,
                work_order_draft("wo.fsm"),
                TraceContext::generate(),
                at,
            )
            .await
            .unwrap();
        assert_eq!(v1.schema_version, 1);
        assert_eq!(v1.lifecycle_state, SchemaLifecycleState::Draft);

        // Protection ON forbids the draft→published shortcut.
        let blocked = store
            .transition_lifecycle(
                actor,
                v1.id,
                SchemaLifecycleState::Published,
                true,
                TraceContext::generate(),
                at,
            )
            .await;
        assert!(
            blocked.is_err(),
            "direct draft→published must be forbidden under protection"
        );

        // The reviewed path publishes: draft → review_pending → published.
        store
            .transition_lifecycle(
                actor,
                v1.id,
                SchemaLifecycleState::ReviewPending,
                true,
                TraceContext::generate(),
                at,
            )
            .await
            .unwrap();
        let published = store
            .transition_lifecycle(
                actor,
                v1.id,
                SchemaLifecycleState::Published,
                true,
                TraceContext::generate(),
                at,
            )
            .await
            .unwrap();
        assert_eq!(published.lifecycle_state, SchemaLifecycleState::Published);

        // Stage a v+1 revision; the published head is untouched (immutable history).
        let v2 = store
            .stage_revision(
                actor,
                "wo.fsm",
                work_order_draft("wo.fsm"),
                TraceContext::generate(),
                at,
            )
            .await
            .unwrap();
        assert_eq!(v2.schema_version, 2);
        assert_eq!(v2.lifecycle_state, SchemaLifecycleState::Draft);

        // The head returned by get (no version) is still the published v1.
        let head = store.get_object_type("wo.fsm", None).await.unwrap();
        assert_eq!(head.object_type.schema_version, 1);
        assert_eq!(
            head.object_type.lifecycle_state,
            SchemaLifecycleState::Published
        );

        // Publishing v2 (protection OFF path) supersedes v1 atomically.
        store
            .transition_lifecycle(
                actor,
                v2.id,
                SchemaLifecycleState::Published,
                false,
                TraceContext::generate(),
                at,
            )
            .await
            .unwrap();
        let head2 = store.get_object_type("wo.fsm", None).await.unwrap();
        assert_eq!(head2.object_type.schema_version, 2);
        assert_eq!(
            head2.object_type.lifecycle_state,
            SchemaLifecycleState::Published
        );

        // v1 is now superseded, still fetchable as-of.
        let as_of_v1 = store.get_object_type("wo.fsm", Some(1)).await.unwrap();
        assert_eq!(
            as_of_v1.object_type.lifecycle_state,
            SchemaLifecycleState::Superseded
        );
    })
    .await;
}
