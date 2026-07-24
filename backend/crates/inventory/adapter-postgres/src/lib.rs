//! Postgres adapter for the inventory IV module.
//!
//! Reads run through `with_org_conn`; mutations run through `with_audits` and
//! attach `org_id` to every emitted audit event. QueryBuilder/runtime SQL keeps
//! this crate SQLx-offline friendly: no new `.sqlx` cache entries are required.

use mnt_inventory_application::{
    ConsumeInventoryCommand, ConsumeInventorySource, CreateInventoryItemCommand,
    CreateStockLocationCommand, InventoryConsumptionEventView, InventoryConsumptionResult,
    InventoryItemPage, InventoryItemView, InventoryStockLocationSummary,
    InventoryStockLocationView, ListConsumptionEventsQuery, ListInventoryItemsQuery,
    UpdateInventoryItemCommand, UpdateInventoryItemFields, inventory_audit_event,
};
use mnt_inventory_domain::{
    InventoryCode, InventoryConsumptionSource, InventoryItemState, InventoryItemStatus, MoneyWon,
    PositiveQuantityMilli, QuantityMilli, SafetyStockMilli, UnitCode,
};
use mnt_kernel_core::{
    BranchId, BranchScope, ErrorKind, InventoryConsumptionEventId, InventoryItemId,
    InventoryStockLocationId, KernelError, OrgId, P1DispatchId, SiteId, UserId, WorkOrderId,
};
use mnt_platform_db::{DbError, with_audits, with_org_conn};
use mnt_platform_request_context::current_org;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, QueryBuilder, Row, Transaction};

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 100;
const ITEM_COLUMNS: &str = "i.id, i.branch_id, i.stock_location_id, i.site_id, i.iv_code, i.sku, \
     i.display_name, i.description, i.unit_code, i.quantity_on_hand_milli, \
     i.safety_stock_milli, i.unit_cost_won, i.status, i.created_by, i.created_at, \
     i.updated_at, l.label AS stock_location_label";

#[derive(Debug, thiserror::Error)]
pub enum PgInventoryError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl PgInventoryError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(error) => error.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(DbError::Sqlx(sqlx::Error::Database(error)))
                if error.code().is_some_and(|code| code == "23505") =>
            {
                ErrorKind::Conflict
            }
            Self::Db(_) => ErrorKind::Internal,
        }
    }
}

impl From<sqlx::Error> for PgInventoryError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

#[derive(Debug, Clone)]
pub struct PgInventoryStore {
    pool: PgPool,
}

