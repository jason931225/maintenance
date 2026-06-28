//! Group hierarchy helpers that preserve the tenant RLS boundary.
//!
//! This crate intentionally lives outside `platform/db` so the rls-arming gate
//! scans it like any other production data-path crate. The only bare-pool query
//! here calls the identity-only SECURITY DEFINER resolver that returns member
//! org ids; all tenant data reads are fan-outs through `with_org_conn`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::{future::Future, pin::Pin};

use mnt_kernel_core::{OrgId, UserId};
use mnt_platform_db::{DbError, with_org_conn};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupMemberOrg {
    pub org_id: OrgId,
    pub slug: String,
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsolidatedRow<T> {
    pub group_id: uuid::Uuid,
    pub org_id: OrgId,
    pub value: T,
}

/// Resolve the active member orgs visible to `actor` for `group_id`.
///
/// This is the only pre-arming query this crate performs: the SQL function is
/// the narrow identity resolver from migration 0060 and returns member org
/// identity rows only when the actor still has a live group grant. Empty output
/// is a valid fail-closed result and must never be treated as permission to run
/// a global data scan.
pub async fn group_member_orgs(
    pool: &PgPool,
    group_id: uuid::Uuid,
    actor: UserId,
) -> Result<Vec<GroupMemberOrg>, DbError> {
    let rows = sqlx::query(
        r#"
        SELECT org_id, slug, name, status
        FROM group_member_org_ids($1, $2)
        "#,
    )
    .bind(group_id)
    .bind(*actor.as_uuid())
    // rls-arming: ok identity-only SECURITY DEFINER resolver; no tenant row data is read here
    .fetch_all(pool)
    .await
    .map_err(DbError::Sqlx)?;

    let mut members = Vec::with_capacity(rows.len());
    for row in rows {
        let org_uuid: uuid::Uuid = row.try_get("org_id").map_err(DbError::Sqlx)?;
        members.push(GroupMemberOrg {
            org_id: OrgId::from_uuid(org_uuid),
            slug: row.try_get("slug").map_err(DbError::Sqlx)?,
            name: row.try_get("name").map_err(DbError::Sqlx)?,
            status: row.try_get("status").map_err(DbError::Sqlx)?,
        });
    }

    Ok(members)
}

/// Resolve active member orgs visible to `actor` only when the actor still has
/// a live `GROUP_ADMIN` grant for `group_id`.
///
/// Use this for delegated tenant-context request validation. The broader
/// [`group_member_orgs`] helper intentionally accepts any live group role for
/// read-only/consolidated group views; a writable delegated tenant principal
/// must fail closed after a downgrade to `GROUP_VIEWER` or `GROUP_FINANCE`.
pub async fn group_admin_member_orgs(
    pool: &PgPool,
    group_id: uuid::Uuid,
    actor: UserId,
) -> Result<Vec<GroupMemberOrg>, DbError> {
    let has_group_admin_grant: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM group_role_grants_for_user($1) AS grants
                JOIN groups g ON g.id = grants.group_id
            WHERE grants.group_id = $2
              AND grants.group_role = 'GROUP_ADMIN'
              AND g.status = 'ACTIVE'
        )
        "#,
    )
    .bind(*actor.as_uuid())
    .bind(group_id)
    // rls-arming: ok identity-only SECURITY DEFINER grants resolver + safe groups metadata
    .fetch_one(pool)
    .await
    .map_err(DbError::Sqlx)?;

    if !has_group_admin_grant {
        return Ok(Vec::new());
    }

    group_member_orgs(pool, group_id, actor).await
}

/// Fan out an existing tenant-scoped read across resolver-authorized members.
///
/// The helper opens one `with_org_conn` transaction per member, so the supplied
/// `read` closure receives only an already-armed transaction and should execute
/// SQL with `tx.as_mut()`. If `members` is empty this returns an empty vector
/// without touching the pool.
pub async fn consolidated_read<F, T, E>(
    pool: &PgPool,
    group_id: uuid::Uuid,
    members: &[GroupMemberOrg],
    read: F,
) -> Result<Vec<ConsolidatedRow<T>>, E>
where
    F: for<'tx> Fn(
        OrgId,
        &'tx mut Transaction<'_, Postgres>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<T>, E>> + Send + 'tx>>,
    E: From<DbError>,
{
    consolidated_read_via(group_id, members, |org_id| {
        let read = &read;
        async move { with_org_conn(pool, org_id, move |tx| read(org_id, tx)).await }
    })
    .await
}

