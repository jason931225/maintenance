//! Postgres registry adapter and master-list importer.
//!
//! The importer assigns all master-list rows to the default `HQ` branch. It
//! creates the `HQ` region/branch row if roster provisioning has not created
//! one yet.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use calamine::{Data, DataType, Range, Reader, open_workbook_auto};
use mnt_kernel_core::{
    BranchId, BranchScope, CustomerId, EquipmentId, EquipmentSubstitutionId, KernelError, SiteId,
    TraceContext, UserId,
};
use mnt_platform_db::{DbError, with_audit, with_audits, with_org_conn};
use mnt_platform_request_context::current_org;
use mnt_registry_application::{
    CreateCustomerCommand, CreateEquipmentCommand, CreateSiteCommand, CreatedCustomer, CreatedSite,
    DeleteEquipmentCommand, EquipmentByLocationQuery, EquipmentListItem, EquipmentListPage,
    EquipmentListQuery, EquipmentSortBy, ImportSheet, MasterListEquipment, ParsedMasterList,
    RegistryImportReport, RegistryRowError, SiteLocationGroup, SubstituteAssignment,
    SubstituteAssignmentCommand, SubstituteCandidate, SubstituteReturnCommand, SubstituteSearch,
    UpdateEquipmentCommand, UpdateSiteCommand, UpdateSiteFields, customer_create_audit_event,
    equipment_create_audit_event, equipment_delete_audit_event, equipment_update_audit_event,
    registry_import_audit_event, site_create_audit_event, site_update_audit_event,
    substitute_assign_audit_event, substitute_return_audit_event,
};
use mnt_registry_domain::{
    EquipmentNo, EquipmentStatus, MoneyWon, SubstituteEquipmentProfile, Ton,
    rank_substitute_candidates,
};
use serde_json::json;
use sqlx::{PgPool, Postgres, QueryBuilder, Row, Transaction};
use time::{Date, OffsetDateTime, macros::format_description};

#[derive(Debug, thiserror::Error)]
pub enum PgRegistryError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),

    #[error("workbook error: {0}")]
    Workbook(String),
}

impl From<sqlx::Error> for PgRegistryError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

#[derive(Debug, Clone)]
pub struct PgRegistryStore {
    pool: PgPool,
}