impl PgInventoryStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    // mnt-gate: state-changing-handler
    pub async fn create_stock_location(
        &self,
        command: CreateStockLocationCommand,
    ) -> Result<InventoryStockLocationView, PgInventoryError> {
        ensure_branch_allowed(&command.branch_scope, command.branch_id)?;
        let label = normalize_required_text(&command.label, 120, "stock location label")?;
        let location_code = normalize_optional_text(command.location_code, 80, "location_code")?;
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let location_id = InventoryStockLocationId::new();

        with_audits::<_, InventoryStockLocationView, PgInventoryError>(&self.pool, org, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO inventory_stock_locations (
                        id, org_id, branch_id, site_id, location_code, label, status, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $7)
                    "#,
                )
                .bind(*location_id.as_uuid())
                .bind(org_uuid)
                .bind(*command.branch_id.as_uuid())
                .bind(command.site_id.map(|site| *site.as_uuid()))
                .bind(location_code.as_deref())
                .bind(&label)
                .bind(command.occurred_at)
                .execute(tx.as_mut())
                .await?;

                let view = fetch_location_tx(tx, location_id).await?.ok_or_else(|| {
                    KernelError::internal("created inventory stock location was not readable")
                })?;
                let event = inventory_audit_event(
                    "inventory.location.create",
                    Some(command.actor),
                    Some(command.branch_id),
                    "inventory_stock_location",
                    location_id,
                    command.trace,
                    command.occurred_at,
                )?
                .with_org(org)
                .with_snapshots(None, Some(location_snapshot(&view)));
                Ok((view, vec![event]))
            })
        })
        .await
    }

    pub async fn get_item(
        &self,
        item_id: InventoryItemId,
        branch_scope: BranchScope,
    ) -> Result<Option<InventoryItemView>, PgInventoryError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgInventoryError>(&self.pool, org, move |tx| {
            Box::pin(async move { fetch_item_scoped_tx(tx, item_id, &branch_scope).await })
        })
        .await
    }

    pub async fn list_items(
        &self,
        query: ListInventoryItemsQuery,
    ) -> Result<InventoryItemPage, PgInventoryError> {
        let limit = normalized_limit(query.limit);
        let offset = query.offset.unwrap_or(0).max(0);
        let query_for_count = query.clone();
        let mut count_builder = QueryBuilder::<Postgres>::new(
            "SELECT COUNT(*) FROM inventory_items i JOIN inventory_stock_locations l \
             ON l.id = i.stock_location_id AND l.org_id = i.org_id WHERE ",
        );
        push_item_filters(&mut count_builder, &query_for_count)?;

        let mut builder = QueryBuilder::<Postgres>::new("SELECT ");
        builder.push(ITEM_COLUMNS);
        builder.push(
            " FROM inventory_items i JOIN inventory_stock_locations l \
             ON l.id = i.stock_location_id AND l.org_id = i.org_id WHERE ",
        );
        push_item_filters(&mut builder, &query)?;
        builder.push(" ORDER BY i.updated_at DESC, i.id DESC LIMIT ");
        builder.push_bind(limit);
        builder.push(" OFFSET ");
        builder.push_bind(offset);

        let org = current_org().map_err(KernelError::from)?;
        let (total, rows) = with_org_conn::<_, _, PgInventoryError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let total: i64 = count_builder
                    .build_query_scalar()
                    .fetch_one(tx.as_mut())
                    .await?;
                let rows = builder.build().fetch_all(tx.as_mut()).await?;
                Ok((total, rows))
            })
        })
        .await?;

        let mut items = Vec::with_capacity(rows.len());
        for row in &rows {
            items.push(item_from_row(row)?);
        }
        Ok(InventoryItemPage {
            items,
            limit,
            offset,
            total,
        })
    }

    // mnt-gate: state-changing-handler
    pub async fn create_item(
        &self,
        command: CreateInventoryItemCommand,
    ) -> Result<InventoryItemView, PgInventoryError> {
        ensure_branch_allowed(&command.branch_scope, command.branch_id)?;
        let display_name = normalize_required_text(&command.display_name, 120, "display_name")?;
        let sku = normalize_optional_text(command.sku, 80, "sku")?;
        let description = normalize_optional_text(command.description, 1_000, "description")?;
        let unit_code = UnitCode::new(command.unit_code)?;
        let quantity = QuantityMilli::new(command.quantity_on_hand_milli)?;
        let safety = SafetyStockMilli::new(command.safety_stock_milli)?;
        let unit_cost = command.unit_cost_won.map(MoneyWon::new).transpose()?;
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let item_id = InventoryItemId::new();
        let iv_code = issue_inventory_code(item_id)?;

        with_audits::<_, InventoryItemView, PgInventoryError>(&self.pool, org, |tx| {
            Box::pin(async move {
                let location = fetch_location_tx(tx, command.stock_location_id)
                    .await?
                    .ok_or_else(|| KernelError::not_found("stock location was not found"))?;
                if location.branch_id != command.branch_id {
                    return Err(KernelError::conflict(
                        "stock location branch does not match item branch",
                    )
                    .into());
                }

                sqlx::query(
                    r#"
                    INSERT INTO inventory_items (
                        id, org_id, branch_id, stock_location_id, site_id, iv_code, sku,
                        display_name, description, unit_code, quantity_on_hand_milli,
                        safety_stock_milli, unit_cost_won, status, created_by, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                              'ACTIVE', $14, $15, $15)
                    "#,
                )
                .bind(*item_id.as_uuid())
                .bind(org_uuid)
                .bind(*command.branch_id.as_uuid())
                .bind(*command.stock_location_id.as_uuid())
                .bind(location.site_id.map(|site| *site.as_uuid()))
                .bind(iv_code.as_str())
                .bind(sku.as_deref())
                .bind(&display_name)
                .bind(description.as_deref())
                .bind(unit_code.as_str())
                .bind(quantity.value())
                .bind(safety.value())
                .bind(unit_cost.map(MoneyWon::value))
                .bind(*command.actor.as_uuid())
                .bind(command.occurred_at)
                .execute(tx.as_mut())
                .await?;

                let view = fetch_item_tx(tx, item_id).await?.ok_or_else(|| {
                    KernelError::internal("created inventory item was not readable")
                })?;
                let event = inventory_audit_event(
                    "inventory_item.create",
                    Some(command.actor),
                    Some(command.branch_id),
                    "inventory_item",
                    item_id,
                    command.trace,
                    command.occurred_at,
                )?
                .with_org(org)
                .with_snapshots(None, Some(item_snapshot(&view)));
                Ok((view, vec![event]))
            })
        })
        .await
    }

    // mnt-gate: state-changing-handler
    pub async fn update_item(
        &self,
        command: UpdateInventoryItemCommand,
    ) -> Result<InventoryItemView, PgInventoryError> {
        if command.fields.is_empty() {
            return Err(KernelError::validation("no inventory item fields to update").into());
        }
        let fields = normalize_update_fields(command.fields)?;
        let org = current_org().map_err(KernelError::from)?;

        with_audits::<_, InventoryItemView, PgInventoryError>(&self.pool, org, |tx| {
            Box::pin(async move {
                let before = fetch_item_for_update_tx(tx, command.item_id)
                    .await?
                    .ok_or_else(|| KernelError::not_found("inventory item was not found"))?;
                ensure_branch_allowed(&command.branch_scope, before.branch_id)?;

                let mut builder = QueryBuilder::<Postgres>::new("UPDATE inventory_items SET ");
                let mut sep = builder.separated(", ");
                if let Some(sku) = fields.sku.clone() {
                    sep.push("sku = ");
                    sep.push_bind_unseparated(sku);
                }
                if let Some(display_name) = fields.display_name.clone() {
                    sep.push("display_name = ");
                    sep.push_bind_unseparated(display_name);
                }
                if let Some(description) = fields.description.clone() {
                    sep.push("description = ");
                    sep.push_bind_unseparated(description);
                }
                if let Some(safety_stock_milli) = fields.safety_stock_milli {
                    sep.push("safety_stock_milli = ");
                    sep.push_bind_unseparated(safety_stock_milli);
                }
                if let Some(status) = fields.status {
                    sep.push("status = ");
                    sep.push_bind_unseparated(status.as_db_str());
                }
                sep.push("updated_at = ");
                sep.push_bind_unseparated(command.occurred_at);
                builder.push(" WHERE id = ");
                builder.push_bind(*command.item_id.as_uuid());
                builder.build().execute(tx.as_mut()).await?;

                let after = fetch_item_tx(tx, command.item_id).await?.ok_or_else(|| {
                    KernelError::internal("updated inventory item was not readable")
                })?;
                let action = if fields.status == Some(InventoryItemStatus::Archived) {
                    "inventory_item.archive"
                } else {
                    "inventory_item.update"
                };
                let event = inventory_audit_event(
                    action,
                    Some(command.actor),
                    Some(before.branch_id),
                    "inventory_item",
                    command.item_id,
                    command.trace,
                    command.occurred_at,
                )?
                .with_org(org)
                .with_snapshots(Some(item_snapshot(&before)), Some(item_snapshot(&after)));
                Ok((after, vec![event]))
            })
        })
        .await
    }

    // mnt-gate: state-changing-handler
    pub async fn consume_item(
        &self,
        command: ConsumeInventoryCommand,
    ) -> Result<InventoryConsumptionResult, PgInventoryError> {
        let quantity = PositiveQuantityMilli::new(command.quantity_consumed_milli)?;
        let idempotency_key = normalize_idempotency_key(&command.idempotency_key)?;
        let memo = normalize_optional_text(command.memo, 1_000, "memo")?;
        let occurred_at = command.occurred_at.unwrap_or(command.requested_at);
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();

        with_audits::<_, InventoryConsumptionResult, PgInventoryError>(&self.pool, org, |tx| {
            Box::pin(async move {
                let source = resolve_consumption_source_tx(tx, command.source).await?;
                let fingerprint = request_fingerprint(
                    command.item_id,
                    source.source,
                    quantity,
                    memo.as_deref(),
                    command.occurred_at,
                );

                // The event uniqueness constraint is the durable backstop, but a
                // read-before-insert replay check alone leaves concurrent callers
                // racing to that constraint. Serialize one org/key pair for this
                // transaction so the follower sees the committed event and can
                // return its stored result (or a fingerprint conflict) instead.
                lock_consumption_idempotency_key_tx(tx, org, &idempotency_key).await?;

                if let Some((event, existing_fingerprint)) =
                    fetch_event_by_idempotency_key_tx(tx, &idempotency_key).await?
                {
                    if existing_fingerprint != fingerprint {
                        return Err(KernelError::conflict(
                            "idempotency key was already used with a different inventory consumption payload",
                        )
                        .into());
                    }
                    let item = fetch_item_tx(tx, command.item_id).await?.ok_or_else(|| {
                        KernelError::internal("idempotent inventory item result was not readable")
                    })?;
                    ensure_branch_allowed(&command.branch_scope, item.branch_id)?;
                    return Ok((InventoryConsumptionResult { event, item }, Vec::new()));
                }

                let before = fetch_item_for_update_tx(tx, command.item_id)
                    .await?
                    .ok_or_else(|| KernelError::not_found("inventory item was not found"))?;
                ensure_branch_allowed(&command.branch_scope, before.branch_id)?;
                if source.branch_id != before.branch_id {
                    return Err(KernelError::conflict(
                        "inventory consumption source branch must match item branch",
                    )
                    .into());
                }

                let state = item_state(&before)?;
                let outcome = state.consume(quantity)?;
                let event_id = InventoryConsumptionEventId::new();

                sqlx::query(
                    r#"
                    INSERT INTO inventory_consumption_events (
                        id, org_id, branch_id, item_id, stock_location_id, source_kind,
                        work_order_id, dispatch_id, quantity_before_milli,
                        quantity_consumed_milli, quantity_after_milli, unit_cost_won,
                        cost_won, consumed_by, occurred_at, memo, idempotency_key,
                        request_fingerprint, created_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                              $13, $14, $15, $16, $17, $18, $19)
                    "#,
                )
                .bind(*event_id.as_uuid())
                .bind(org_uuid)
                .bind(*before.branch_id.as_uuid())
                .bind(*command.item_id.as_uuid())
                .bind(*before.stock_location.id.as_uuid())
                .bind(source.source.kind_db_str())
                .bind(*source.source.work_order_id().as_uuid())
                .bind(source.source.dispatch_id().map(|id| *id.as_uuid()))
                .bind(outcome.quantity_before_milli.value())
                .bind(outcome.quantity_consumed_milli.value())
                .bind(outcome.quantity_after_milli.value())
                .bind(before.unit_cost_won)
                .bind(outcome.cost_won.map(MoneyWon::value))
                .bind(*command.actor.as_uuid())
                .bind(occurred_at)
                .bind(memo.as_deref())
                .bind(&idempotency_key)
                .bind(&fingerprint)
                .bind(command.requested_at)
                .execute(tx.as_mut())
                .await?;

                sqlx::query(
                    "UPDATE inventory_items SET quantity_on_hand_milli = $2, updated_at = $3 WHERE id = $1",
                )
                .bind(*command.item_id.as_uuid())
                .bind(outcome.quantity_after_milli.value())
                .bind(command.requested_at)
                .execute(tx.as_mut())
                .await?;

                let event = fetch_event_tx(tx, event_id).await?.ok_or_else(|| {
                    KernelError::internal("created inventory consumption event was not readable")
                })?;
                let item = fetch_item_tx(tx, command.item_id).await?.ok_or_else(|| {
                    KernelError::internal("consumed inventory item was not readable")
                })?;
                let audit = inventory_audit_event(
                    "inventory.consume",
                    Some(command.actor),
                    Some(before.branch_id),
                    "inventory_consumption_event",
                    event_id,
                    command.trace,
                    command.requested_at,
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({
                        "item_id": command.item_id.to_string(),
                        "iv_code": before.iv_code,
                        "quantity_on_hand_milli": outcome.quantity_before_milli.value(),
                    })),
                    Some(serde_json::json!({
                        "item_id": command.item_id.to_string(),
                        "event_id": event_id.to_string(),
                        "source": event.source,
                        "quantity_consumed_milli": outcome.quantity_consumed_milli.value(),
                        "quantity_on_hand_milli": outcome.quantity_after_milli.value(),
                        "low_stock": outcome.low_stock_after,
                        "idempotency_key_sha256": sha256_hex(&idempotency_key),
                    })),
                );
                Ok((InventoryConsumptionResult { event, item }, vec![audit]))
            })
        })
        .await
    }

    pub async fn list_consumption_events(
        &self,
        query: ListConsumptionEventsQuery,
    ) -> Result<Vec<InventoryConsumptionEventView>, PgInventoryError> {
        let limit = normalized_limit(query.limit);
        let offset = query.offset.unwrap_or(0).max(0);
        let source_kind = normalize_source_kind(query.source_kind)?;
        let mut builder = QueryBuilder::<Postgres>::new(
            "SELECT e.id, e.item_id, i.iv_code, e.branch_id, e.stock_location_id, \
             e.source_kind, e.work_order_id, e.dispatch_id, e.quantity_before_milli, \
             e.quantity_consumed_milli, e.quantity_after_milli, e.unit_cost_won, e.cost_won, \
             e.consumed_by, e.occurred_at, e.memo, e.created_at \
             FROM inventory_consumption_events e \
             JOIN inventory_items i ON i.id = e.item_id AND i.org_id = e.org_id \
             WHERE e.item_id = ",
        );
        builder.push_bind(*query.item_id.as_uuid());
        builder.push(" AND ");
        push_branch_scope(&mut builder, &query.branch_scope, "e.branch_id");
        if let Some(source_kind) = source_kind {
            builder.push(" AND e.source_kind = ");
            builder.push_bind(source_kind);
        }
        if let Some(work_order_id) = query.work_order_id {
            builder.push(" AND e.work_order_id = ");
            builder.push_bind(*work_order_id.as_uuid());
        }
        if let Some(dispatch_id) = query.dispatch_id {
            builder.push(" AND e.dispatch_id = ");
            builder.push_bind(*dispatch_id.as_uuid());
        }
        builder.push(" ORDER BY e.occurred_at DESC, e.id DESC LIMIT ");
        builder.push_bind(limit);
        builder.push(" OFFSET ");
        builder.push_bind(offset);

        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgInventoryError>(&self.pool, org, move |tx| {
            Box::pin(async move { Ok(builder.build().fetch_all(tx.as_mut()).await?) })
        })
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            out.push(event_from_row(row)?);
        }
        Ok(out)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedConsumptionSource {
    source: InventoryConsumptionSource,
    branch_id: BranchId,
}

