//! Postgres registry adapter and master-list importer.
//!
//! The importer assigns all master-list rows to the default `HQ` branch. It
//! creates the `HQ` region/branch row if roster provisioning has not created
//! one yet.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeMap;
use std::path::Path;

use calamine::{Data, DataType, Range, Reader, open_workbook_auto};
use mnt_kernel_core::{
    BranchId, BranchScope, EquipmentId, EquipmentSubstitutionId, KernelError, TraceContext, UserId,
};
use mnt_platform_db::{DbError, with_audit};
use mnt_registry_application::{
    ImportSheet, MasterListEquipment, ParsedMasterList, RegistryImportReport, RegistryRowError,
    SubstituteAssignment, SubstituteAssignmentCommand, SubstituteCandidate,
    SubstituteReturnCommand, SubstituteSearch, registry_import_audit_event,
    substitute_assign_audit_event, substitute_return_audit_event,
};
use mnt_registry_domain::{
    EquipmentNo, EquipmentStatus, MoneyWon, SubstituteEquipmentProfile, Ton,
    rank_substitute_candidates,
};
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
        let parsed = parse_master_list(path)?;
        let branch_id = self.ensure_default_hq_branch().await?;
        let source_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("master-list")
            .to_string();
        let event = registry_import_audit_event(
            None,
            branch_id,
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
            &source_name,
            parsed.input_rows,
            parsed.equipment.len(),
        )?;
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
                    match upsert_equipment(tx, branch_uuid, &row).await? {
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
        let normalized = management_no.trim().trim_start_matches('#');
        let model = sqlx::query_scalar(
            r#"
            SELECT model
            FROM registry_equipment
            WHERE management_no = $1
            ORDER BY updated_at DESC
            LIMIT 1
            "#,
        )
        .bind(normalized)
        .fetch_optional(&self.pool)
        .await?;
        Ok(model.flatten())
    }

    pub async fn residual_value_by_equipment_no(
        &self,
        equipment_no: &str,
    ) -> Result<Option<i64>, PgRegistryError> {
        let residual = sqlx::query_scalar(
            "SELECT residual_value FROM registry_equipment WHERE equipment_no = $1",
        )
        .bind(equipment_no)
        .fetch_optional(&self.pool)
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

        let event = substitute_assign_audit_event(&command, source.branch_id, substitution_id)?;
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
                        assigned_by, assigned_to, assignment_location, assigned_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
        let event = substitute_return_audit_event(&command, &before)?;
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

    async fn ensure_default_hq_branch(&self) -> Result<BranchId, PgRegistryError> {
        let mut tx = self.pool.begin().await?;
        let region_id: uuid::Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO regions (name)
            VALUES ('HQ')
            ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
            "#,
        )
        .fetch_one(tx.as_mut())
        .await?;

        let branch_id: uuid::Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO branches (region_id, name)
            VALUES ($1, 'HQ')
            ON CONFLICT (region_id, name) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
            "#,
        )
        .bind(region_id)
        .fetch_one(tx.as_mut())
        .await?;

        tx.commit().await?;
        Ok(BranchId::from_uuid(branch_id))
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
    let row = sqlx::query(
        r#"
        SELECT id, branch_id, equipment_no, status, specification, ton_text, ton_milli
        FROM registry_equipment
        WHERE id = $1
        "#,
    )
    .bind(*equipment_id.as_uuid())
    .fetch_optional(pool)
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

    let rows = builder.build().fetch_all(pool).await?;
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
    .fetch_optional(pool)
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
) -> Result<UpsertOutcome, PgRegistryError> {
    let customer_id = upsert_customer(tx, branch_id, &row.customer_name).await?;
    let site_id = upsert_site(tx, branch_id, customer_id, &row.site_name).await?;
    let equipment_no = row.equipment_no.as_str();

    let existing_id: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT id FROM registry_equipment WHERE equipment_no = $1 FOR UPDATE")
            .bind(equipment_no)
            .fetch_optional(tx.as_mut())
            .await?;

    if existing_id.is_none() {
        insert_equipment(tx, branch_id, customer_id, site_id, row).await?;
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

async fn upsert_customer(
    tx: &mut Transaction<'_, Postgres>,
    branch_id: uuid::Uuid,
    name: &str,
) -> Result<uuid::Uuid, PgRegistryError> {
    let id = sqlx::query_scalar(
        r#"
        INSERT INTO registry_customers (branch_id, name)
        VALUES ($1, $2)
        ON CONFLICT (branch_id, name) DO UPDATE
            SET updated_at = registry_customers.updated_at
        RETURNING id
        "#,
    )
    .bind(branch_id)
    .bind(name)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(id)
}

async fn upsert_site(
    tx: &mut Transaction<'_, Postgres>,
    branch_id: uuid::Uuid,
    customer_id: uuid::Uuid,
    name: &str,
) -> Result<uuid::Uuid, PgRegistryError> {
    let id = sqlx::query_scalar(
        r#"
        INSERT INTO registry_sites (branch_id, customer_id, name)
        VALUES ($1, $2, $3)
        ON CONFLICT (branch_id, customer_id, name) DO UPDATE
            SET updated_at = registry_sites.updated_at
        RETURNING id
        "#,
    )
    .bind(branch_id)
    .bind(customer_id)
    .bind(name)
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
                rental_fee, vehicle_value, residual_value, note, source_sheet, source_row
            )
            VALUES (
                $1, $2, $3, $4,
                $5, $6, $7, $8, $9,
                $10, $11, $12, $13, $14,
                $15, $16, $17, $18, $19, $20, $21, $22,
                $23, $24, $25, $26, $27,
                $28, $29, $30,
                $31, $32, $33, $34, $35, $36
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
    Ok(())
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
