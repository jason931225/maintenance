//! Inventory application contracts: use-case DTOs, read models, source refs, and
//! audit event builders. Org scope is intentionally absent from commands; the
//! adapter derives it from the authenticated request context/current principal.

use mnt_inventory_domain::{InventoryConsumptionSource, InventoryItemStatus};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, InventoryConsumptionEventId, InventoryItemId,
    InventoryStockLocationId, KernelError, P1DispatchId, SiteId, Timestamp, TraceContext, UserId,
    WorkOrderId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryStockLocationView {
    pub id: InventoryStockLocationId,
    pub branch_id: BranchId,
    pub site_id: Option<SiteId>,
    pub location_code: Option<String>,
    pub label: String,
    pub status: InventoryItemStatus,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryStockLocationSummary {
    pub id: InventoryStockLocationId,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryItemView {
    pub id: InventoryItemId,
    pub branch_id: BranchId,
    pub site_id: Option<SiteId>,
    pub stock_location: InventoryStockLocationSummary,
    pub iv_code: String,
    pub sku: Option<String>,
    pub display_name: String,
    pub description: Option<String>,
    pub unit_code: String,
    pub quantity_on_hand_milli: i64,
    pub safety_stock_milli: i64,
    pub unit_cost_won: Option<i64>,
    pub low_stock: bool,
    pub status: InventoryItemStatus,
    pub href: String,
    pub created_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryItemPage {
    pub items: Vec<InventoryItemView>,
    pub limit: i64,
    pub offset: i64,
    pub total: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryConsumptionEventView {
    pub id: InventoryConsumptionEventId,
    pub item_id: InventoryItemId,
    pub iv_code: String,
    pub branch_id: BranchId,
    pub stock_location_id: InventoryStockLocationId,
    pub source: InventoryConsumptionSource,
    pub quantity_before_milli: i64,
    pub quantity_consumed_milli: i64,
    pub quantity_after_milli: i64,
    pub unit_cost_won: Option<i64>,
    pub cost_won: Option<i64>,
    pub consumed_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub occurred_at: Timestamp,
    pub memo: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryConsumptionResult {
    pub event: InventoryConsumptionEventView,
    pub item: InventoryItemView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListInventoryItemsQuery {
    pub branch_scope: BranchScope,
    pub branch_id: Option<BranchId>,
    pub site_id: Option<SiteId>,
    pub stock_location_id: Option<InventoryStockLocationId>,
    pub status: Option<InventoryItemStatus>,
    pub low_stock: Option<bool>,
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListConsumptionEventsQuery {
    pub branch_scope: BranchScope,
    pub item_id: InventoryItemId,
    pub source_kind: Option<String>,
    pub work_order_id: Option<WorkOrderId>,
    pub dispatch_id: Option<P1DispatchId>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateStockLocationCommand {
    pub actor: UserId,
    pub branch_scope: BranchScope,
    pub branch_id: BranchId,
    pub site_id: Option<SiteId>,
    pub location_code: Option<String>,
    pub label: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateInventoryItemCommand {
    pub actor: UserId,
    pub branch_scope: BranchScope,
    pub branch_id: BranchId,
    pub stock_location_id: InventoryStockLocationId,
    pub sku: Option<String>,
    pub display_name: String,
    pub description: Option<String>,
    pub unit_code: String,
    pub quantity_on_hand_milli: i64,
    pub safety_stock_milli: i64,
    pub unit_cost_won: Option<i64>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateInventoryItemFields {
    pub sku: Option<Option<String>>,
    pub display_name: Option<String>,
    pub description: Option<Option<String>>,
    pub safety_stock_milli: Option<i64>,
    pub status: Option<InventoryItemStatus>,
}

impl UpdateInventoryItemFields {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.sku.is_none()
            && self.display_name.is_none()
            && self.description.is_none()
            && self.safety_stock_milli.is_none()
            && self.status.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateInventoryItemCommand {
    pub actor: UserId,
    pub branch_scope: BranchScope,
    pub item_id: InventoryItemId,
    pub fields: UpdateInventoryItemFields,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConsumeInventorySource {
    WorkOrder { work_order_id: WorkOrderId },
    P1Dispatch { dispatch_id: P1DispatchId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsumeInventoryCommand {
    pub actor: UserId,
    pub branch_scope: BranchScope,
    pub item_id: InventoryItemId,
    pub source: ConsumeInventorySource,
    pub quantity_consumed_milli: i64,
    pub occurred_at: Option<Timestamp>,
    pub memo: Option<String>,
    pub idempotency_key: String,
    pub trace: TraceContext,
    pub requested_at: Timestamp,
}

pub fn inventory_audit_event(
    action: &str,
    actor: Option<UserId>,
    branch_id: Option<BranchId>,
    target_type: &str,
    target_id: impl ToString,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    let mut event = AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        target_type,
        target_id.to_string(),
        trace,
        occurred_at,
    );
    if let Some(branch_id) = branch_id {
        event = event.with_branch(branch_id);
    }
    Ok(event)
}