fn normalized_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn ensure_branch_allowed(scope: &BranchScope, branch_id: BranchId) -> Result<(), KernelError> {
    if scope.allows(branch_id) {
        Ok(())
    } else {
        Err(KernelError::forbidden(
            "inventory branch is outside principal scope",
        ))
    }
}

fn normalize_required_text(
    value: &str,
    max_chars: usize,
    field: &str,
) -> Result<String, KernelError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(KernelError::validation(format!("{field} is required")));
    }
    if trimmed.chars().count() > max_chars {
        return Err(KernelError::validation(format!("{field} is too long")));
    }
    Ok(trimmed.to_owned())
}

fn normalize_optional_text(
    value: Option<String>,
    max_chars: usize,
    field: &str,
) -> Result<Option<String>, KernelError> {
    value
        .map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else if trimmed.chars().count() > max_chars {
                Err(KernelError::validation(format!("{field} is too long")))
            } else {
                Ok(Some(trimmed.to_owned()))
            }
        })
        .transpose()
        .map(Option::flatten)
}

fn normalize_idempotency_key(value: &str) -> Result<String, KernelError> {
    let trimmed = value.trim();
    if !(16..=200).contains(&trimmed.chars().count()) {
        return Err(KernelError::validation(
            "idempotency_key must be between 16 and 200 characters",
        ));
    }
    Ok(trimmed.to_owned())
}

