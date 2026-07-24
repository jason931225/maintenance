//! HTTP-independent contracts for the logistics pilot.  `org_id` is absent by
//! design: the adapter derives it from the authenticated request context.
use mnt_kernel_core::{BranchId, UserId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAsn {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub warehouse_code: String,
    pub external_reference: String,
    pub sku: String,
    pub expected_quantity: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub actor: UserId,
    pub asn_id: Uuid,
    pub quantity: i64,
    pub idempotency_key: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub warehouse_code: String,
    pub sku: String,
    pub quantity: i64,
    pub due_at: time::OffsetDateTime,
    pub idempotency_key: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PilotView {
    pub id: Uuid,
    pub status: String,
    pub branch_id: BranchId,
}
