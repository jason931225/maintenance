#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_kernel_core::{ErrorKind, OrgId, TraceContext, UserId};
use mnt_ontology_adapter_postgres::{
    CreateObjectTypeDraft, ObjectTypeSummary, PgOntologyError, PgOntologyStore, PropertyDefInput,
};
use mnt_ontology_domain::{BackingKind, SchemaLifecycleState};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use time::macros::datetime;
use uuid::Uuid;

const ORG_B: Uuid = Uuid::from_u128(0x3333_3333_3333_3333_3333_3333_3333_3333);

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
    let slug = format!("cas-{}", &org.simple().to_string()[..12]);
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind(slug)
    .bind(format!("CAS {tag}"))
    .execute(owner_pool)
    .await
    .unwrap();
    let user = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user.as_uuid())
        .bind(format!("CAS {tag}"))
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .execute(owner_pool)
        .await
        .unwrap();
    user
}

fn draft(key: &str, title: &str) -> CreateObjectTypeDraft {
    CreateObjectTypeDraft {
        stable_key: key.to_owned(),
        title: title.to_owned(),
        title_property_key: None,
        backing_kind: BackingKind::Instance,
        backing_table: None,
        primary_key_property: None,
        properties: vec![PropertyDefInput {
            key: "name".to_owned(),
            title: "Name".to_owned(),
            field_type: "text".to_owned(),
            config: serde_json::json!({}),
            backing_column: None,
            required: true,
            in_property_policy: false,
        }],
        links: Vec::new(),
        actions: Vec::new(),
        analytics: Vec::new(),
    }
}