fn normalize_source_kind(value: Option<String>) -> Result<Option<String>, KernelError> {
    value
        .map(|value| {
            let normalized = value.trim().to_ascii_uppercase();
            if normalized.is_empty() {
                Ok(None)
            } else if matches!(normalized.as_str(), "WORK_ORDER" | "P1_DISPATCH") {
                Ok(Some(normalized))
            } else {
                Err(KernelError::validation("unknown inventory source kind"))
            }
        })
        .transpose()
        .map(Option::flatten)
}

fn normalize_update_fields(
    fields: UpdateInventoryItemFields,
) -> Result<UpdateInventoryItemFields, KernelError> {
    Ok(UpdateInventoryItemFields {
        sku: fields
            .sku
            .map(|value| normalize_optional_text(value, 80, "sku"))
            .transpose()?,
        display_name: fields
            .display_name
            .map(|value| normalize_required_text(&value, 120, "display_name"))
            .transpose()?,
        description: fields
            .description
            .map(|value| normalize_optional_text(value, 1_000, "description"))
            .transpose()?,
        safety_stock_milli: fields
            .safety_stock_milli
            .map(|value| SafetyStockMilli::new(value).map(SafetyStockMilli::value))
            .transpose()?,
        status: fields.status,
    })
}

fn issue_inventory_code(item_id: InventoryItemId) -> Result<InventoryCode, KernelError> {
    let raw = item_id.as_uuid().simple().to_string();
    let suffix = raw
        .chars()
        .take(12)
        .collect::<String>()
        .to_ascii_uppercase();
    InventoryCode::new(format!("IV-{suffix}"))
}