impl PgRegistryStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn import_master_list(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<RegistryImportReport, PgRegistryError> {
        let path = path.as_ref();
        let source_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("master-list")
            .to_string();
        self.import_master_list_with_actor(path, None, &source_name)
            .await
    }

    /// Import an uploaded master-list workbook supplied as raw bytes.
    ///
    /// `calamine` reads from a path, so the bytes are spilled to a uniquely
    /// named temp file that is removed before returning. The actual upsert and
    /// audit row are produced by [`Self::import_master_list`].
    pub async fn import_master_list_bytes(
        &self,
        actor: UserId,
        source_name: &str,
        bytes: &[u8],
    ) -> Result<RegistryImportReport, PgRegistryError> {
        let temp_path = std::env::temp_dir().join(format!(
            "mnt-registry-import-{}-{}.xlsx",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mut file = std::fs::File::create(&temp_path)
            .map_err(|err| PgRegistryError::Workbook(format!("cannot stage upload: {err}")))?;
        file.write_all(bytes)
            .and_then(|()| file.flush())
            .map_err(|err| PgRegistryError::Workbook(format!("cannot stage upload: {err}")))?;
        drop(file);

        let result = self
            .import_master_list_with_actor(&temp_path, Some(actor), source_name)
            .await;
        let _ = std::fs::remove_file(&temp_path);
        result
    }

    /// Create a single equipment master row on the default HQ branch, audited.
    // mnt-gate: state-changing-handler
    pub async fn create_equipment(
        &self,
        command: CreateEquipmentCommand,
    ) -> Result<EquipmentId, PgRegistryError> {
        let branch_id = self.ensure_default_hq_branch().await?;
        let row = master_list_row_from_create(&command);
        let branch_uuid = *branch_id.as_uuid();
        let actor = command.actor;
        let trace = command.trace;
        let occurred_at = command.occurred_at;

        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();

        with_audits::<_, EquipmentId, PgRegistryError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let customer_id =
                    upsert_customer(tx, branch_uuid, &row.customer_name, org_uuid).await?;
                let site_id =
                    upsert_site(tx, branch_uuid, customer_id, &row.site_name, org_uuid).await?;
                let existing: Option<uuid::Uuid> =
                    sqlx::query_scalar("SELECT id FROM registry_equipment WHERE equipment_no = $1")
                        .bind(row.equipment_no.as_str())
                        .fetch_optional(tx.as_mut())
                        .await?;
                if existing.is_some() {
                    return Err(KernelError::conflict(format!(
                        "equipment {} already exists",
                        row.equipment_no.as_str()
                    ))
                    .into());
                }
                insert_equipment(tx, branch_uuid, customer_id, site_id, &row, org_uuid).await?;
                let id: uuid::Uuid =
                    sqlx::query_scalar("SELECT id FROM registry_equipment WHERE equipment_no = $1")
                        .bind(row.equipment_no.as_str())
                        .fetch_one(tx.as_mut())
                        .await?;
                let equipment_id = EquipmentId::from_uuid(id);
                let event = equipment_create_audit_event(
                    actor,
                    branch_id,
                    equipment_id,
                    &row.equipment_no,
                    row.status,
                    trace,
                    occurred_at,
                )?;
                Ok((equipment_id, vec![event]))
            })
        })
        .await
    }

    /// Create one customer (고객) directly on the default HQ branch, audited.
    ///
    /// Unlike the importer's `upsert_customer` (idempotent ON CONFLICT DO UPDATE so
    /// a re-import never duplicates), an explicit admin create is a distinct intent:
    /// a same-name customer already on the HQ branch is a `conflict` (→ 409), not a
    /// silent merge into the existing row. The duplicate is detected inside the
    /// armed transaction (mirroring `create_equipment`'s equipment-no check) so the
    /// conflict surfaces as a domain error; the `registry_customers (branch_id, name)`
    /// UNIQUE key is the backstop for a TOCTOU race.
    // mnt-gate: state-changing-handler
    pub async fn create_customer(
        &self,
        command: CreateCustomerCommand,
    ) -> Result<CreatedCustomer, PgRegistryError> {
        let name = command.name;
        let actor = command.actor;
        let trace = command.trace;
        let occurred_at = command.occurred_at;
        let requested_branch = command.branch_id;

        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();

        with_audits::<_, CreatedCustomer, PgRegistryError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                // Land on the caller's branch when supplied (so a branch-scoped
                // admin sees the new customer in its own branch-scoped reads), else
                // on the org's default HQ. Either way the branch lookup/upsert runs
                // on the armed tx so it passes FORCE-RLS WITH CHECK as `mnt_rt`.
                let branch_uuid = resolve_create_branch(tx, requested_branch, org_uuid).await?;
                let branch_id = BranchId::from_uuid(branch_uuid);
                let existing: Option<uuid::Uuid> = sqlx::query_scalar(
                    "SELECT id FROM registry_customers WHERE branch_id = $1 AND name = $2",
                )
                .bind(branch_uuid)
                .bind(&name)
                .fetch_optional(tx.as_mut())
                .await?;
                if existing.is_some() {
                    return Err(
                        KernelError::conflict(format!("customer {name:?} already exists")).into(),
                    );
                }
                let id: uuid::Uuid = sqlx::query_scalar(
                    r#"
                    INSERT INTO registry_customers (branch_id, name, org_id)
                    VALUES ($1, $2, $3)
                    RETURNING id
                    "#,
                )
                .bind(branch_uuid)
                .bind(&name)
                .bind(org_uuid)
                .fetch_one(tx.as_mut())
                .await?;
                let customer = CreatedCustomer {
                    id: CustomerId::from_uuid(id),
                    branch_id,
                    name,
                };
                let event =
                    customer_create_audit_event(actor, branch_id, &customer, trace, occurred_at)?;
                Ok((customer, vec![event]))
            })
        })
        .await
    }

    /// Create one site (현장) under an existing customer, directly, audited.
    ///
    /// The customer must belong to the caller's org: the in-transaction lookup runs
    /// under the armed `app.current_org`, so RLS already hides another tenant's
    /// customer — a foreign-org (or unknown) `customer_id` returns `not_found`
    /// (→ 404), never a leak and never a cross-tenant write. The site lands on the
    /// customer's own branch. A same-name site under the same customer is a
    /// `conflict` (→ 409); the optional location/contact fields are written in the
    /// same INSERT so a site can be onboarded with its address in one step.
    // mnt-gate: state-changing-handler
    pub async fn create_site(
        &self,
        command: CreateSiteCommand,
    ) -> Result<CreatedSite, PgRegistryError> {
        let customer_id = command.customer_id;
        let customer_uuid = *customer_id.as_uuid();
        let name = command.name;
        let actor = command.actor;
        let trace = command.trace;
        let occurred_at = command.occurred_at;
        let address = command.address;
        let province = command.province;
        let city = command.city;
        let postal_code = command.postal_code;
        let latitude = command.latitude;
        let longitude = command.longitude;
        let geofence_radius_m = command.geofence_radius_m;
        let contact_name = command.contact_name;
        let contact_phone = command.contact_phone;
        let contact_email = command.contact_email;

        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();

        with_audits::<_, CreatedSite, PgRegistryError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                // The customer must exist in the caller's org. RLS scopes this read
                // to app.current_org, so a foreign-org customer is invisible and
                // resolves to not_found — the explicit ownership check the spec
                // requires, enforced by the policy rather than trusted from input.
                let branch_uuid: uuid::Uuid = sqlx::query_scalar(
                    "SELECT branch_id FROM registry_customers WHERE id = $1",
                )
                .bind(customer_uuid)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("customer was not found"))?;

                let existing: Option<uuid::Uuid> = sqlx::query_scalar(
                    "SELECT id FROM registry_sites WHERE branch_id = $1 AND customer_id = $2 AND name = $3",
                )
                .bind(branch_uuid)
                .bind(customer_uuid)
                .bind(&name)
                .fetch_optional(tx.as_mut())
                .await?;
                if existing.is_some() {
                    return Err(KernelError::conflict(format!(
                        "site {name:?} already exists for this customer"
                    ))
                    .into());
                }

                let id: uuid::Uuid = sqlx::query_scalar(
                    r#"
                    INSERT INTO registry_sites (
                        branch_id, customer_id, name, org_id,
                        address, province, city, postal_code,
                        latitude, longitude, geofence_radius_m,
                        contact_name, contact_phone, contact_email
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                    RETURNING id
                    "#,
                )
                .bind(branch_uuid)
                .bind(customer_uuid)
                .bind(&name)
                .bind(org_uuid)
                .bind(&address)
                .bind(&province)
                .bind(&city)
                .bind(&postal_code)
                .bind(latitude)
                .bind(longitude)
                .bind(geofence_radius_m)
                .bind(&contact_name)
                .bind(&contact_phone)
                .bind(&contact_email)
                .fetch_one(tx.as_mut())
                .await?;

                let branch_id = BranchId::from_uuid(branch_uuid);
                let site = CreatedSite {
                    id: SiteId::from_uuid(id),
                    customer_id,
                    branch_id,
                    name,
                    address,
                    province,
                    city,
                    postal_code,
                    latitude,
                    longitude,
                    geofence_radius_m,
                    contact_name,
                    contact_phone,
                    contact_email,
                };
                let event = site_create_audit_event(actor, branch_id, &site, trace, occurred_at)?;
                Ok((site, vec![event]))
            })
        })
        .await
    }

    /// Apply a partial update to one equipment row, audited with before/after.
    // mnt-gate: state-changing-handler
    pub async fn update_equipment(
        &self,
        command: UpdateEquipmentCommand,
    ) -> Result<(), PgRegistryError> {
        if command.fields.is_empty() {
            return Err(KernelError::validation("no equipment fields to update").into());
        }
        let existing = fetch_equipment_admin_row(self.pool(), command.equipment_id)
            .await?
            .ok_or_else(|| KernelError::not_found("equipment was not found"))?;
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = equipment_update_audit_event(
            command.actor,
            existing.branch_id,
            command.equipment_id,
            existing.snapshot.clone(),
            update_after_snapshot(&existing.snapshot, &command.fields),
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_org(org);
        let equipment_id = command.equipment_id;
        let branch_uuid = *existing.branch_id.as_uuid();
        let fields = command.fields;

        with_audit::<_, (), PgRegistryError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                if let Some(customer_name) = fields.customer_name.as_deref() {
                    let customer_id =
                        upsert_customer(tx, branch_uuid, customer_name, org_uuid).await?;
                    let site_name = fields
                        .site_name
                        .clone()
                        .unwrap_or_else(|| customer_name.to_owned());
                    let site_id =
                        upsert_site(tx, branch_uuid, customer_id, &site_name, org_uuid).await?;
                    sqlx::query(
                        "UPDATE registry_equipment SET customer_id = $2, site_id = $3, updated_at = now() WHERE id = $1",
                    )
                    .bind(*equipment_id.as_uuid())
                    .bind(customer_id)
                    .bind(site_id)
                    .execute(tx.as_mut())
                    .await?;
                } else if let Some(site_name) = fields.site_name.as_deref() {
                    let customer_id: uuid::Uuid = sqlx::query_scalar(
                        "SELECT customer_id FROM registry_equipment WHERE id = $1",
                    )
                    .bind(*equipment_id.as_uuid())
                    .fetch_one(tx.as_mut())
                    .await?;
                    let site_id =
                        upsert_site(tx, branch_uuid, customer_id, site_name, org_uuid).await?;
                    sqlx::query(
                        "UPDATE registry_equipment SET site_id = $2, updated_at = now() WHERE id = $1",
                    )
                    .bind(*equipment_id.as_uuid())
                    .bind(site_id)
                    .execute(tx.as_mut())
                    .await?;
                }

                apply_scalar_equipment_update(tx, equipment_id, &fields).await
            })
        })
        .await
    }

    /// Soft-delete one equipment row by marking it 폐기 (Disposed). Never hard
    /// deletes, so audit history and work-order/substitution FKs stay intact.
    // mnt-gate: state-changing-handler
    pub async fn soft_delete_equipment(
        &self,
        command: DeleteEquipmentCommand,
    ) -> Result<(), PgRegistryError> {
        let existing = fetch_equipment_admin_row(self.pool(), command.equipment_id)
            .await?
            .ok_or_else(|| KernelError::not_found("equipment was not found"))?;
        if existing.status == EquipmentStatus::Disposed {
            return Err(KernelError::conflict("equipment is already disposed").into());
        }
        let org = current_org().map_err(KernelError::from)?;
        let event = equipment_delete_audit_event(
            command.actor,
            existing.branch_id,
            command.equipment_id,
            &existing.equipment_no,
            existing.status,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_org(org);
        let equipment_id = command.equipment_id;

        with_audit::<_, (), PgRegistryError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE registry_equipment SET status = $2, updated_at = now() WHERE id = $1",
                )
                .bind(*equipment_id.as_uuid())
                .bind(EquipmentStatus::Disposed.as_db_str())
                .execute(tx.as_mut())
                .await?;
                Ok(())
            })
        })
        .await
    }

    /// Aggregate every site visible to `query.branch_scope` with its equipment
    /// counts and (admin-entered) coordinates, for the dispatch map. RLS-armed:
    /// the whole aggregation runs inside `with_org_conn`, so a missing tenant
    /// sees nothing. Sites with NULL coordinates are returned with `None`
    /// coordinates so the UI can list them as ungeocoded instead of pinning a
    /// fabricated location. The branch filter mirrors `substitute_candidates`.
    pub async fn equipment_by_location(
        &self,
        query: EquipmentByLocationQuery,
    ) -> Result<Vec<SiteLocationGroup>, PgRegistryError> {
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
        SELECT
            s.id            AS site_id,
            s.name          AS site_name,
            c.id            AS customer_id,
            c.name          AS customer_name,
            s.branch_id     AS branch_id,
            s.address       AS address,
            s.postal_code   AS postal_code,
            s.province      AS province,
            s.city          AS city,
            s.latitude      AS latitude,
            s.longitude     AS longitude,
            s.geofence_radius_m AS geofence_radius_m,
            s.contact_name  AS contact_name,
            s.contact_phone AS contact_phone,
            s.contact_email AS contact_email,
            COUNT(e.id) FILTER (WHERE e.id IS NOT NULL)        AS equipment_count,
            COUNT(e.id) FILTER (WHERE e.status = '임대')         AS rented_count,
            COUNT(e.id) FILTER (WHERE e.status = '예비')         AS spare_count,
            COUNT(sub.id)                                      AS substitution_active_count
        FROM registry_sites s
        JOIN registry_customers c ON c.id = s.customer_id
        LEFT JOIN registry_equipment e ON e.site_id = s.id
        LEFT JOIN equipment_substitutions sub
            ON sub.substitute_equipment_id = e.id
           AND sub.returned_at IS NULL
        "#,
        );
        push_site_branch_filter(&mut builder, &query.branch_scope)?;
        builder.push(
            r#"
        GROUP BY s.id, s.name, c.id, c.name, s.branch_id, s.address, s.postal_code, s.province,
                 s.city, s.latitude, s.longitude, s.geofence_radius_m, s.contact_name,
                 s.contact_phone, s.contact_email
        ORDER BY s.province NULLS LAST, s.city NULLS LAST, s.name ASC
        "#,
        );

        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgRegistryError>(&self.pool, org, move |tx| {
            Box::pin(async move { Ok(builder.build().fetch_all(tx.as_mut()).await?) })
        })
        .await?;
        rows.iter().map(site_location_group_from_row).collect()
    }

    /// Paginated, filterable, branch-scoped equipment list. RLS-armed via
    /// `with_org_conn` so a missing or mismatched `app.current_org` returns zero
    /// rows (FORCE RLS) rather than leaking cross-tenant data. The branch filter
    /// mirrors `equipment_by_location` and `substitute_candidates` so non-SUPER_ADMIN
    /// principals only see rows in their own branches.
    pub async fn list_equipment(
        &self,
        query: EquipmentListQuery,
    ) -> Result<EquipmentListPage, PgRegistryError> {
        let org = current_org().map_err(KernelError::from)?;

        // Normalize the free-text search term the same way find_model_by_management_no
        // does so floor-typed "10호기" / "#010호기" match stored "010".
        let q_normalized = query.q.as_deref().map(|raw| {
            raw.trim()
                .trim_start_matches('#')
                .trim()
                .trim_end_matches("호기")
                .trim()
                .to_owned()
        });

        let branch_scope = query.branch_scope.clone();
        let status = query.status;
        let branch_id_filter = query.branch_id;
        let customer_id_filter = query.customer_id;
        let site_id_filter = query.site_id;
        let model_filter = query.model.as_deref().map(str::to_lowercase);
        let maker_filter = query.maker.as_deref().map(str::to_lowercase);
        let sort = query.sort;
        let limit = query.limit.clamp(1, 200);
        let offset = query.offset.max(0);

        let (items, total) = with_org_conn::<_, _, PgRegistryError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                // --- COUNT query ---
                let mut count_builder = QueryBuilder::<Postgres>::new(
                    r#"
                    SELECT COUNT(*) AS total
                    FROM registry_equipment e
                    JOIN registry_customers c ON c.id = e.customer_id
                    JOIN registry_sites s ON s.id = e.site_id
                    WHERE TRUE
                    "#,
                );
                push_equipment_list_filters(
                    &mut count_builder,
                    &branch_scope,
                    status,
                    branch_id_filter,
                    customer_id_filter,
                    site_id_filter,
                    &model_filter,
                    &maker_filter,
                    &q_normalized,
                );
                let total: i64 = count_builder
                    .build_query_scalar()
                    .fetch_one(tx.as_mut())
                    .await?;

                // --- ROWS query ---
                let mut rows_builder = QueryBuilder::<Postgres>::new(
                    r#"
                    SELECT
                        e.id            AS equipment_id,
                        e.branch_id     AS branch_id,
                        e.equipment_no  AS equipment_no,
                        e.management_no AS management_no,
                        e.status        AS status,
                        e.model         AS model,
                        e.maker         AS maker,
                        e.specification AS specification,
                        e.ton_text      AS ton_text,
                        c.name          AS customer_name,
                        s.name          AS site_name,
                        e.vin           AS vin,
                        e.updated_at    AS updated_at
                    FROM registry_equipment e
                    JOIN registry_customers c ON c.id = e.customer_id
                    JOIN registry_sites s ON s.id = e.site_id
                    WHERE TRUE
                    "#,
                );
                push_equipment_list_filters(
                    &mut rows_builder,
                    &branch_scope,
                    status,
                    branch_id_filter,
                    customer_id_filter,
                    site_id_filter,
                    &model_filter,
                    &maker_filter,
                    &q_normalized,
                );
                match sort {
                    EquipmentSortBy::EquipmentNo => {
                        rows_builder.push(" ORDER BY e.equipment_no ASC");
                    }
                    EquipmentSortBy::Model => {
                        rows_builder.push(" ORDER BY e.model ASC NULLS LAST, e.equipment_no ASC");
                    }
                    EquipmentSortBy::Customer => {
                        rows_builder.push(" ORDER BY c.name ASC, s.name ASC, e.equipment_no ASC");
                    }
                    EquipmentSortBy::UpdatedAt => {
                        rows_builder.push(" ORDER BY e.updated_at DESC, e.equipment_no ASC");
                    }
                }
                rows_builder.push(" LIMIT ");
                rows_builder.push_bind(limit);
                rows_builder.push(" OFFSET ");
                rows_builder.push_bind(offset);

                let rows = rows_builder.build().fetch_all(tx.as_mut()).await?;
                let items = rows
                    .iter()
                    .map(equipment_list_item_from_row)
                    .collect::<Result<Vec<_>, _>>()?;

                Ok((items, total))
            })
        })
        .await?;

        Ok(EquipmentListPage {
            items,
            total,
            limit,
            offset,
        })
    }

    /// Apply a partial coordinate/address update to one site, audited with
    /// before/after snapshots. This is the only coordinate entry point: a site
    /// is pinnable only once an admin writes a valid lat/lon pair here.
    // mnt-gate: state-changing-handler
    pub async fn update_site(&self, command: UpdateSiteCommand) -> Result<(), PgRegistryError> {
        if command.fields.is_empty() {
            return Err(KernelError::validation("no site fields to update").into());
        }
        let existing = fetch_site_admin_row(self.pool(), command.site_id)
            .await?
            .ok_or_else(|| KernelError::not_found("site was not found"))?;
        // Sites are branch-scoped: a branch-limited actor may only edit sites in
        // its own branch(es). A site in another branch of the same org is treated
        // as not found so its existence is not revealed (RLS already blocks
        // cross-tenant; this closes the within-org cross-branch gap).
        if !command.branch_scope.allows(existing.branch_id) {
            return Err(KernelError::not_found("site was not found").into());
        }
        let org = current_org().map_err(KernelError::from)?;
        let after = site_after_snapshot(&existing.snapshot, &command.fields);
        let event = site_update_audit_event(
            command.actor,
            existing.branch_id,
            command.site_id,
            existing.snapshot.clone(),
            after,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_org(org);
        let site_id = command.site_id;
        let fields = command.fields;

        with_audit::<_, (), PgRegistryError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let mut builder =
                    QueryBuilder::<Postgres>::new("UPDATE registry_sites SET updated_at = now()");
                push_site_assignment(&mut builder, "address", &fields.address);
                push_site_assignment(&mut builder, "province", &fields.province);
                push_site_assignment(&mut builder, "city", &fields.city);
                push_site_assignment(&mut builder, "postal_code", &fields.postal_code);
                push_site_assignment(&mut builder, "contact_name", &fields.contact_name);
                push_site_assignment(&mut builder, "contact_phone", &fields.contact_phone);
                push_site_assignment(&mut builder, "contact_email", &fields.contact_email);
                push_site_f64_assignment(&mut builder, "latitude", &fields.latitude);
                push_site_f64_assignment(&mut builder, "longitude", &fields.longitude);
                push_site_f64_assignment(
                    &mut builder,
                    "geofence_radius_m",
                    &fields.geofence_radius_m,
                );
                builder.push(" WHERE id = ");
                builder.push_bind(*site_id.as_uuid());
                builder.build().execute(tx.as_mut()).await?;
                Ok(())
            })
        })
        .await
    }

    async fn import_master_list_with_actor(
        &self,
        path: &Path,
        actor: Option<UserId>,
        source_name: &str,
    ) -> Result<RegistryImportReport, PgRegistryError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let parsed = parse_master_list(path)?;
        let branch_id = self.ensure_default_hq_branch().await?;
        // Tag the audit event with the calling tenant so `with_audit` arms the
        // transaction-local `app.current_org` GUC before the upsert loop runs.
        // Without this, the customer/site/equipment INSERTs hit FORCE RLS with an
        // unset GUC and are rejected as `mnt_rt` (the production 500); the
        // BYPASSRLS superuser tests never exercise that path.
        let event = equipment_import_event(actor, branch_id, source_name, &parsed)?.with_org(org);
        let branch_uuid = *branch_id.as_uuid();
        let input_rows = parsed.input_rows;
        let equipment_count = parsed.equipment.len();
        let equipment = parsed.equipment;
        let errors = parsed.errors;

        with_audit::<_, RegistryImportReport, PgRegistryError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let mut report = RegistryImportReport {
                    input_rows,
                    equipment_count,
                    errors,
                    ..RegistryImportReport::default()
                };
                let mut imported_equipment_numbers = Vec::with_capacity(equipment.len());

                for row in equipment {
                    imported_equipment_numbers.push(row.equipment_no.as_str().to_string());
                    match upsert_equipment(tx, branch_uuid, &row, org_uuid).await? {
                        UpsertOutcome::Added => report.added += 1,
                        UpsertOutcome::Updated => report.updated += 1,
                        UpsertOutcome::Unchanged => report.unchanged += 1,
                    }
                }

                let orphaned: i64 = sqlx::query_scalar(
                    r#"
                    SELECT COUNT(*)
                    FROM registry_equipment
                    WHERE branch_id = $1
                      AND NOT (equipment_no = ANY($2::TEXT[]))
                    "#,
                )
                .bind(branch_uuid)
                .bind(imported_equipment_numbers)
                .fetch_one(tx.as_mut())
                .await?;
                report.orphaned = usize::try_from(orphaned)
                    .map_err(|_| KernelError::internal("orphan count overflowed usize"))?;

                Ok(report)
            })
        })
        .await
    }

    pub async fn find_model_by_management_no(
        &self,
        management_no: &str,
    ) -> Result<Option<String>, PgRegistryError> {
        let normalized = management_no
            .trim()
            .trim_start_matches('#')
            .trim()
            .trim_end_matches("호기")
            .trim()
            .to_owned();
        let org = current_org().map_err(KernelError::from)?;
        let model = with_org_conn::<_, _, PgRegistryError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    r#"
            SELECT model
            FROM registry_equipment
            WHERE ltrim(management_no, '0') = ltrim($1, '0')
            ORDER BY updated_at DESC
            LIMIT 1
            "#,
                )
                .bind(normalized)
                .fetch_optional(tx.as_mut())
                .await?)
            })
        })
        .await?;
        Ok(model.flatten())
    }

    pub async fn residual_value_by_equipment_no(
        &self,
        equipment_no: &str,
    ) -> Result<Option<i64>, PgRegistryError> {
        let equipment_no = equipment_no.to_owned();
        let org = current_org().map_err(KernelError::from)?;
        let residual = with_org_conn::<_, _, PgRegistryError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT residual_value FROM registry_equipment WHERE equipment_no = $1",
                )
                .bind(equipment_no)
                .fetch_optional(tx.as_mut())
                .await?)
            })
        })
        .await?;
        Ok(residual.flatten())
    }

    pub async fn substitute_candidates(
        &self,
        search: SubstituteSearch,
    ) -> Result<Vec<SubstituteCandidate>, PgRegistryError> {
        let down = fetch_substitute_profile(self.pool(), search.equipment_id)
            .await?
            .ok_or_else(|| KernelError::not_found("equipment was not found"))?;
        if !search.branch_scope.allows(down.branch_id) {
            return Err(KernelError::not_found("equipment is outside branch scope").into());
        }

        let rows = fetch_candidate_rows(self.pool(), &down, &search).await?;
        let mut views_by_id = rows
            .iter()
            .map(|row| (row.profile.id, row.view.clone()))
            .collect::<BTreeMap<_, _>>();
        let ranked = rank_substitute_candidates(&down, rows.into_iter().map(|row| row.profile));

        Ok(ranked
            .into_iter()
            .filter_map(|ranked| {
                views_by_id.remove(&ranked.equipment.id).map(|mut view| {
                    view.match_kind = ranked.kind;
                    view.ton_delta_milli = ranked.ton_delta_milli;
                    view
                })
            })
            .collect())
    }

    pub async fn assign_substitute(
        &self,
        command: SubstituteAssignmentCommand,
    ) -> Result<SubstituteAssignment, PgRegistryError> {
        let assignment_location =
            normalize_required_text(&command.assignment_location, "assignment_location")?;
        let substitution_id = EquipmentSubstitutionId::new();
        let source = fetch_substitute_profile(self.pool(), command.source_equipment_id)
            .await?
            .ok_or_else(|| KernelError::not_found("source equipment was not found"))?;
        let candidate = fetch_substitute_profile(self.pool(), command.substitute_equipment_id)
            .await?
            .ok_or_else(|| KernelError::not_found("substitute equipment was not found"))?;
        validate_substitute_pair(&source, &candidate)?;

        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = substitute_assign_audit_event(&command, source.branch_id, substitution_id)?
            .with_org(org);
        let actor = command.actor;
        let source_id = command.source_equipment_id;
        let substitute_id = command.substitute_equipment_id;
        let assigned_to = command.assigned_to;
        let assigned_at = command.assigned_at;
        let branch_id = source.branch_id;

        with_audit::<_, SubstituteAssignment, PgRegistryError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let source = fetch_substitute_profile_for_update(tx, source_id)
                    .await?
                    .ok_or_else(|| KernelError::not_found("source equipment was not found"))?;
                let candidate = fetch_substitute_profile_for_update(tx, substitute_id)
                    .await?
                    .ok_or_else(|| KernelError::not_found("substitute equipment was not found"))?;
                validate_substitute_pair(&source, &candidate)?;
                ensure_no_active_substitution(tx, source_id, substitute_id).await?;

                sqlx::query(
                    r#"
                    INSERT INTO equipment_substitutions (
                        id, branch_id, source_equipment_id, substitute_equipment_id,
                        assigned_by, assigned_to, assignment_location, assigned_at, org_id
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    "#,
                )
                .bind(*substitution_id.as_uuid())
                .bind(*branch_id.as_uuid())
                .bind(*source_id.as_uuid())
                .bind(*substitute_id.as_uuid())
                .bind(*actor.as_uuid())
                .bind(assigned_to.map(|user_id| *user_id.as_uuid()))
                .bind(assignment_location.as_str())
                .bind(assigned_at)
                .bind(org_uuid)
                .execute(tx.as_mut())
                .await?;

                Ok(SubstituteAssignment {
                    id: substitution_id,
                    branch_id,
                    source_equipment_id: source_id,
                    substitute_equipment_id: substitute_id,
                    assigned_by: actor,
                    assigned_to,
                    assignment_location,
                    assigned_at,
                    returned_by: None,
                    returned_at: None,
                    return_note: None,
                })
            })
        })
        .await
    }

    pub async fn return_substitute(
        &self,
        command: SubstituteReturnCommand,
    ) -> Result<SubstituteAssignment, PgRegistryError> {
        let before = fetch_substitution(self.pool(), command.substitution_id)
            .await?
            .ok_or_else(|| KernelError::not_found("substitution assignment was not found"))?;
        if before.returned_at.is_some() {
            return Err(
                KernelError::conflict("substitution assignment was already returned").into(),
            );
        }
        let org = current_org().map_err(KernelError::from)?;
        let event = substitute_return_audit_event(&command, &before)?.with_org(org);
        let actor = command.actor;
        let substitution_id = command.substitution_id;
        let returned_at = command.returned_at;
        let return_note = command
            .return_note
            .as_ref()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());

        with_audit::<_, SubstituteAssignment, PgRegistryError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let result = sqlx::query(
                    r#"
                    UPDATE equipment_substitutions
                    SET returned_by = $2,
                        returned_at = $3,
                        return_note = $4,
                        updated_at = now()
                    WHERE id = $1
                      AND returned_at IS NULL
                    "#,
                )
                .bind(*substitution_id.as_uuid())
                .bind(*actor.as_uuid())
                .bind(returned_at)
                .bind(return_note.as_deref())
                .execute(tx.as_mut())
                .await?;
                if result.rows_affected() == 0 {
                    return Err(KernelError::conflict(
                        "substitution assignment was already returned",
                    )
                    .into());
                }
                fetch_substitution_tx(tx, substitution_id)
                    .await?
                    .ok_or_else(|| {
                        KernelError::internal("updated substitution assignment was not found")
                            .into()
                    })
            })
        })
        .await
    }

    /// Resolve (creating on first use) the calling tenant's default `HQ`
    /// region/branch, the single branch every master-list row is assigned to.
    ///
    /// RLS-armed: the region/branch upserts run inside `with_org_conn`, which
    /// binds the transaction-local `app.current_org` GUC to `current_org()`, so
    /// the `org_id = current_org` WITH CHECK on `regions`/`branches` passes under
    /// FORCE RLS as the runtime role `mnt_rt`. Both rows carry the caller's org,
    /// so a non-KNL tenant gets its own HQ rather than KNL's — equipment import
    /// lands in the CALLER's org. A bare-pool transaction (no armed GUC) would
    /// fail closed in production while passing the BYPASSRLS superuser tests.
    async fn ensure_default_hq_branch(&self) -> Result<BranchId, PgRegistryError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_org_conn::<_, BranchId, PgRegistryError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let region_id: uuid::Uuid = sqlx::query_scalar(
                    r#"
                    INSERT INTO regions (name, org_id)
                    VALUES ('HQ', $1)
                    ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
                    RETURNING id
                    "#,
                )
                .bind(org_uuid)
                .fetch_one(tx.as_mut())
                .await?;

                let branch_id: uuid::Uuid = sqlx::query_scalar(
                    r#"
                    INSERT INTO branches (region_id, name, org_id)
                    VALUES ($1, 'HQ', $2)
                    ON CONFLICT (region_id, name) DO UPDATE SET name = EXCLUDED.name
                    RETURNING id
                    "#,
                )
                .bind(region_id)
                .bind(org_uuid)
                .fetch_one(tx.as_mut())
                .await?;

                Ok(BranchId::from_uuid(branch_id))
            })
        })
        .await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpsertOutcome {
    Added,
    Updated,
    Unchanged,
}