async fn consolidated_read_via<R, Fut, T, E>(
    group_id: uuid::Uuid,
    members: &[GroupMemberOrg],
    mut read_member: R,
) -> Result<Vec<ConsolidatedRow<T>>, E>
where
    R: FnMut(OrgId) -> Fut,
    Fut: Future<Output = Result<Vec<T>, E>>,
{
    let mut out = Vec::new();

    for member in members {
        let org_id = member.org_id;
        let rows = read_member(org_id).await?;
        out.extend(rows.into_iter().map(|value| ConsolidatedRow {
            group_id,
            org_id,
            value,
        }));
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;

    #[tokio::test]
    async fn empty_member_set_fails_closed_without_pool_checkout() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://mnt_rt:unused@127.0.0.1/unused")
            .unwrap();

        let rows: Vec<ConsolidatedRow<()>> =
            consolidated_read(&pool, uuid::Uuid::new_v4(), &[], |_org, _tx| {
                Box::pin(async { Ok::<Vec<()>, DbError>(Vec::new()) })
            })
            .await
            .unwrap();

        assert!(rows.is_empty());
    }

    #[tokio::test]
    async fn consolidated_read_fans_out_once_per_member_org() {
        let group_id = uuid::Uuid::new_v4();
        let first_org = OrgId::from_uuid(uuid::Uuid::new_v4());
        let second_org = OrgId::from_uuid(uuid::Uuid::new_v4());
        let members = vec![member(first_org, "first"), member(second_org, "second")];
        let mut seen_orgs = Vec::new();

        let rows = consolidated_read_via(group_id, &members, |org_id| {
            seen_orgs.push(org_id);
            async move { Ok::<_, DbError>(vec![format!("row-for-{org_id}")]) }
        })
        .await
        .unwrap();

        assert_eq!(seen_orgs, vec![first_org, second_org]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].group_id, group_id);
        assert_eq!(rows[0].org_id, first_org);
        assert_eq!(rows[0].value, format!("row-for-{first_org}"));
        assert_eq!(rows[1].group_id, group_id);
        assert_eq!(rows[1].org_id, second_org);
        assert_eq!(rows[1].value, format!("row-for-{second_org}"));
    }

    #[sqlx::test(migrations = "../db/migrations")]
    async fn group_admin_member_orgs_fails_closed_after_role_downgrade(owner_pool: PgPool) {
        let rt_pool = runtime_role_pool(&owner_pool).await;
        let org_id = uuid::Uuid::from_u128(0xA067_A067_A067_A067_A067_A067_A067_A067);
        let group_id = uuid::Uuid::from_u128(0xB067_B067_B067_B067_B067_B067_B067_B067);
        let actor = UserId::from_uuid(uuid::Uuid::from_u128(
            0xC067_C067_C067_C067_C067_C067_C067_C067,
        ));

        let mut tx = owner_pool.begin().await.unwrap();
        sqlx::query("SET LOCAL row_security = off")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, 'g067-a', 'G067 A')")
            .bind(org_id)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'Group Actor', ARRAY['MEMBER'], $2)")
            .bind(*actor.as_uuid())
            .bind(org_id)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO groups (id, slug, name) VALUES ($1, 'g067', 'G067')")
            .bind(group_id)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO group_memberships (group_id, org_id) VALUES ($1, $2)")
            .bind(group_id)
            .bind(org_id)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO group_role_grants (group_id, user_id, group_role, granted_by) VALUES ($1, $2, 'GROUP_ADMIN', NULL)")
            .bind(group_id)
            .bind(*actor.as_uuid())
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let rows = group_admin_member_orgs(&rt_pool, group_id, actor)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].org_id, OrgId::from_uuid(org_id));

        let mut tx = owner_pool.begin().await.unwrap();
        sqlx::query("SET LOCAL row_security = off")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "DELETE FROM group_role_grants WHERE group_id = $1 AND user_id = $2 AND group_role = 'GROUP_ADMIN'",
        )
        .bind(group_id)
        .bind(*actor.as_uuid())
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query("INSERT INTO group_role_grants (group_id, user_id, group_role, granted_by) VALUES ($1, $2, 'GROUP_VIEWER', NULL)")
            .bind(group_id)
            .bind(*actor.as_uuid())
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let rows = group_admin_member_orgs(&rt_pool, group_id, actor)
            .await
            .unwrap();
        assert!(
            rows.is_empty(),
            "delegated writable tenant context must fail closed after GROUP_ADMIN downgrade",
        );
    }

    async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
        let options = owner_pool.connect_options().as_ref().clone();
        PgPoolOptions::new()
            .max_connections(2)
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

    fn member(org_id: OrgId, slug: &str) -> GroupMemberOrg {
        GroupMemberOrg {
            org_id,
            slug: slug.to_owned(),
            name: format!("{slug} org"),
            status: "ACTIVE".to_owned(),
        }
    }
}