fn push_branch_scope(builder: &mut QueryBuilder<Postgres>, scope: &BranchScope, column: &str) {
    match scope {
        BranchScope::All => builder.push("TRUE"),
        BranchScope::Branches(branches) if branches.is_empty() => builder.push("FALSE"),
        BranchScope::Branches(branches) => {
            let ids = branches
                .iter()
                .map(|branch| *branch.as_uuid())
                .collect::<Vec<_>>();
            builder.push(column);
            builder.push(" = ANY(");
            builder.push_bind(ids);
            builder.push(")")
        }
    };
}

fn push_item_filters(
    builder: &mut QueryBuilder<Postgres>,
    query: &ListInventoryItemsQuery,
) -> Result<(), KernelError> {
    push_branch_scope(builder, &query.branch_scope, "i.branch_id");
    if let Some(branch_id) = query.branch_id {
        if !query.branch_scope.allows(branch_id) {
            builder.push(" AND FALSE");
        } else {
            builder.push(" AND i.branch_id = ");
            builder.push_bind(*branch_id.as_uuid());
        }
    }
    if let Some(site_id) = query.site_id {
        builder.push(" AND i.site_id = ");
        builder.push_bind(*site_id.as_uuid());
    }
    if let Some(stock_location_id) = query.stock_location_id {
        builder.push(" AND i.stock_location_id = ");
        builder.push_bind(*stock_location_id.as_uuid());
    }
    if let Some(status) = query.status {
        builder.push(" AND i.status = ");
        builder.push_bind(status.as_db_str());
    }
    if let Some(low_stock) = query.low_stock {
        if low_stock {
            builder.push(" AND i.quantity_on_hand_milli <= i.safety_stock_milli");
        } else {
            builder.push(" AND i.quantity_on_hand_milli > i.safety_stock_milli");
        }
    }
    if let Some(q) = query.q.as_ref().map(|q| q.trim()).filter(|q| !q.is_empty()) {
        let pattern = format!("%{q}%");
        builder.push(" AND (i.iv_code ILIKE ");
        builder.push_bind(pattern.clone());
        builder.push(" OR i.sku ILIKE ");
        builder.push_bind(pattern.clone());
        builder.push(" OR i.display_name ILIKE ");
        builder.push_bind(pattern);
        builder.push(")");
    }
    Ok(())
}