#[derive(Debug, Clone)]
struct CandidateRow {
    profile: SubstituteEquipmentProfile,
    view: SubstituteCandidate,
}

async fn fetch_substitute_profile(
    pool: &PgPool,
    equipment_id: EquipmentId,
) -> Result<Option<SubstituteEquipmentProfile>, PgRegistryError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgRegistryError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
        SELECT id, branch_id, equipment_no, status, specification, ton_text, ton_milli
        FROM registry_equipment
        WHERE id = $1
        "#,
            )
            .bind(*equipment_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?)
        })
    })
    .await?;
    row.map(|row| substitute_profile_from_row(&row)).transpose()
}

async fn fetch_substitute_profile_for_update(
    tx: &mut Transaction<'_, Postgres>,
    equipment_id: EquipmentId,
) -> Result<Option<SubstituteEquipmentProfile>, PgRegistryError> {
    let row = sqlx::query(
        r#"
        SELECT id, branch_id, equipment_no, status, specification, ton_text, ton_milli
        FROM registry_equipment
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(*equipment_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    row.map(|row| substitute_profile_from_row(&row)).transpose()
}

async fn fetch_candidate_rows(
    pool: &PgPool,
    down: &SubstituteEquipmentProfile,
    search: &SubstituteSearch,
) -> Result<Vec<CandidateRow>, PgRegistryError> {
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        SELECT
            e.id, e.branch_id, e.equipment_no, e.management_no, e.model, e.status,
            e.specification, e.ton_text, e.ton_milli, e.power_code, e.power_label,
            e.placement_location, c.name AS customer_name, s.name AS site_name
        FROM registry_equipment e
        JOIN registry_customers c ON c.id = e.customer_id
        JOIN registry_sites s ON s.id = e.site_id
        WHERE e.status = '예비'
          AND e.id <>
        "#,
    );
    builder.push_bind(*down.id.as_uuid());
    builder.push(
        r#"
          AND NOT EXISTS (
              SELECT 1
              FROM equipment_substitutions active
              WHERE active.substitute_equipment_id = e.id
                AND active.returned_at IS NULL
          )
        "#,
    );
    push_candidate_branch_filter(&mut builder, down, search)?;
    builder.push(" ORDER BY e.equipment_no ASC");

    let org = current_org().map_err(KernelError::from)?;
    let rows = with_org_conn::<_, _, PgRegistryError>(pool, org, move |tx| {
        Box::pin(async move { Ok(builder.build().fetch_all(tx.as_mut()).await?) })
    })
    .await?;
    rows.iter().map(candidate_row_from_row).collect()
}

fn push_candidate_branch_filter(
    builder: &mut QueryBuilder<Postgres>,
    down: &SubstituteEquipmentProfile,
    search: &SubstituteSearch,
) -> Result<(), PgRegistryError> {
    if !search.include_all_branches {
        builder.push(" AND e.branch_id = ");
        builder.push_bind(*down.branch_id.as_uuid());
        return Ok(());
    }

    match &search.branch_scope {
        BranchScope::All => Ok(()),
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push(" AND FALSE");
            Ok(())
        }
        BranchScope::Branches(branches) => {
            let branch_ids = branches
                .iter()
                .map(|branch_id| *branch_id.as_uuid())
                .collect::<Vec<_>>();
            builder.push(" AND e.branch_id = ANY(");
            builder.push_bind(branch_ids);
            builder.push(")");
            Ok(())
        }
    }
}