async fn create(
    store: &PgOntologyStore,
    actor: UserId,
    key: &str,
    title: &str,
) -> ObjectTypeSummary {
    store
        .create_object_type(
            actor,
            draft(key, title),
            TraceContext::generate(),
            datetime!(2026-07-19 12:00 UTC),
        )
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn key_revision_is_tenant_scoped_and_advances_once_for_stage_and_publish(owner_pool: PgPool) {
    let org_a = OrgId::knl();
    let org_b = OrgId::from_uuid(ORG_B);
    let actor_a = seed_org_and_user(&owner_pool, *org_a.as_uuid(), "a").await;
    let actor_b = seed_org_and_user(&owner_pool, ORG_B, "b").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let key = "cas.shared_key";

    let a_v1 = mnt_platform_request_context::scope_org(org_a, async {
        create(&PgOntologyStore::new(rt_pool.clone()), actor_a, key, "A v1").await
    })
    .await;
    let b_v1 = mnt_platform_request_context::scope_org(org_b, async {
        create(&PgOntologyStore::new(rt_pool.clone()), actor_b, key, "B v1").await
    })
    .await;

    assert_eq!(a_v1.key_write_revision, 1);
    assert_eq!(b_v1.key_write_revision, 1);
    assert_ne!(a_v1.key_write_etag, b_v1.key_write_etag);
    assert!(a_v1.key_write_etag.starts_with('"'));
    assert!(a_v1.key_write_etag.ends_with('"'));
    assert!(!a_v1.key_write_etag.starts_with("W/"));

    let stale_cross_tenant = mnt_platform_request_context::scope_org(org_a, async {
        PgOntologyStore::new(rt_pool.clone())
            .stage_revision(
                actor_a,
                key,
                b_v1.write_precondition(),
                draft(key, "must not write"),
                TraceContext::generate(),
                datetime!(2026-07-19 12:01 UTC),
            )
            .await
    })
    .await;
    assert!(matches!(
        stale_cross_tenant,
        Err(PgOntologyError::PreconditionFailed { ref current })
            if current.revision == 1 && current.etag == a_v1.key_write_etag
    ));

    let a_published_v1 = mnt_platform_request_context::scope_org(org_a, async {
        PgOntologyStore::new(rt_pool.clone())
            .transition_lifecycle(
                actor_a,
                a_v1.id,
                a_v1.write_precondition(),
                SchemaLifecycleState::Published,
                false,
                TraceContext::generate(),
                datetime!(2026-07-19 12:02 UTC),
            )
            .await
            .unwrap()
    })
    .await;
    assert_eq!(a_published_v1.key_write_revision, 2);

    let a_v2 = mnt_platform_request_context::scope_org(org_a, async {
        PgOntologyStore::new(rt_pool.clone())
            .stage_revision(
                actor_a,
                key,
                a_published_v1.write_precondition(),
                draft(key, "A v2"),
                TraceContext::generate(),
                datetime!(2026-07-19 12:03 UTC),
            )
            .await
            .unwrap()
    })
    .await;
    assert_eq!(a_v2.schema_version, 2);
    assert_eq!(a_v2.key_write_revision, 3);

    let a_published_v2 = mnt_platform_request_context::scope_org(org_a, async {
        PgOntologyStore::new(rt_pool.clone())
            .transition_lifecycle(
                actor_a,
                a_v2.id,
                a_v2.write_precondition(),
                SchemaLifecycleState::Published,
                false,
                TraceContext::generate(),
                datetime!(2026-07-19 12:04 UTC),
            )
            .await
            .unwrap()
    })
    .await;
    assert_eq!(a_published_v2.key_write_revision, 4);

    let rows = sqlx::query(
        "SELECT schema_version, lifecycle_state FROM ont_object_types WHERE org_id = $1 AND stable_key = $2 ORDER BY schema_version",
    )
    .bind(*org_a.as_uuid())
    .bind(key)
    .fetch_all(&owner_pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0].try_get::<String, _>("lifecycle_state").unwrap(),
        "superseded"
    );
    assert_eq!(
        rows[1].try_get::<String, _>("lifecycle_state").unwrap(),
        "published"
    );
    let revision: i64 = sqlx::query_scalar(
        "SELECT revision FROM ont_object_type_key_revisions WHERE org_id = $1 AND stable_key = $2",
    )
    .bind(*org_a.as_uuid())
    .bind(key)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        revision, 4,
        "multi-row publish increments the key exactly once"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn same_base_stage_has_one_winner_and_one_zero_mutation_precondition_loser(
    owner_pool: PgPool,
) {
    let org = OrgId::knl();
    let actor = seed_org_and_user(&owner_pool, *org.as_uuid(), "race").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let created = mnt_platform_request_context::scope_org(org, async {
        create(
            &PgOntologyStore::new(rt_pool.clone()),
            actor,
            "cas.race",
            "base",
        )
        .await
    })
    .await;
    let expected = created.write_precondition();

    let first_pool = rt_pool.clone();
    let first = tokio::spawn(mnt_platform_request_context::scope_org(org, async move {
        PgOntologyStore::new(first_pool)
            .stage_revision(
                actor,
                "cas.race",
                expected,
                draft("cas.race", "first"),
                TraceContext::generate(),
                datetime!(2026-07-19 12:10 UTC),
            )
            .await
    }));
    let second_pool = rt_pool.clone();
    let second = tokio::spawn(mnt_platform_request_context::scope_org(org, async move {
        PgOntologyStore::new(second_pool)
            .stage_revision(
                actor,
                "cas.race",
                expected,
                draft("cas.race", "second"),
                TraceContext::generate(),
                datetime!(2026-07-19 12:10 UTC),
            )
            .await
    }));
    let outcomes = [first.await.unwrap(), second.await.unwrap()];
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| matches!(result, Err(PgOntologyError::PreconditionFailed { .. })))
            .count(),
        1
    );
    let winner = outcomes
        .iter()
        .find_map(|result| result.as_ref().ok())
        .unwrap();
    assert_eq!(winner.key_write_revision, 2);
    let audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND action = 'ontology.object_type.stage_revision'",
    )
    .bind(*org.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(audits, 1, "the precondition loser emits no audit");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn statement_failure_after_cas_rolls_back_revision_content_and_audit(owner_pool: PgPool) {
    let org = OrgId::knl();
    let actor = seed_org_and_user(&owner_pool, *org.as_uuid(), "rollback").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let created = mnt_platform_request_context::scope_org(org, async {
        create(
            &PgOntologyStore::new(rt_pool.clone()),
            actor,
            "cas.rollback",
            "before",
        )
        .await
    })
    .await;

    sqlx::raw_sql(
        r#"
        CREATE FUNCTION test_reject_cas_content_update() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.stable_key = 'cas.rollback' AND NEW.title = 'rollback me' THEN
                RAISE EXCEPTION 'hostile post-CAS failure';
            END IF;
            RETURN NEW;
        END
        $$;
        CREATE TRIGGER test_reject_cas_content_update
        BEFORE UPDATE ON ont_object_types
        FOR EACH ROW EXECUTE FUNCTION test_reject_cas_content_update();
        "#,
    )
    .execute(&owner_pool)
    .await
    .unwrap();

    let failure = mnt_platform_request_context::scope_org(org, async {
        PgOntologyStore::new(rt_pool)
            .stage_revision(
                actor,
                "cas.rollback",
                created.write_precondition(),
                draft("cas.rollback", "rollback me"),
                TraceContext::generate(),
                datetime!(2026-07-19 12:20 UTC),
            )
            .await
    })
    .await;
    assert!(matches!(failure, Err(PgOntologyError::Db(_))));

    let row = sqlx::query(
        "SELECT k.revision, o.title FROM ont_object_type_key_revisions k JOIN ont_object_types o USING (org_id, stable_key) WHERE k.org_id = $1 AND k.stable_key = 'cas.rollback'",
    )
    .bind(*org.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(row.try_get::<i64, _>("revision").unwrap(), 1);
    assert_eq!(row.try_get::<String, _>("title").unwrap(), "before");
    let stage_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND action = 'ontology.object_type.stage_revision'",
    )
    .bind(*org.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(stage_audits, 0);
}

#[test]
fn stale_write_is_not_a_generic_conflict() {
    let error = PgOntologyError::PreconditionFailed {
        current: mnt_ontology_adapter_postgres::ObjectTypeWriteVersion {
            etag: "\"ont-object-type-key:00000000000000000000000000000001:r9\"".to_owned(),
            revision: 9,
        },
    };
    assert!(!matches!(
        error,
        PgOntologyError::Domain(ref kernel) if kernel.kind == ErrorKind::Conflict
    ));
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn runtime_role_cannot_forge_or_delete_key_validator(owner_pool: PgPool) {
    let org = OrgId::knl();
    let actor = seed_org_and_user(&owner_pool, *org.as_uuid(), "privileges").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let created = mnt_platform_request_context::scope_org(org, async {
        create(
            &PgOntologyStore::new(rt_pool.clone()),
            actor,
            "cas.privileges",
            "protected",
        )
        .await
    })
    .await;

    let forged_validator = Uuid::from_u128(0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff);
    let mut forge_conn = rt_pool.acquire().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(org.as_uuid().to_string())
        .execute(&mut *forge_conn)
        .await
        .unwrap();
    let forge = sqlx::query(
        r#"
        INSERT INTO ont_object_type_key_revisions (
            org_id, stable_key, validator_id, revision, created_at, updated_at
        ) VALUES ($1, 'cas.forged', $2, 999, now(), now())
        "#,
    )
    .bind(*org.as_uuid())
    .bind(forged_validator)
    .execute(&mut *forge_conn)
    .await;
    assert!(
        forge.is_err(),
        "mnt_rt must not supply server-owned validator or revision columns"
    );
    drop(forge_conn);

    let before_versions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ont_object_types WHERE org_id = $1 AND stable_key = 'cas.privileges'",
    )
    .bind(*org.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    let mut delete_conn = rt_pool.acquire().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(org.as_uuid().to_string())
        .execute(&mut *delete_conn)
        .await
        .unwrap();
    let delete = sqlx::query(
        "DELETE FROM ont_object_type_key_revisions WHERE org_id = $1 AND stable_key = 'cas.privileges'",
    )
    .bind(*org.as_uuid())
    .execute(&mut *delete_conn)
    .await;
    assert!(delete.is_err(), "mnt_rt must not delete key validators");
    drop(delete_conn);

    let preserved = sqlx::query(
        r#"
        SELECT k.validator_id, k.revision,
               (SELECT COUNT(*) FROM ont_object_types o
                WHERE o.org_id = k.org_id AND o.stable_key = k.stable_key) AS version_count
        FROM ont_object_type_key_revisions k
        WHERE k.org_id = $1 AND k.stable_key = 'cas.privileges'
        "#,
    )
    .bind(*org.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        preserved.try_get::<Uuid, _>("validator_id").unwrap(),
        created.write_precondition().validator_id
    );
    assert_eq!(preserved.try_get::<i64, _>("revision").unwrap(), 1);
    assert_eq!(
        preserved.try_get::<i64, _>("version_count").unwrap(),
        before_versions
    );
}