async fn fetch_location_tx(
    tx: &mut Transaction<'_, Postgres>,
    location_id: InventoryStockLocationId,
) -> Result<Option<InventoryStockLocationView>, PgInventoryError> {
    let row = sqlx::query(
        r#"
        SELECT id, branch_id, site_id, location_code, label, status, created_at, updated_at
        FROM inventory_stock_locations
        WHERE id = $1
        "#,
    )
    .bind(*location_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    row.as_ref().map(location_from_row).transpose()
}

async fn fetch_item_tx(
    tx: &mut Transaction<'_, Postgres>,
    item_id: InventoryItemId,
) -> Result<Option<InventoryItemView>, PgInventoryError> {
    fetch_item_inner_tx(tx, item_id, false).await
}

async fn fetch_item_for_update_tx(
    tx: &mut Transaction<'_, Postgres>,
    item_id: InventoryItemId,
) -> Result<Option<InventoryItemView>, PgInventoryError> {
    fetch_item_inner_tx(tx, item_id, true).await
}

async fn fetch_item_scoped_tx(
    tx: &mut Transaction<'_, Postgres>,
    item_id: InventoryItemId,
    branch_scope: &BranchScope,
) -> Result<Option<InventoryItemView>, PgInventoryError> {
    let mut builder = QueryBuilder::<Postgres>::new("SELECT ");
    builder.push(ITEM_COLUMNS);
    builder.push(
        " FROM inventory_items i JOIN inventory_stock_locations l \
         ON l.id = i.stock_location_id AND l.org_id = i.org_id WHERE i.id = ",
    );
    builder.push_bind(*item_id.as_uuid());
    builder.push(" AND ");
    push_branch_scope(&mut builder, branch_scope, "i.branch_id");
    let row = builder.build().fetch_optional(tx.as_mut()).await?;
    row.as_ref().map(item_from_row).transpose()
}

async fn fetch_item_inner_tx(
    tx: &mut Transaction<'_, Postgres>,
    item_id: InventoryItemId,
    for_update: bool,
) -> Result<Option<InventoryItemView>, PgInventoryError> {
    let mut sql = format!(
        "SELECT {ITEM_COLUMNS} FROM inventory_items i JOIN inventory_stock_locations l \
         ON l.id = i.stock_location_id AND l.org_id = i.org_id WHERE i.id = $1"
    );
    if for_update {
        sql.push_str(" FOR UPDATE OF i");
    }
    // Audited SQL-safe: `sql` is composed only from the `ITEM_COLUMNS` const and a
    // fixed `FOR UPDATE OF i` clause gated on the `for_update` bool. No runtime value
    // is interpolated — `item_id` is bound as $1 below.
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(*item_id.as_uuid())
        .fetch_optional(tx.as_mut())
        .await?;
    row.as_ref().map(item_from_row).transpose()
}

async fn resolve_consumption_source_tx(
    tx: &mut Transaction<'_, Postgres>,
    source: ConsumeInventorySource,
) -> Result<ResolvedConsumptionSource, PgInventoryError> {
    match source {
        ConsumeInventorySource::WorkOrder { work_order_id } => {
            let branch_id: Option<uuid::Uuid> =
                sqlx::query_scalar("SELECT branch_id FROM work_orders WHERE id = $1")
                    .bind(*work_order_id.as_uuid())
                    .fetch_optional(tx.as_mut())
                    .await?;
            let branch_id = branch_id
                .map(BranchId::from_uuid)
                .ok_or_else(|| KernelError::not_found("work order was not found"))?;
            Ok(ResolvedConsumptionSource {
                source: InventoryConsumptionSource::WorkOrder { work_order_id },
                branch_id,
            })
        }
        ConsumeInventorySource::P1Dispatch { dispatch_id } => {
            let row =
                sqlx::query("SELECT branch_id, work_order_id FROM p1_dispatches WHERE id = $1")
                    .bind(*dispatch_id.as_uuid())
                    .fetch_optional(tx.as_mut())
                    .await?;
            let row = row.ok_or_else(|| KernelError::not_found("P1 dispatch was not found"))?;
            let branch_id = BranchId::from_uuid(row.try_get("branch_id")?);
            let work_order_id = WorkOrderId::from_uuid(row.try_get("work_order_id")?);
            Ok(ResolvedConsumptionSource {
                source: InventoryConsumptionSource::P1Dispatch {
                    dispatch_id,
                    work_order_id,
                },
                branch_id,
            })
        }
    }
}

async fn fetch_event_tx(
    tx: &mut Transaction<'_, Postgres>,
    event_id: InventoryConsumptionEventId,
) -> Result<Option<InventoryConsumptionEventView>, PgInventoryError> {
    let row = sqlx::query(
        r#"
        SELECT e.id, e.item_id, i.iv_code, e.branch_id, e.stock_location_id,
               e.source_kind, e.work_order_id, e.dispatch_id,
               e.quantity_before_milli, e.quantity_consumed_milli, e.quantity_after_milli,
               e.unit_cost_won, e.cost_won, e.consumed_by, e.occurred_at, e.memo, e.created_at
        FROM inventory_consumption_events e
        JOIN inventory_items i ON i.id = e.item_id AND i.org_id = e.org_id
        WHERE e.id = $1
        "#,
    )
    .bind(*event_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    row.as_ref().map(event_from_row).transpose()
}

async fn fetch_event_by_idempotency_key_tx(
    tx: &mut Transaction<'_, Postgres>,
    idempotency_key: &str,
) -> Result<Option<(InventoryConsumptionEventView, String)>, PgInventoryError> {
    let row = sqlx::query(
        r#"
        SELECT e.id, e.item_id, i.iv_code, e.branch_id, e.stock_location_id,
               e.source_kind, e.work_order_id, e.dispatch_id,
               e.quantity_before_milli, e.quantity_consumed_milli, e.quantity_after_milli,
               e.unit_cost_won, e.cost_won, e.consumed_by, e.occurred_at, e.memo, e.created_at,
               e.request_fingerprint
        FROM inventory_consumption_events e
        JOIN inventory_items i ON i.id = e.item_id AND i.org_id = e.org_id
        WHERE e.idempotency_key = $1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(tx.as_mut())
    .await?;
    row.as_ref()
        .map(|row| Ok((event_from_row(row)?, row.try_get("request_fingerprint")?)))
        .transpose()
}

async fn lock_consumption_idempotency_key_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    idempotency_key: &str,
) -> Result<(), PgInventoryError> {
    // Transaction-scoped advisory locks release automatically on both commit
    // and rollback. PostgreSQL calculates one stable 64-bit identity from an
    // unambiguous, length-delimited raw `(org, normalized key)` composite.
    // Hash collisions can only over-serialize requests: raw event lookup,
    // `(org_id, idempotency_key)` uniqueness, and RLS still prevent a collision
    // from replaying or mutating another tenant/key's result.
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended(\
            char_length($1::text)::text || ':' || $1::text || \
            char_length($2::text)::text || ':' || $2::text, \
            0\
        ))",
    )
    .bind(org.to_string())
    .bind(idempotency_key)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

fn location_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<InventoryStockLocationView, PgInventoryError> {
    let status: String = row.try_get("status")?;
    let site_id: Option<uuid::Uuid> = row.try_get("site_id")?;
    Ok(InventoryStockLocationView {
        id: InventoryStockLocationId::from_uuid(row.try_get("id")?),
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        site_id: site_id.map(SiteId::from_uuid),
        location_code: row.try_get("location_code")?,
        label: row.try_get("label")?,
        status: InventoryItemStatus::parse(&status)?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn item_from_row(row: &sqlx::postgres::PgRow) -> Result<InventoryItemView, PgInventoryError> {
    let status: String = row.try_get("status")?;
    let site_id: Option<uuid::Uuid> = row.try_get("site_id")?;
    let quantity_on_hand_milli: i64 = row.try_get("quantity_on_hand_milli")?;
    let safety_stock_milli: i64 = row.try_get("safety_stock_milli")?;
    let id = InventoryItemId::from_uuid(row.try_get("id")?);
    Ok(InventoryItemView {
        id,
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        site_id: site_id.map(SiteId::from_uuid),
        stock_location: InventoryStockLocationSummary {
            id: InventoryStockLocationId::from_uuid(row.try_get("stock_location_id")?),
            label: row.try_get("stock_location_label")?,
        },
        iv_code: row.try_get("iv_code")?,
        sku: row.try_get("sku")?,
        display_name: row.try_get("display_name")?,
        description: row.try_get("description")?,
        unit_code: row.try_get("unit_code")?,
        quantity_on_hand_milli,
        safety_stock_milli,
        unit_cost_won: row.try_get("unit_cost_won")?,
        low_stock: quantity_on_hand_milli <= safety_stock_milli,
        status: InventoryItemStatus::parse(&status)?,
        href: format!("/inventory/items/{id}"),
        created_by: UserId::from_uuid(row.try_get("created_by")?),
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn event_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<InventoryConsumptionEventView, PgInventoryError> {
    let source_kind: String = row.try_get("source_kind")?;
    let work_order_id = WorkOrderId::from_uuid(row.try_get("work_order_id")?);
    let dispatch_id: Option<uuid::Uuid> = row.try_get("dispatch_id")?;
    let source = match source_kind.as_str() {
        "WORK_ORDER" => InventoryConsumptionSource::WorkOrder { work_order_id },
        "P1_DISPATCH" => InventoryConsumptionSource::P1Dispatch {
            dispatch_id: dispatch_id
                .map(P1DispatchId::from_uuid)
                .ok_or_else(|| KernelError::internal("P1 dispatch event missing dispatch_id"))?,
            work_order_id,
        },
        _ => return Err(KernelError::internal("unknown inventory event source_kind").into()),
    };
    Ok(InventoryConsumptionEventView {
        id: InventoryConsumptionEventId::from_uuid(row.try_get("id")?),
        item_id: InventoryItemId::from_uuid(row.try_get("item_id")?),
        iv_code: row.try_get("iv_code")?,
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        stock_location_id: InventoryStockLocationId::from_uuid(row.try_get("stock_location_id")?),
        source,
        quantity_before_milli: row.try_get("quantity_before_milli")?,
        quantity_consumed_milli: row.try_get("quantity_consumed_milli")?,
        quantity_after_milli: row.try_get("quantity_after_milli")?,
        unit_cost_won: row.try_get("unit_cost_won")?,
        cost_won: row.try_get("cost_won")?,
        consumed_by: UserId::from_uuid(row.try_get("consumed_by")?),
        occurred_at: row.try_get("occurred_at")?,
        memo: row.try_get("memo")?,
        created_at: row.try_get("created_at")?,
    })
}

fn item_state(item: &InventoryItemView) -> Result<InventoryItemState, KernelError> {
    Ok(InventoryItemState::new(
        item.id,
        item.branch_id,
        item.stock_location.id,
        item.status,
        QuantityMilli::new(item.quantity_on_hand_milli)?,
        SafetyStockMilli::new(item.safety_stock_milli)?,
        item.unit_cost_won.map(MoneyWon::new).transpose()?,
    ))
}

fn item_snapshot(item: &InventoryItemView) -> serde_json::Value {
    serde_json::json!({
        "id": item.id.to_string(),
        "iv_code": item.iv_code,
        "branch_id": item.branch_id.to_string(),
        "site_id": item.site_id.map(|id| id.to_string()),
        "stock_location_id": item.stock_location.id.to_string(),
        "sku": item.sku,
        "display_name": item.display_name,
        "unit_code": item.unit_code,
        "quantity_on_hand_milli": item.quantity_on_hand_milli,
        "safety_stock_milli": item.safety_stock_milli,
        "low_stock": item.low_stock,
        "status": item.status.as_db_str(),
    })
}

fn location_snapshot(location: &InventoryStockLocationView) -> serde_json::Value {
    serde_json::json!({
        "id": location.id.to_string(),
        "branch_id": location.branch_id.to_string(),
        "site_id": location.site_id.map(|id| id.to_string()),
        "location_code": location.location_code,
        "label": location.label,
        "status": location.status.as_db_str(),
    })
}

fn request_fingerprint(
    item_id: InventoryItemId,
    source: InventoryConsumptionSource,
    quantity: PositiveQuantityMilli,
    memo: Option<&str>,
    occurred_at: Option<time::OffsetDateTime>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(item_id.as_uuid().as_bytes());
    hasher.update(source.kind_db_str().as_bytes());
    hasher.update(source.work_order_id().as_uuid().as_bytes());
    if let Some(dispatch_id) = source.dispatch_id() {
        hasher.update(dispatch_id.as_uuid().as_bytes());
    }
    hasher.update(quantity.value().to_be_bytes());
    if let Some(memo) = memo {
        hasher.update(memo.as_bytes());
    }
    match occurred_at {
        Some(occurred_at) => {
            hasher.update(b"occurred_at:explicit");
            hasher.update(occurred_at.unix_timestamp_nanos().to_be_bytes());
        }
        // `requested_at` is server metadata, not a caller-controlled payload
        // field. Omitted `occurred_at` therefore has a stable presence tag and
        // deliberately contributes no generated timestamp to the fingerprint.
        None => hasher.update(b"occurred_at:omitted"),
    }
    hex::encode(hasher.finalize())
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

#[allow(dead_code)]
fn _org_id_type_anchor(_: OrgId) {}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use time::UtcOffset;

    #[test]
    fn occurrence_time_fingerprint_distinguishes_presence_and_canonicalizes_instants() {
        let item_id = InventoryItemId::from_uuid(uuid::Uuid::from_u128(1));
        let source = InventoryConsumptionSource::WorkOrder {
            work_order_id: WorkOrderId::from_uuid(uuid::Uuid::from_u128(2)),
        };
        let quantity = PositiveQuantityMilli::new(1).unwrap();
        let instant = time::OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        let same_instant_with_offset = instant.to_offset(UtcOffset::from_hms(9, 0, 0).unwrap());

        let omitted = request_fingerprint(item_id, source, quantity, None, None);
        let explicit = request_fingerprint(item_id, source, quantity, None, Some(instant));
        let canonical = request_fingerprint(
            item_id,
            source,
            quantity,
            None,
            Some(same_instant_with_offset),
        );
        assert_ne!(omitted, explicit, "presence is part of the fingerprint");
        assert_eq!(explicit, canonical, "the same instant hashes canonically");
    }
}