/// Apply all WHERE-clause filters for the equipment list query onto `builder`.
/// All filters are combinatorial (AND). The branch-scope filter is always applied
/// and mirrors the substitute-candidates / by-location guards so a non-SUPER_ADMIN
/// sees only their branches.
#[allow(clippy::too_many_arguments)]
fn push_equipment_list_filters(
    builder: &mut QueryBuilder<Postgres>,
    branch_scope: &BranchScope,
    status: Option<EquipmentStatus>,
    branch_id_filter: Option<mnt_kernel_core::BranchId>,
    customer_id_filter: Option<mnt_kernel_core::CustomerId>,
    site_id_filter: Option<mnt_kernel_core::SiteId>,
    model_filter: &Option<String>,
    maker_filter: &Option<String>,
    q_normalized: &Option<String>,
) {
    // Branch-scope guard (always applied — mirrors push_site_branch_filter).
    match branch_scope {
        BranchScope::All => {}
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push(" AND FALSE");
            return;
        }
        BranchScope::Branches(branches) => {
            let branch_ids = branches.iter().map(|id| *id.as_uuid()).collect::<Vec<_>>();
            builder.push(" AND e.branch_id = ANY(");
            builder.push_bind(branch_ids);
            builder.push(")");
        }
    }

    // Explicit branch_id filter (must be within scope — already enforced above).
    if let Some(bid) = branch_id_filter {
        builder.push(" AND e.branch_id = ");
        builder.push_bind(*bid.as_uuid());
    }

    // Status filter.
    if let Some(st) = status {
        builder.push(" AND e.status = ");
        builder.push_bind(st.as_db_str());
    }

    // Customer filter.
    if let Some(cid) = customer_id_filter {
        builder.push(" AND e.customer_id = ");
        builder.push_bind(*cid.as_uuid());
    }

    // Site filter.
    if let Some(sid) = site_id_filter {
        builder.push(" AND e.site_id = ");
        builder.push_bind(*sid.as_uuid());
    }

    // Model (case-insensitive exact match).
    if let Some(m) = model_filter {
        builder.push(" AND lower(e.model) = ");
        builder.push_bind(m.clone());
    }

    // Maker (case-insensitive exact match).
    if let Some(mk) = maker_filter {
        builder.push(" AND lower(e.maker) = ");
        builder.push_bind(mk.clone());
    }

    // Free-text search: management_no (leading-zero-insensitive), equipment_no,
    // model, maker, customer name, site name, VIN. The normalized q has already
    // had the 호기 suffix stripped so ltrim('0') comparison works the same way
    // find_model_by_management_no does.
    if let Some(q) = q_normalized
        && !q.is_empty()
    {
        let like_q = format!("%{}%", q.to_lowercase());
        builder.push(" AND (ltrim(e.management_no, '0') = ltrim(");
        builder.push_bind(q.clone());
        builder.push(", '0')");
        builder.push(" OR lower(e.equipment_no) LIKE ");
        builder.push_bind(like_q.clone());
        builder.push(" OR lower(e.model) LIKE ");
        builder.push_bind(like_q.clone());
        builder.push(" OR lower(e.maker) LIKE ");
        builder.push_bind(like_q.clone());
        builder.push(" OR lower(c.name) LIKE ");
        builder.push_bind(like_q.clone());
        builder.push(" OR lower(s.name) LIKE ");
        builder.push_bind(like_q.clone());
        builder.push(" OR lower(e.vin) LIKE ");
        builder.push_bind(like_q);
        builder.push(")");
    }
}

fn equipment_list_item_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<EquipmentListItem, PgRegistryError> {
    let status: String = row.try_get("status")?;
    Ok(EquipmentListItem {
        equipment_id: EquipmentId::from_uuid(row.try_get("equipment_id")?),
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        equipment_no: row.try_get("equipment_no")?,
        management_no: row.try_get("management_no")?,
        status: EquipmentStatus::parse(&status)?,
        model: row.try_get("model")?,
        maker: row.try_get("maker")?,
        specification: row.try_get("specification")?,
        ton_text: row.try_get("ton_text")?,
        customer_name: row.try_get("customer_name")?,
        site_name: row.try_get("site_name")?,
        vin: row.try_get("vin")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Restrict the by-location aggregation to `scope`'s branches. `s.branch_id` is
/// the site's branch; an empty branch list yields no rows (`WHERE FALSE`). This
/// is the same scope rule `push_candidate_branch_filter` applies, so a
/// non-SUPER_ADMIN only ever aggregates their own branches.
fn push_site_branch_filter(
    builder: &mut QueryBuilder<Postgres>,
    scope: &BranchScope,
) -> Result<(), PgRegistryError> {
    match scope {
        BranchScope::All => Ok(()),
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push(" WHERE FALSE");
            Ok(())
        }
        BranchScope::Branches(branches) => {
            let branch_ids = branches
                .iter()
                .map(|branch_id| *branch_id.as_uuid())
                .collect::<Vec<_>>();
            builder.push(" WHERE s.branch_id = ANY(");
            builder.push_bind(branch_ids);
            builder.push(")");
            Ok(())
        }
    }
}

fn site_location_group_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<SiteLocationGroup, PgRegistryError> {
    Ok(SiteLocationGroup {
        site_id: SiteId::from_uuid(row.try_get("site_id")?),
        site_name: row.try_get("site_name")?,
        customer_id: CustomerId::from_uuid(row.try_get("customer_id")?),
        customer_name: row.try_get("customer_name")?,
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        address: row.try_get("address")?,
        postal_code: row.try_get("postal_code")?,
        province: row.try_get("province")?,
        city: row.try_get("city")?,
        latitude: row.try_get("latitude")?,
        longitude: row.try_get("longitude")?,
        geofence_radius_m: row.try_get("geofence_radius_m")?,
        contact_name: row.try_get("contact_name")?,
        contact_phone: row.try_get("contact_phone")?,
        contact_email: row.try_get("contact_email")?,
        equipment_count: row.try_get("equipment_count")?,
        rented_count: row.try_get("rented_count")?,
        spare_count: row.try_get("spare_count")?,
        substitution_active_count: row.try_get("substitution_active_count")?,
    })
}

/// One site row plus the JSON before-snapshot used to audit a coordinate write.
struct SiteAdminRow {
    branch_id: BranchId,
    snapshot: serde_json::Value,
}

async fn fetch_site_admin_row(
    pool: &PgPool,
    site_id: SiteId,
) -> Result<Option<SiteAdminRow>, PgRegistryError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgRegistryError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
        SELECT id, branch_id, name, address, province, city, postal_code, latitude, longitude,
               geofence_radius_m, contact_name, contact_phone, contact_email
        FROM registry_sites
        WHERE id = $1
        "#,
            )
            .bind(*site_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?)
        })
    })
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let snapshot = json!({
        "id": SiteId::from_uuid(row.try_get("id")?),
        "name": row.try_get::<String, _>("name")?,
        "address": row.try_get::<Option<String>, _>("address")?,
        "province": row.try_get::<Option<String>, _>("province")?,
        "city": row.try_get::<Option<String>, _>("city")?,
        "postal_code": row.try_get::<Option<String>, _>("postal_code")?,
        "latitude": row.try_get::<Option<f64>, _>("latitude")?,
        "longitude": row.try_get::<Option<f64>, _>("longitude")?,
        "geofence_radius_m": row.try_get::<Option<f64>, _>("geofence_radius_m")?,
        "contact_name": row.try_get::<Option<String>, _>("contact_name")?,
        "contact_phone": row.try_get::<Option<String>, _>("contact_phone")?,
        "contact_email": row.try_get::<Option<String>, _>("contact_email")?,
    });
    Ok(Some(SiteAdminRow {
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        snapshot,
    }))
}

/// Build the audit after-snapshot by overlaying the requested field changes onto
/// the before-snapshot. `Some(value)` sets, `Some(None)` clears (JSON null),
/// `None` leaves the prior value untouched.
fn site_after_snapshot(before: &serde_json::Value, fields: &UpdateSiteFields) -> serde_json::Value {
    let mut after = before.clone();
    overlay_text(&mut after, "address", &fields.address);
    overlay_text(&mut after, "province", &fields.province);
    overlay_text(&mut after, "city", &fields.city);
    overlay_text(&mut after, "postal_code", &fields.postal_code);
    overlay_text(&mut after, "contact_name", &fields.contact_name);
    overlay_text(&mut after, "contact_phone", &fields.contact_phone);
    overlay_text(&mut after, "contact_email", &fields.contact_email);
    overlay_f64(&mut after, "latitude", &fields.latitude);
    overlay_f64(&mut after, "longitude", &fields.longitude);
    overlay_f64(&mut after, "geofence_radius_m", &fields.geofence_radius_m);
    after
}

fn overlay_text(target: &mut serde_json::Value, key: &str, change: &Option<Option<String>>) {
    if let Some(value) = change {
        target[key] = match value {
            Some(text) => serde_json::Value::String(text.clone()),
            None => serde_json::Value::Null,
        };
    }
}

fn overlay_f64(target: &mut serde_json::Value, key: &str, change: &Option<Option<f64>>) {
    if let Some(value) = change {
        target[key] = match value {
            Some(number) => serde_json::json!(number),
            None => serde_json::Value::Null,
        };
    }
}

/// Push ` , <col> = <bind>` for a nullable text field when the caller supplied a
/// change. `Some(text)` sets the value; `Some(None)` clears it to NULL.
fn push_site_assignment(
    builder: &mut QueryBuilder<Postgres>,
    column: &str,
    change: &Option<Option<String>>,
) {
    if let Some(value) = change {
        builder.push(format!(", {column} = "));
        builder.push_bind(value.clone());
    }
}

/// Like [`push_site_assignment`] for a nullable `DOUBLE PRECISION` column.
fn push_site_f64_assignment(
    builder: &mut QueryBuilder<Postgres>,
    column: &str,
    change: &Option<Option<f64>>,
) {
    if let Some(value) = change {
        builder.push(format!(", {column} = "));
        builder.push_bind(*value);
    }
}

fn substitute_profile_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<SubstituteEquipmentProfile, PgRegistryError> {
    let equipment_no: String = row.try_get("equipment_no")?;
    let status: String = row.try_get("status")?;
    let ton_text: String = row.try_get("ton_text")?;
    Ok(SubstituteEquipmentProfile {
        id: EquipmentId::from_uuid(row.try_get("id")?),
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        equipment_no: EquipmentNo::parse(equipment_no)?,
        status: EquipmentStatus::parse(&status)?,
        specification: row.try_get("specification")?,
        ton: Ton::parse(&ton_text),
    })
}

fn candidate_row_from_row(row: &sqlx::postgres::PgRow) -> Result<CandidateRow, PgRegistryError> {
    let profile = substitute_profile_from_row(row)?;
    Ok(CandidateRow {
        view: SubstituteCandidate {
            equipment_id: profile.id,
            branch_id: profile.branch_id,
            equipment_no: profile.equipment_no.clone(),
            management_no: row.try_get("management_no")?,
            model: row.try_get("model")?,
            status: profile.status,
            specification: profile.specification.clone(),
            ton: profile.ton.clone(),
            power_code: row.try_get("power_code")?,
            power_label: row.try_get("power_label")?,
            customer_name: row.try_get("customer_name")?,
            site_name: row.try_get("site_name")?,
            placement_location: row.try_get("placement_location")?,
            match_kind: mnt_registry_domain::SubstituteMatchKind::ExactTon,
            ton_delta_milli: None,
        },
        profile,
    })
}

fn validate_substitute_pair(
    source: &SubstituteEquipmentProfile,
    candidate: &SubstituteEquipmentProfile,
) -> Result<(), PgRegistryError> {
    if source.branch_id != candidate.branch_id {
        return Err(KernelError::validation(
            "substitute equipment must be in the same branch as the source equipment",
        )
        .into());
    }
    if rank_substitute_candidates(source, [candidate.clone()]).is_empty() {
        return Err(KernelError::validation(
            "substitute equipment is not compatible with the source equipment",
        )
        .into());
    }
    Ok(())
}

async fn ensure_no_active_substitution(
    tx: &mut Transaction<'_, Postgres>,
    source_id: EquipmentId,
    substitute_id: EquipmentId,
) -> Result<(), PgRegistryError> {
    let active_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM equipment_substitutions
        WHERE returned_at IS NULL
          AND (
              source_equipment_id = $1
              OR substitute_equipment_id = $2
          )
        "#,
    )
    .bind(*source_id.as_uuid())
    .bind(*substitute_id.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;
    if active_count > 0 {
        return Err(KernelError::conflict("equipment already has an active substitution").into());
    }
    Ok(())
}

async fn fetch_substitution(
    pool: &PgPool,
    substitution_id: EquipmentSubstitutionId,
) -> Result<Option<SubstituteAssignment>, PgRegistryError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgRegistryError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
        SELECT id, branch_id, source_equipment_id, substitute_equipment_id,
               assigned_by, assigned_to, assignment_location, assigned_at,
               returned_by, returned_at, return_note
        FROM equipment_substitutions
        WHERE id = $1
        "#,
            )
            .bind(*substitution_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?)
        })
    })
    .await?;
    row.map(|row| substitution_from_row(&row)).transpose()
}

async fn fetch_substitution_tx(
    tx: &mut Transaction<'_, Postgres>,
    substitution_id: EquipmentSubstitutionId,
) -> Result<Option<SubstituteAssignment>, PgRegistryError> {
    let row = sqlx::query(
        r#"
        SELECT id, branch_id, source_equipment_id, substitute_equipment_id,
               assigned_by, assigned_to, assignment_location, assigned_at,
               returned_by, returned_at, return_note
        FROM equipment_substitutions
        WHERE id = $1
        "#,
    )
    .bind(*substitution_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    row.map(|row| substitution_from_row(&row)).transpose()
}

fn substitution_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<SubstituteAssignment, PgRegistryError> {
    Ok(SubstituteAssignment {
        id: EquipmentSubstitutionId::from_uuid(row.try_get("id")?),
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        source_equipment_id: EquipmentId::from_uuid(row.try_get("source_equipment_id")?),
        substitute_equipment_id: EquipmentId::from_uuid(row.try_get("substitute_equipment_id")?),
        assigned_by: UserId::from_uuid(row.try_get("assigned_by")?),
        assigned_to: row
            .try_get::<Option<uuid::Uuid>, _>("assigned_to")?
            .map(UserId::from_uuid),
        assignment_location: row.try_get("assignment_location")?,
        assigned_at: row.try_get("assigned_at")?,
        returned_by: row
            .try_get::<Option<uuid::Uuid>, _>("returned_by")?
            .map(UserId::from_uuid),
        returned_at: row.try_get("returned_at")?,
        return_note: row.try_get("return_note")?,
    })
}

fn normalize_required_text(value: &str, field: &str) -> Result<String, KernelError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(KernelError::validation(format!(
            "{field} must not be empty"
        )))
    } else {
        Ok(trimmed.to_owned())
    }
}

async fn upsert_equipment(
    tx: &mut Transaction<'_, Postgres>,
    branch_id: uuid::Uuid,
    row: &MasterListEquipment,
    org_uuid: uuid::Uuid,
) -> Result<UpsertOutcome, PgRegistryError> {
    let customer_id = upsert_customer(tx, branch_id, &row.customer_name, org_uuid).await?;
    let site_id = upsert_site(tx, branch_id, customer_id, &row.site_name, org_uuid).await?;
    let equipment_no = row.equipment_no.as_str();

    let existing_id: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT id FROM registry_equipment WHERE equipment_no = $1 FOR UPDATE")
            .bind(equipment_no)
            .fetch_optional(tx.as_mut())
            .await?;

    if existing_id.is_none() {
        insert_equipment(tx, branch_id, customer_id, site_id, row, org_uuid).await?;
        return Ok(UpsertOutcome::Added);
    }

    let result = bind_equipment_update(
        sqlx::query(
            r#"
            UPDATE registry_equipment
            SET branch_id = $2,
                customer_id = $3,
                site_id = $4,
                management_no = $5,
                manufacturer_code = $6,
                kind_code = $7,
                power_code = $8,
                power_label = $9,
                status = $10,
                manager_name = $11,
                placement_location = $12,
                placement_no = $13,
                operation_shift = $14,
                specification = $15,
                ton_text = $16,
                ton_milli = $17,
                maker = $18,
                model = $19,
                vin = $20,
                year = $21,
                hours = $22,
                vehicle_registration_no = $23,
                insured = $24,
                insurer = $25,
                policy_holder = $26,
                insured_party = $27,
                asset_owner = $28,
                asset_registered_on = $29,
                rental_started_on = $30,
                rental_fee = $31,
                vehicle_value = $32,
                residual_value = $33,
                note = $34,
                source_sheet = $35,
                source_row = $36,
                updated_at = now()
            WHERE equipment_no = $1
              AND (
                branch_id IS DISTINCT FROM $2 OR
                customer_id IS DISTINCT FROM $3 OR
                site_id IS DISTINCT FROM $4 OR
                management_no IS DISTINCT FROM $5 OR
                manufacturer_code IS DISTINCT FROM $6 OR
                kind_code IS DISTINCT FROM $7 OR
                power_code IS DISTINCT FROM $8 OR
                power_label IS DISTINCT FROM $9 OR
                status IS DISTINCT FROM $10 OR
                manager_name IS DISTINCT FROM $11 OR
                placement_location IS DISTINCT FROM $12 OR
                placement_no IS DISTINCT FROM $13 OR
                operation_shift IS DISTINCT FROM $14 OR
                specification IS DISTINCT FROM $15 OR
                ton_text IS DISTINCT FROM $16 OR
                ton_milli IS DISTINCT FROM $17 OR
                maker IS DISTINCT FROM $18 OR
                model IS DISTINCT FROM $19 OR
                vin IS DISTINCT FROM $20 OR
                year IS DISTINCT FROM $21 OR
                hours IS DISTINCT FROM $22 OR
                vehicle_registration_no IS DISTINCT FROM $23 OR
                insured IS DISTINCT FROM $24 OR
                insurer IS DISTINCT FROM $25 OR
                policy_holder IS DISTINCT FROM $26 OR
                insured_party IS DISTINCT FROM $27 OR
                asset_owner IS DISTINCT FROM $28 OR
                asset_registered_on IS DISTINCT FROM $29 OR
                rental_started_on IS DISTINCT FROM $30 OR
                rental_fee IS DISTINCT FROM $31 OR
                vehicle_value IS DISTINCT FROM $32 OR
                residual_value IS DISTINCT FROM $33 OR
                note IS DISTINCT FROM $34 OR
                source_sheet IS DISTINCT FROM $35 OR
                source_row IS DISTINCT FROM $36
              )
            "#,
        ),
        branch_id,
        customer_id,
        site_id,
        row,
    )
    .execute(tx.as_mut())
    .await?;

    if result.rows_affected() == 0 {
        Ok(UpsertOutcome::Unchanged)
    } else {
        Ok(UpsertOutcome::Updated)
    }
}

/// Resolve the default HQ branch for `org_uuid` on an ALREADY-ARMED transaction
/// (one where `app.current_org` is set, e.g. inside a `with_audits` closure).
///
/// This mirrors `ensure_default_hq_branch` but runs on the caller's armed tx
/// instead of an unscoped standalone transaction, so the `regions`/`branches`
/// upserts satisfy the FORCE-RLS `WITH CHECK` as the runtime role `mnt_rt`. The
/// direct customer/site creates use this so the whole create — branch resolution
/// plus the row INSERT plus the audit row — is one atomic, org-scoped unit.
async fn ensure_hq_branch_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
) -> Result<uuid::Uuid, PgRegistryError> {
    let region_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO regions (name, org_id)
        VALUES ('HQ', $1)
        ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        "#,
    )
    .bind(org_uuid)
    .fetch_one(tx.as_mut())
    .await?;

    let branch_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO branches (region_id, name, org_id)
        VALUES ($1, 'HQ', $2)
        ON CONFLICT (region_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        "#,
    )
    .bind(region_id)
    .bind(org_uuid)
    .fetch_one(tx.as_mut())
    .await?;

    Ok(branch_id)
}

/// Resolve the branch a direct create lands on, on an ALREADY-ARMED transaction.
///
/// A `requested` branch is the caller's own branch, taken from the server-resolved
/// principal (a branch-scoped admin); it is used directly. Org membership is
/// enforced by the row's composite FK `(branch_id, org_id) REFERENCES
/// branches(id, org_id)` and FORCE-RLS WITH CHECK, so an out-of-org branch fails
/// the insert rather than silently landing elsewhere. With no requested branch (an
/// org-wide SUPER_ADMIN/EXECUTIVE principal) the org's default HQ branch is used.
async fn resolve_create_branch(
    tx: &mut Transaction<'_, Postgres>,
    requested: Option<BranchId>,
    org_uuid: uuid::Uuid,
) -> Result<uuid::Uuid, PgRegistryError> {
    match requested {
        Some(branch_id) => Ok(*branch_id.as_uuid()),
        None => ensure_hq_branch_in_tx(tx, org_uuid).await,
    }
}

async fn upsert_customer(
    tx: &mut Transaction<'_, Postgres>,
    branch_id: uuid::Uuid,
    name: &str,
    org_uuid: uuid::Uuid,
) -> Result<uuid::Uuid, PgRegistryError> {
    let id = sqlx::query_scalar(
        r#"
        INSERT INTO registry_customers (branch_id, name, org_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (branch_id, name) DO UPDATE
            SET updated_at = registry_customers.updated_at
        RETURNING id
        "#,
    )
    .bind(branch_id)
    .bind(name)
    .bind(org_uuid)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(id)
}

async fn upsert_site(
    tx: &mut Transaction<'_, Postgres>,
    branch_id: uuid::Uuid,
    customer_id: uuid::Uuid,
    name: &str,
    org_uuid: uuid::Uuid,
) -> Result<uuid::Uuid, PgRegistryError> {
    let id = sqlx::query_scalar(
        r#"
        INSERT INTO registry_sites (branch_id, customer_id, name, org_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (branch_id, customer_id, name) DO UPDATE
            SET updated_at = registry_sites.updated_at
        RETURNING id
        "#,
    )
    .bind(branch_id)
    .bind(customer_id)
    .bind(name)
    .bind(org_uuid)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(id)
}

async fn insert_equipment(
    tx: &mut Transaction<'_, Postgres>,
    branch_id: uuid::Uuid,
    customer_id: uuid::Uuid,
    site_id: uuid::Uuid,
    row: &MasterListEquipment,
    org_uuid: uuid::Uuid,
) -> Result<(), PgRegistryError> {
    bind_equipment_insert(
        sqlx::query(
            r#"
            INSERT INTO registry_equipment (
                equipment_no, branch_id, customer_id, site_id,
                management_no, manufacturer_code, kind_code, power_code, power_label,
                status, manager_name, placement_location, placement_no, operation_shift,
                specification, ton_text, ton_milli, maker, model, vin, year, hours,
                vehicle_registration_no, insured, insurer, policy_holder, insured_party,
                asset_owner, asset_registered_on, rental_started_on,
                rental_fee, vehicle_value, residual_value, note, source_sheet, source_row,
                org_id
            )
            VALUES (
                $1, $2, $3, $4,
                $5, $6, $7, $8, $9,
                $10, $11, $12, $13, $14,
                $15, $16, $17, $18, $19, $20, $21, $22,
                $23, $24, $25, $26, $27,
                $28, $29, $30,
                $31, $32, $33, $34, $35, $36,
                $37
            )
            "#,
        ),
        branch_id,
        customer_id,
        site_id,
        row,
    )
    .bind(org_uuid)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// One equipment row's branch, identity, status, and JSON snapshot for the
/// admin CRUD path (update/delete need the before-image for the audit row).
#[derive(Debug, Clone)]
struct EquipmentAdminRow {
    branch_id: BranchId,
    equipment_no: EquipmentNo,
    status: EquipmentStatus,
    snapshot: serde_json::Value,
}

async fn fetch_equipment_admin_row(
    pool: &PgPool,
    equipment_id: EquipmentId,
) -> Result<Option<EquipmentAdminRow>, PgRegistryError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgRegistryError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
        SELECT id, branch_id, equipment_no, status, management_no, model,
               specification, ton_text, ton_milli, power_label,
               manager_name, placement_location, placement_no, operation_shift,
               maker, vin, vehicle_registration_no, insured, insurer,
               policy_holder, insured_party, asset_owner, rental_fee,
               vehicle_value, residual_value, note
        FROM registry_equipment
        WHERE id = $1
        "#,
            )
            .bind(*equipment_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?)
        })
    })
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let equipment_no = EquipmentNo::parse(row.try_get::<String, _>("equipment_no")?)?;
    let status = EquipmentStatus::parse(&row.try_get::<String, _>("status")?)?;
    let snapshot = json!({
        "id": EquipmentId::from_uuid(row.try_get("id")?),
        "equipment_no": equipment_no.as_str(),
        "status": status,
        "management_no": row.try_get::<Option<String>, _>("management_no")?,
        "model": row.try_get::<Option<String>, _>("model")?,
        "specification": row.try_get::<String, _>("specification")?,
        "ton_text": row.try_get::<String, _>("ton_text")?,
        "ton_milli": row.try_get::<Option<i32>, _>("ton_milli")?,
        "power_label": row.try_get::<Option<String>, _>("power_label")?,
        "manager_name": row.try_get::<Option<String>, _>("manager_name")?,
        "placement_location": row.try_get::<Option<String>, _>("placement_location")?,
        "placement_no": row.try_get::<Option<String>, _>("placement_no")?,
        "operation_shift": row.try_get::<Option<String>, _>("operation_shift")?,
        "maker": row.try_get::<Option<String>, _>("maker")?,
        "vin": row.try_get::<Option<String>, _>("vin")?,
        "vehicle_registration_no": row.try_get::<Option<String>, _>("vehicle_registration_no")?,
        "insured": row.try_get::<Option<bool>, _>("insured")?,
        "insurer": row.try_get::<Option<String>, _>("insurer")?,
        "policy_holder": row.try_get::<Option<String>, _>("policy_holder")?,
        "insured_party": row.try_get::<Option<String>, _>("insured_party")?,
        "asset_owner": row.try_get::<Option<String>, _>("asset_owner")?,
        "rental_fee": row.try_get::<Option<i64>, _>("rental_fee")?,
        "vehicle_value": row.try_get::<Option<i64>, _>("vehicle_value")?,
        "residual_value": row.try_get::<Option<i64>, _>("residual_value")?,
        "note": row.try_get::<Option<String>, _>("note")?,
    });
    Ok(Some(EquipmentAdminRow {
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        equipment_no,
        status,
        snapshot,
    }))
}

/// Build the equipment master row the create command would persist, deriving
/// the prefix codes from the validated `equipment_no` exactly like the importer.
fn master_list_row_from_create(command: &CreateEquipmentCommand) -> MasterListEquipment {
    MasterListEquipment {
        source_sheet: ImportSheet::Master,
        source_row: 0,
        manufacturer_code: command.equipment_no.manufacturer_code().to_string(),
        kind_code: command.equipment_no.kind_code().to_string(),
        power_code: command.equipment_no.power_code().to_string(),
        power_label: command.power_label.clone(),
        equipment_no: command.equipment_no.clone(),
        customer_name: command.customer_name.clone(),
        site_name: command.site_name.clone(),
        status: command.status,
        management_no: command.management_no.clone(),
        manager_name: command.manager_name.clone(),
        placement_location: command.placement_location.clone(),
        placement_no: command.placement_no.clone(),
        operation_shift: command.operation_shift.clone(),
        specification: command.specification.clone(),
        ton: command.ton.clone(),
        maker: command.maker.clone(),
        model: command.model.clone(),
        vin: command.vin.clone(),
        year: command.year,
        hours: command.hours,
        vehicle_registration_no: command.vehicle_registration_no.clone(),
        insured: command.insured,
        insurer: command.insurer.clone(),
        policy_holder: command.policy_holder.clone(),
        insured_party: command.insured_party.clone(),
        asset_owner: command.asset_owner.clone(),
        asset_registered_on: command.asset_registered_on,
        rental_started_on: command.rental_started_on,
        rental_fee: command.rental_fee,
        vehicle_value: command.vehicle_value,
        residual_value: command.residual_value,
        note: command.note.clone(),
    }
}

/// Merge a partial update onto the before-snapshot to produce the audit
/// after-image without re-reading the row post-write.
fn update_after_snapshot(
    before: &serde_json::Value,
    fields: &mnt_registry_application::UpdateEquipmentFields,
) -> serde_json::Value {
    let mut after = before.clone();
    let Some(map) = after.as_object_mut() else {
        // The before-snapshot is always built as a JSON object by
        // `fetch_equipment_admin_row`; if that ever changes, fall back to the
        // unmodified before-image rather than panicking.
        return after;
    };
    if let Some(status) = fields.status {
        map.insert("status".to_owned(), json!(status));
    }
    if let Some(specification) = &fields.specification {
        map.insert("specification".to_owned(), json!(specification));
    }
    if let Some(ton) = &fields.ton {
        map.insert("ton_text".to_owned(), json!(ton.as_text()));
        map.insert("ton_milli".to_owned(), json!(ton.milli_tons()));
    }
    merge_opt_string(map, "management_no", &fields.management_no);
    merge_opt_string(map, "model", &fields.model);
    merge_opt_string(map, "power_label", &fields.power_label);
    merge_opt_string(map, "manager_name", &fields.manager_name);
    merge_opt_string(map, "placement_location", &fields.placement_location);
    merge_opt_string(map, "placement_no", &fields.placement_no);
    merge_opt_string(map, "operation_shift", &fields.operation_shift);
    merge_opt_string(map, "maker", &fields.maker);
    merge_opt_string(map, "vin", &fields.vin);
    merge_opt_string(
        map,
        "vehicle_registration_no",
        &fields.vehicle_registration_no,
    );
    merge_opt_string(map, "insurer", &fields.insurer);
    merge_opt_string(map, "policy_holder", &fields.policy_holder);
    merge_opt_string(map, "insured_party", &fields.insured_party);
    merge_opt_string(map, "asset_owner", &fields.asset_owner);
    merge_opt_string(map, "note", &fields.note);
    if let Some(insured) = fields.insured {
        map.insert("insured".to_owned(), json!(insured));
    }
    if let Some(fee) = fields.rental_fee {
        map.insert("rental_fee".to_owned(), json!(fee.map(MoneyWon::amount)));
    }
    if let Some(value) = fields.vehicle_value {
        map.insert(
            "vehicle_value".to_owned(),
            json!(value.map(MoneyWon::amount)),
        );
    }
    if let Some(value) = fields.residual_value {
        map.insert(
            "residual_value".to_owned(),
            json!(value.map(MoneyWon::amount)),
        );
    }
    if let Some(value) = fields.acquisition_cost_won {
        map.insert(
            "acquisition_cost_won".to_owned(),
            json!(value.map(MoneyWon::amount)),
        );
    }
    if let Some(date) = fields.acquisition_date {
        map.insert("acquisition_date".to_owned(), json!(date));
    }
    after
}

fn merge_opt_string(
    map: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    field: &Option<Option<String>>,
) {
    if let Some(value) = field {
        map.insert(key.to_owned(), json!(value));
    }
}

/// Write the scalar (non customer/site) columns of an equipment update. Builds
/// the SET clause dynamically so only supplied fields are touched.
async fn apply_scalar_equipment_update(
    tx: &mut Transaction<'_, Postgres>,
    equipment_id: EquipmentId,
    fields: &mnt_registry_application::UpdateEquipmentFields,
) -> Result<(), PgRegistryError> {
    let mut builder =
        QueryBuilder::<Postgres>::new("UPDATE registry_equipment SET updated_at = now()");
    if let Some(status) = fields.status {
        builder.push(", status = ");
        builder.push_bind(status.as_db_str());
    }
    if let Some(specification) = &fields.specification {
        let specification = specification.trim();
        if specification.is_empty() {
            return Err(KernelError::validation("specification must not be empty").into());
        }
        builder.push(", specification = ");
        builder.push_bind(specification.to_owned());
    }
    if let Some(ton) = &fields.ton {
        builder.push(", ton_text = ");
        builder.push_bind(ton.as_text().to_owned());
        builder.push(", ton_milli = ");
        builder.push_bind(ton.milli_tons());
    }
    push_opt_string_set(&mut builder, "management_no", &fields.management_no);
    push_opt_string_set(&mut builder, "model", &fields.model);
    push_opt_string_set(&mut builder, "power_label", &fields.power_label);
    push_opt_string_set(&mut builder, "manager_name", &fields.manager_name);
    push_opt_string_set(
        &mut builder,
        "placement_location",
        &fields.placement_location,
    );
    push_opt_string_set(&mut builder, "placement_no", &fields.placement_no);
    push_opt_string_set(&mut builder, "operation_shift", &fields.operation_shift);
    push_opt_string_set(&mut builder, "maker", &fields.maker);
    push_opt_string_set(&mut builder, "vin", &fields.vin);
    push_opt_string_set(
        &mut builder,
        "vehicle_registration_no",
        &fields.vehicle_registration_no,
    );
    push_opt_string_set(&mut builder, "insurer", &fields.insurer);
    push_opt_string_set(&mut builder, "policy_holder", &fields.policy_holder);
    push_opt_string_set(&mut builder, "insured_party", &fields.insured_party);
    push_opt_string_set(&mut builder, "asset_owner", &fields.asset_owner);
    push_opt_string_set(&mut builder, "note", &fields.note);
    if let Some(insured) = fields.insured {
        builder.push(", insured = ");
        builder.push_bind(insured);
    }
    if let Some(year) = fields.year {
        builder.push(", year = ");
        builder.push_bind(year);
    }
    if let Some(date) = fields.asset_registered_on {
        builder.push(", asset_registered_on = ");
        builder.push_bind(date);
    }
    if let Some(date) = fields.rental_started_on {
        builder.push(", rental_started_on = ");
        builder.push_bind(date);
    }
    if let Some(hours) = fields.hours {
        builder.push(", hours = ");
        builder.push_bind(hours);
    }
    if let Some(fee) = fields.rental_fee {
        builder.push(", rental_fee = ");
        builder.push_bind(fee.map(MoneyWon::amount));
    }
    if let Some(value) = fields.vehicle_value {
        builder.push(", vehicle_value = ");
        builder.push_bind(value.map(MoneyWon::amount));
    }
    if let Some(value) = fields.residual_value {
        builder.push(", residual_value = ");
        builder.push_bind(value.map(MoneyWon::amount));
    }
    if let Some(value) = fields.acquisition_cost_won {
        builder.push(", acquisition_cost_won = ");
        builder.push_bind(value.map(MoneyWon::amount));
    }
    if let Some(date) = fields.acquisition_date {
        builder.push(", acquisition_date = ");
        builder.push_bind(date);
    }
    builder.push(" WHERE id = ");
    builder.push_bind(*equipment_id.as_uuid());
    builder.build().execute(tx.as_mut()).await?;
    Ok(())
}

fn push_opt_string_set(
    builder: &mut QueryBuilder<Postgres>,
    column: &str,
    field: &Option<Option<String>>,
) {
    if let Some(value) = field {
        let normalized = value
            .as_ref()
            .map(|raw| raw.trim().to_owned())
            .filter(|raw| !raw.is_empty());
        builder.push(format!(", {column} = "));
        builder.push_bind(normalized);
    }
}

fn equipment_import_event(
    actor: Option<UserId>,
    branch_id: BranchId,
    source_name: &str,
    parsed: &ParsedMasterList,
) -> Result<mnt_kernel_core::AuditEvent, PgRegistryError> {
    registry_import_audit_event(
        actor,
        branch_id,
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
        source_name,
        parsed.input_rows,
        parsed.equipment.len(),
    )
    .map_err(PgRegistryError::from)
}

fn bind_equipment_insert<'q>(
    query: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
    branch_id: uuid::Uuid,
    customer_id: uuid::Uuid,
    site_id: uuid::Uuid,
    row: &'q MasterListEquipment,
) -> sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments> {
    query
        .bind(row.equipment_no.as_str())
        .bind(branch_id)
        .bind(customer_id)
        .bind(site_id)
        .bind(row.management_no.as_deref())
        .bind(row.manufacturer_code.as_str())
        .bind(row.kind_code.as_str())
        .bind(row.power_code.as_str())
        .bind(row.power_label.as_deref())
        .bind(row.status.as_db_str())
        .bind(row.manager_name.as_deref())
        .bind(row.placement_location.as_deref())
        .bind(row.placement_no.as_deref())
        .bind(row.operation_shift.as_deref())
        .bind(row.specification.as_str())
        .bind(row.ton.as_text())
        .bind(row.ton.milli_tons())
        .bind(row.maker.as_deref())
        .bind(row.model.as_deref())
        .bind(row.vin.as_deref())
        .bind(row.year)
        .bind(row.hours)
        .bind(row.vehicle_registration_no.as_deref())
        .bind(row.insured)
        .bind(row.insurer.as_deref())
        .bind(row.policy_holder.as_deref())
        .bind(row.insured_party.as_deref())
        .bind(row.asset_owner.as_deref())
        .bind(row.asset_registered_on)
        .bind(row.rental_started_on)
        .bind(row.rental_fee.map(MoneyWon::amount))
        .bind(row.vehicle_value.map(MoneyWon::amount))
        .bind(row.residual_value.map(MoneyWon::amount))
        .bind(row.note.as_deref())
        .bind(row.source_sheet.workbook_name())
        .bind(i32::try_from(row.source_row).unwrap_or(i32::MAX))
}

fn bind_equipment_update<'q>(
    query: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
    branch_id: uuid::Uuid,
    customer_id: uuid::Uuid,
    site_id: uuid::Uuid,
    row: &'q MasterListEquipment,
) -> sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments> {
    bind_equipment_insert(query, branch_id, customer_id, site_id, row)
}

pub fn parse_master_list(path: impl AsRef<Path>) -> Result<ParsedMasterList, PgRegistryError> {
    let mut workbook = open_workbook_auto(path.as_ref())
        .map_err(|err| PgRegistryError::Workbook(err.to_string()))?;
    let master = workbook
        .worksheet_range(ImportSheet::Master.workbook_name())
        .map_err(|err| PgRegistryError::Workbook(err.to_string()))?;
    let reserve = workbook
        .worksheet_range(ImportSheet::Reserve.workbook_name())
        .map_err(|err| PgRegistryError::Workbook(err.to_string()))?;

    let mut by_equipment_no = BTreeMap::new();
    let mut errors = Vec::new();
    let mut input_rows = 0usize;
    let mut prefix_checked_rows = 0usize;

    for row in 4..=447 {
        match parse_master_row(&master, row) {
            Ok(Some(equipment)) => {
                input_rows += 1;
                prefix_checked_rows += 1;
                by_equipment_no.insert(equipment.equipment_no.as_str().to_string(), equipment);
            }
            Ok(None) => {}
            Err(error) => errors.push(error),
        }
    }

    for row in 5..=61 {
        match parse_reserve_row(&reserve, row) {
            Ok(Some(equipment)) => {
                input_rows += 1;
                prefix_checked_rows += 1;
                by_equipment_no.insert(equipment.equipment_no.as_str().to_string(), equipment);
            }
            Ok(None) => {}
            Err(error) => errors.push(error),
        }
    }

    Ok(ParsedMasterList {
        input_rows,
        prefix_checked_rows,
        equipment: by_equipment_no.into_values().collect(),
        errors,
    })
}

fn parse_master_row(
    range: &Range<Data>,
    row: u32,
) -> Result<Option<MasterListEquipment>, RegistryRowError> {
    let sheet = ImportSheet::Master;
    let Some(equipment_no) = parse_equipment_no(range, sheet, row, 6)? else {
        if row_has_any(range, row, 1..=30) {
            return Err(RegistryRowError::new(
                sheet.workbook_name(),
                row,
                "missing 장비 No",
            ));
        }
        return Ok(None);
    };
    assert_prefix_cells(
        sheet,
        row,
        &equipment_no,
        Some(normalized_cell_text_padded(range, row, 2, 3)),
        Some(normalized_cell_text(range, row, 3)),
        Some(normalized_cell_text(range, row, 5)),
        Some(normalized_cell_text(range, row, 4)),
    )?;

    let site_name = required_text(range, sheet, row, 7, "사업장")?;
    let customer_name = optional_text(range, row, 8).unwrap_or_else(|| site_name.clone());

    Ok(Some(MasterListEquipment {
        source_sheet: sheet,
        source_row: row,
        management_no: optional_text(range, row, 2),
        manufacturer_code: equipment_no.manufacturer_code().to_string(),
        kind_code: equipment_no.kind_code().to_string(),
        power_code: equipment_no.power_code().to_string(),
        power_label: None,
        equipment_no,
        customer_name,
        site_name,
        status: parse_status(range, sheet, row, 9)?,
        manager_name: optional_text(range, row, 10),
        placement_location: optional_text(range, row, 11),
        placement_no: optional_text(range, row, 12),
        operation_shift: optional_text(range, row, 13),
        specification: required_text(range, sheet, row, 14, "규격")?,
        ton: Ton::parse(&required_text(range, sheet, row, 15, "톤수")?),
        maker: optional_text(range, row, 16),
        model: optional_text(range, row, 17),
        vin: optional_text(range, row, 18),
        year: optional_date(range, sheet, row, 19, "년식")?,
        hours: optional_i64(range, sheet, row, 20, "가동시간")?,
        vehicle_registration_no: optional_text(range, row, 21),
        insured: optional_bool_yn(range, sheet, row, 22, "보험")?,
        insurer: optional_text(range, row, 23),
        policy_holder: optional_text(range, row, 24),
        insured_party: optional_text(range, row, 25),
        asset_owner: optional_text(range, row, 26),
        asset_registered_on: optional_date(range, sheet, row, 27, "자산 등록일")?,
        rental_started_on: optional_date(range, sheet, row, 28, "임대 시작일")?,
        rental_fee: optional_money(range, sheet, row, 29, "임대료")?,
        vehicle_value: optional_money(range, sheet, row, 30, "차량가액")?,
        residual_value: None,
        note: None,
    }))
}

fn parse_reserve_row(
    range: &Range<Data>,
    row: u32,
) -> Result<Option<MasterListEquipment>, RegistryRowError> {
    let sheet = ImportSheet::Reserve;
    let marker = optional_text(range, row, 1).unwrap_or_default();
    let equipment_text = optional_text(range, row, 3);
    if equipment_text.is_none() {
        let ignorable = marker.is_empty()
            || marker.starts_with(char::is_numeric)
            || marker.starts_with('※')
            || marker.contains("참고자료")
            || optional_text(range, row, 3).as_deref() == Some("장비 No")
            || !row_has_any(range, row, 2..=22);
        if ignorable {
            return Ok(None);
        }
        return Err(RegistryRowError::new(
            sheet.workbook_name(),
            row,
            "missing 장비 No",
        ));
    }
    if equipment_text.as_deref() == Some("장비 No") {
        return Ok(None);
    }

    let equipment_no = parse_equipment_no(range, sheet, row, 3)?
        .ok_or_else(|| RegistryRowError::new(sheet.workbook_name(), row, "missing 장비 No"))?;
    assert_prefix_cells(
        sheet,
        row,
        &equipment_no,
        None,
        None,
        None,
        Some(normalized_cell_text(range, row, 2)),
    )?;

    let site_name = required_text(range, sheet, row, 4, "사업장")?;
    Ok(Some(MasterListEquipment {
        source_sheet: sheet,
        source_row: row,
        management_no: optional_text(range, row, 8),
        manufacturer_code: equipment_no.manufacturer_code().to_string(),
        kind_code: equipment_no.kind_code().to_string(),
        power_code: equipment_no.power_code().to_string(),
        power_label: optional_text(range, row, 1),
        equipment_no,
        customer_name: site_name.clone(),
        site_name,
        status: parse_status(range, sheet, row, 5)?,
        manager_name: optional_text(range, row, 6),
        placement_location: optional_text(range, row, 7),
        placement_no: optional_text(range, row, 8),
        operation_shift: None,
        specification: required_text(range, sheet, row, 9, "규격")?,
        ton: Ton::parse(&required_text(range, sheet, row, 10, "톤수")?),
        maker: optional_text(range, row, 11),
        model: optional_text(range, row, 12),
        vin: optional_text(range, row, 13),
        year: optional_date(range, sheet, row, 14, "년식")?,
        hours: None,
        vehicle_registration_no: None,
        insured: optional_bool_yn(range, sheet, row, 15, "보험")?,
        insurer: None,
        policy_holder: None,
        insured_party: None,
        asset_owner: optional_text(range, row, 16),
        asset_registered_on: optional_date(range, sheet, row, 17, "자산등록일")?,
        rental_started_on: optional_date(range, sheet, row, 18, "임대시작일")?,
        rental_fee: optional_money(range, sheet, row, 19, "임대료")?,
        vehicle_value: optional_money(range, sheet, row, 20, "차량가액")?,
        residual_value: optional_money(range, sheet, row, 21, "잔존가")?,
        note: optional_text(range, row, 22),
    }))
}

fn parse_equipment_no(
    range: &Range<Data>,
    sheet: ImportSheet,
    row: u32,
    col: u32,
) -> Result<Option<EquipmentNo>, RegistryRowError> {
    let Some(value) = optional_text(range, row, col) else {
        return Ok(None);
    };
    EquipmentNo::parse(value)
        .map(Some)
        .map_err(|err| RegistryRowError::new(sheet.workbook_name(), row, err.message))
}

fn assert_prefix_cells(
    sheet: ImportSheet,
    row: u32,
    equipment_no: &EquipmentNo,
    sequence: Option<String>,
    manufacturer: Option<String>,
    kind: Option<String>,
    power: Option<String>,
) -> Result<(), RegistryRowError> {
    let mut mismatches = Vec::new();
    if let Some(sequence) = sequence
        && sequence != equipment_no.sequence_code()
    {
        mismatches.push(format!(
            "호기 {sequence:?} != {:?}",
            equipment_no.sequence_code()
        ));
    }
    if let Some(manufacturer) = manufacturer
        && manufacturer != equipment_no.manufacturer_code()
    {
        mismatches.push(format!(
            "제조 {manufacturer:?} != {:?}",
            equipment_no.manufacturer_code()
        ));
    }
    if let Some(kind) = kind
        && kind != equipment_no.kind_code()
    {
        mismatches.push(format!("종류 {kind:?} != {:?}", equipment_no.kind_code()));
    }
    if let Some(power) = power
        && power != equipment_no.power_code()
    {
        mismatches.push(format!("동력 {power:?} != {:?}", equipment_no.power_code()));
    }

    if mismatches.is_empty() {
        Ok(())
    } else {
        Err(RegistryRowError::new(
            sheet.workbook_name(),
            row,
            format!("장비 No prefix mismatch: {}", mismatches.join(", ")),
        ))
    }
}

fn parse_status(
    range: &Range<Data>,
    sheet: ImportSheet,
    row: u32,
    col: u32,
) -> Result<EquipmentStatus, RegistryRowError> {
    let status = required_text(range, sheet, row, col, "상태")?;
    EquipmentStatus::parse(&status)
        .map_err(|err| RegistryRowError::new(sheet.workbook_name(), row, err.message))
}

fn required_text(
    range: &Range<Data>,
    sheet: ImportSheet,
    row: u32,
    col: u32,
    field: &str,
) -> Result<String, RegistryRowError> {
    optional_text(range, row, col).ok_or_else(|| {
        RegistryRowError::new(sheet.workbook_name(), row, format!("missing {field}"))
    })
}

fn optional_text(range: &Range<Data>, row: u32, col: u32) -> Option<String> {
    let value = normalized_cell_text(range, row, col);
    (!value.is_empty()).then_some(value)
}

fn normalized_cell_text(range: &Range<Data>, row: u32, col: u32) -> String {
    cell(range, row, col)
        .and_then(DataType::as_string)
        .or_else(|| cell(range, row, col).map(ToString::to_string))
        .unwrap_or_default()
        .replace('\n', " ")
        .trim()
        .to_string()
}

fn normalized_cell_text_padded(range: &Range<Data>, row: u32, col: u32, width: usize) -> String {
    if let Some(value) = cell(range, row, col).and_then(DataType::as_i64) {
        return format!("{value:0width$}");
    }
    normalized_cell_text(range, row, col)
}

fn optional_i64(
    range: &Range<Data>,
    sheet: ImportSheet,
    row: u32,
    col: u32,
    field: &str,
) -> Result<Option<i64>, RegistryRowError> {
    let Some(cell) = cell(range, row, col) else {
        return Ok(None);
    };
    if is_empty_cell(cell) {
        return Ok(None);
    }
    cell.as_i64().map(Some).ok_or_else(|| {
        RegistryRowError::new(
            sheet.workbook_name(),
            row,
            format!("malformed integer in {field}"),
        )
    })
}

fn optional_money(
    range: &Range<Data>,
    sheet: ImportSheet,
    row: u32,
    col: u32,
    field: &str,
) -> Result<Option<MoneyWon>, RegistryRowError> {
    let Some(cell) = cell(range, row, col) else {
        return Ok(None);
    };
    if is_empty_cell(cell) {
        return Ok(None);
    }
    cell.as_f64()
        .map(|value| MoneyWon::new(value.round() as i64))
        .map(Some)
        .ok_or_else(|| {
            RegistryRowError::new(
                sheet.workbook_name(),
                row,
                format!("malformed money value in {field}"),
            )
        })
}

fn optional_bool_yn(
    range: &Range<Data>,
    sheet: ImportSheet,
    row: u32,
    col: u32,
    field: &str,
) -> Result<Option<bool>, RegistryRowError> {
    let Some(value) = optional_text(range, row, col) else {
        return Ok(None);
    };
    match value.as_str() {
        "Y" => Ok(Some(true)),
        "N" => Ok(Some(false)),
        _ => Err(RegistryRowError::new(
            sheet.workbook_name(),
            row,
            format!("malformed Y/N value in {field}"),
        )),
    }
}

fn optional_date(
    range: &Range<Data>,
    sheet: ImportSheet,
    row: u32,
    col: u32,
    field: &str,
) -> Result<Option<Date>, RegistryRowError> {
    let Some(cell) = cell(range, row, col) else {
        return Ok(None);
    };
    if is_empty_cell(cell) {
        return Ok(None);
    }

    let date_text = cell
        .as_date()
        .map(|date| date.to_string())
        .or_else(|| optional_text(range, row, col).map(|value| value.chars().take(10).collect()));

    let Some(date_text) = date_text else {
        return Err(RegistryRowError::new(
            sheet.workbook_name(),
            row,
            format!("malformed date in {field}"),
        ));
    };

    let format = format_description!("[year]-[month]-[day]");
    Date::parse(&date_text, format).map(Some).map_err(|_| {
        RegistryRowError::new(
            sheet.workbook_name(),
            row,
            format!("malformed date in {field}: {date_text:?}"),
        )
    })
}

fn row_has_any(range: &Range<Data>, row: u32, cols: std::ops::RangeInclusive<u32>) -> bool {
    cols.into_iter().any(|col| {
        cell(range, row, col)
            .map(|value| !is_empty_cell(value))
            .unwrap_or(false)
    })
}

fn cell(range: &Range<Data>, sheet_row: u32, sheet_col: u32) -> Option<&Data> {
    let (start_row, start_col) = range.start()?;
    let row = sheet_row.checked_sub(1)?.checked_sub(start_row)?;
    let col = sheet_col.checked_sub(1)?.checked_sub(start_col)?;
    range.get((usize::try_from(row).ok()?, usize::try_from(col).ok()?))
}

fn is_empty_cell(cell: &Data) -> bool {
    cell.is_empty()
        || cell
            .as_string()
            .map(|value| value.trim().is_empty())
            .unwrap_or(false)
}
