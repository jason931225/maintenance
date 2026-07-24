//! Tenant-armed persistence for the bounded logistics pilot.
//!
//! All mutations use `with_audits`: stock reservations, state changes, history,
//! and the audit chain commit together.  Quantities are integer operational
//! units; the database is the final no-negative-stock guard.
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, ErrorKind, KernelError, OrgId, TraceContext, UserId,
};
use mnt_platform_db::{DbError, with_audits, with_org_conn};
use mnt_platform_request_context::current_org;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum PgLogisticsError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Domain(#[from] KernelError),
}
impl From<sqlx::Error> for PgLogisticsError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}
impl PgLogisticsError {
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(e) => e.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(DbError::Sqlx(sqlx::Error::Database(e)))
                if e.code().as_deref() == Some("23505") =>
            {
                ErrorKind::Conflict
            }
            _ => ErrorKind::Internal,
        }
    }
}
#[derive(Debug, Clone)]
pub struct PgLogisticsStore {
    pool: PgPool,
}
impl PgLogisticsStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn create_asn(
        &self,
        actor: UserId,
        branch: BranchId,
        warehouse: String,
        reference: String,
        sku: String,
        expected: i64,
    ) -> Result<Value, PgLogisticsError> {
        required(&warehouse, "warehouse_code", 80)?;
        required(&reference, "external_reference", 120)?;
        required(&sku, "sku", 80)?;
        if expected <= 0 {
            return Err(KernelError::validation("expected_quantity must be positive").into());
        }
        let org = current_org().map_err(KernelError::from)?;
        let id = Uuid::new_v4();
        let now = OffsetDateTime::now_utc();
        with_audits(&self.pool, org, |tx| Box::pin(async move { sqlx::query("INSERT INTO logistics_asns (id,org_id,branch_id,warehouse_code,external_reference,sku,expected_quantity,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)").bind(id).bind(*org.as_uuid()).bind(*branch.as_uuid()).bind(&warehouse).bind(&reference).bind(&sku).bind(expected).bind(*actor.as_uuid()).bind(now).execute(tx.as_mut()).await?; let out=json!({"id":id,"status":"EXPECTED","branchId":branch}); Ok((out, vec![audit(org, actor, branch, "logistics.asn.create", "logistics_asn", id, now)])) })).await
    }

    pub async fn receive(
        &self,
        actor: UserId,
        asn: Uuid,
        quantity: i64,
        key: String,
        fingerprint_input: &Value,
    ) -> Result<Value, PgLogisticsError> {
        idem(&key)?;
        if quantity <= 0 {
            return Err(KernelError::validation("received_quantity must be positive").into());
        }
        let org = current_org().map_err(KernelError::from)?;
        let now = OffsetDateTime::now_utc();
        let fp = fingerprint(fingerprint_input);
        with_audits(&self.pool, org, |tx| Box::pin(async move {
            if let Some(row)=sqlx::query("SELECT r.request_fingerprint,a.id,a.status,a.branch_id,a.received_quantity,a.expected_quantity FROM logistics_receipts r JOIN logistics_asns a ON a.id=r.asn_id AND a.org_id=r.org_id WHERE r.org_id=$1 AND r.idempotency_key=$2").bind(*org.as_uuid()).bind(&key).fetch_optional(tx.as_mut()).await? { let prior:String=row.try_get("request_fingerprint")?; if prior != fp { return Err(KernelError::conflict("idempotency key was reused with a different request").into()); } return Ok((json!({"id":asn,"status":row.try_get::<String,_>("status")?,"replayed":true}),vec![])); }
            let row=sqlx::query("SELECT branch_id, expected_quantity, received_quantity, status FROM logistics_asns WHERE id=$1 FOR UPDATE").bind(asn).fetch_optional(tx.as_mut()).await?.ok_or_else(|| KernelError::not_found("ASN was not found"))?; let branch=BranchId::from_uuid(row.try_get("branch_id")?); let expected:i64=row.try_get("expected_quantity")?; let prior:i64=row.try_get("received_quantity")?; let status:String=row.try_get("status")?; if status != "EXPECTED" && status != "PARTIAL_RECEIVED" { return Err(KernelError::conflict("ASN cannot receive in its current state").into()); } let total=prior.checked_add(quantity).ok_or_else(|| KernelError::validation("receipt quantity overflow"))?; if total>expected { return Err(KernelError::conflict("receipt exceeds ASN expected quantity").into()); } let next=if total==expected {"RECEIVED"} else {"PARTIAL_RECEIVED"};
            sqlx::query("UPDATE logistics_asns SET received_quantity=$1,status=$2,updated_at=$3 WHERE id=$4").bind(total).bind(next).bind(now).bind(asn).execute(tx.as_mut()).await?; sqlx::query("INSERT INTO logistics_receipts (org_id,branch_id,asn_id,received_quantity,exception_code,received_by,received_at,idempotency_key,request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(*org.as_uuid()).bind(*branch.as_uuid()).bind(asn).bind(quantity).bind((total<expected).then_some("PARTIAL_RECEIPT")).bind(*actor.as_uuid()).bind(now).bind(&key).bind(&fp).execute(tx.as_mut()).await?;
            Ok((json!({"id":asn,"status":next,"receivedQuantity":total}),vec![audit(org,actor,branch,"logistics.asn.receive","logistics_asn",asn,now)])) })).await
    }

    pub async fn putaway(&self, actor: UserId, asn: Uuid) -> Result<Value, PgLogisticsError> {
        let org = current_org().map_err(KernelError::from)?;
        let now = OffsetDateTime::now_utc();
        with_audits(&self.pool,org,|tx|Box::pin(async move { let row=sqlx::query("SELECT branch_id,warehouse_code,sku,received_quantity,status FROM logistics_asns WHERE id=$1 FOR UPDATE").bind(asn).fetch_optional(tx.as_mut()).await?.ok_or_else(||KernelError::not_found("ASN was not found"))?; let branch=BranchId::from_uuid(row.try_get("branch_id")?); let status:String=row.try_get("status")?; if status!="RECEIVED" && status!="PARTIAL_RECEIVED" { return Err(KernelError::conflict("only received ASN may be put away").into()); } let warehouse:String=row.try_get("warehouse_code")?; let sku:String=row.try_get("sku")?; let qty:i64=row.try_get("received_quantity")?; sqlx::query("INSERT INTO logistics_stock (org_id,branch_id,warehouse_code,sku,quantity_on_hand,quantity_reserved,updated_at) VALUES ($1,$2,$3,$4,$5,0,$6) ON CONFLICT (org_id,branch_id,warehouse_code,sku) DO UPDATE SET quantity_on_hand=logistics_stock.quantity_on_hand+EXCLUDED.quantity_on_hand,updated_at=EXCLUDED.updated_at").bind(*org.as_uuid()).bind(*branch.as_uuid()).bind(&warehouse).bind(&sku).bind(qty).bind(now).execute(tx.as_mut()).await?; sqlx::query("UPDATE logistics_asns SET status='PUTAWAY',updated_at=$1 WHERE id=$2").bind(now).bind(asn).execute(tx.as_mut()).await?; Ok((json!({"id":asn,"status":"PUTAWAY"}),vec![audit(org,actor,branch,"logistics.asn.putaway","logistics_asn",asn,now)]))})).await
    }

    pub async fn release(
        &self,
        actor: UserId,
        branch: BranchId,
        warehouse: String,
        sku: String,
        quantity: i64,
        due_at: OffsetDateTime,
    ) -> Result<Value, PgLogisticsError> {
        if quantity <= 0 {
            return Err(KernelError::validation("requested_quantity must be positive").into());
        }
        let org = current_org().map_err(KernelError::from)?;
        let id = Uuid::new_v4();
        let now = OffsetDateTime::now_utc();
        with_audits(&self.pool,org,|tx|Box::pin(async move {let changed=sqlx::query("UPDATE logistics_stock SET quantity_reserved=quantity_reserved+$1,updated_at=$2 WHERE org_id=$3 AND branch_id=$4 AND warehouse_code=$5 AND sku=$6 AND quantity_on_hand-quantity_reserved >= $1").bind(quantity).bind(now).bind(*org.as_uuid()).bind(*branch.as_uuid()).bind(&warehouse).bind(&sku).execute(tx.as_mut()).await?.rows_affected();if changed!=1{return Err(KernelError::conflict("insufficient available logistics stock").into())}sqlx::query("INSERT INTO logistics_fulfillments (id,org_id,branch_id,warehouse_code,sku,requested_quantity,reserved_quantity,due_at,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$9)").bind(id).bind(*org.as_uuid()).bind(*branch.as_uuid()).bind(&warehouse).bind(&sku).bind(quantity).bind(due_at).bind(*actor.as_uuid()).bind(now).execute(tx.as_mut()).await?;history(tx,org,branch,id,"fulfillment","RELEASED",actor,now).await?;Ok((json!({"id":id,"status":"RELEASED","reservedQuantity":quantity}),vec![audit(org,actor,branch,"logistics.fulfillment.release","logistics_fulfillment",id,now)]))})).await
    }

    pub async fn pick_pack(
        &self,
        actor: UserId,
        fulfillment: Uuid,
        picked: Option<i64>,
        pack: bool,
    ) -> Result<Value, PgLogisticsError> {
        let org = current_org().map_err(KernelError::from)?;
        let now = OffsetDateTime::now_utc();
        with_audits(&self.pool,org,|tx|Box::pin(async move {let row=sqlx::query("SELECT branch_id,reserved_quantity,picked_quantity,status FROM logistics_fulfillments WHERE id=$1 FOR UPDATE").bind(fulfillment).fetch_optional(tx.as_mut()).await?.ok_or_else(||KernelError::not_found("fulfillment was not found"))?;let branch=BranchId::from_uuid(row.try_get("branch_id")?);let state:String=row.try_get("status")?;let reserved:i64=row.try_get("reserved_quantity")?;let (next,picked_qty)=if pack {if state!="PICKED"&&state!="SHORT_PICK" {return Err(KernelError::conflict("only picked fulfillment may be packed").into())}("PACKED",row.try_get("picked_quantity")?)} else {if state!="RELEASED" {return Err(KernelError::conflict("only released fulfillment may be picked").into())}let p=picked.ok_or_else(||KernelError::validation("pickedQuantity is required"))?;if p<0||p>reserved{return Err(KernelError::validation("pickedQuantity is outside reserved stock").into())}(if p==reserved{"PICKED"}else{"SHORT_PICK"},p)};sqlx::query("UPDATE logistics_fulfillments SET status=$1,picked_quantity=$2,updated_at=$3 WHERE id=$4").bind(next).bind(picked_qty).bind(now).bind(fulfillment).execute(tx.as_mut()).await?;history(tx,org,branch,fulfillment,"fulfillment",next,actor,now).await?;Ok((json!({"id":fulfillment,"status":next,"pickedQuantity":picked_qty}),vec![audit(org,actor,branch,if pack{"logistics.fulfillment.pack"}else{"logistics.fulfillment.pick"},"logistics_fulfillment",fulfillment,now)]))})).await
    }
}
fn required(value: &str, name: &str, max: usize) -> Result<(), PgLogisticsError> {
    if value.trim().is_empty() || value.chars().count() > max {
        Err(KernelError::validation(format!("{name} is required and bounded")).into())
    } else {
        Ok(())
    }
}
fn idem(key: &str) -> Result<(), PgLogisticsError> {
    if key.trim().len() < 16 || key.len() > 200 {
        Err(KernelError::validation("Idempotency-Key must be 16..200 characters").into())
    } else {
        Ok(())
    }
}
fn fingerprint(v: &Value) -> String {
    let mut h = Sha256::new();
    h.update(v.to_string());
    format!("{:x}", h.finalize())
}
fn audit(
    org: OrgId,
    actor: UserId,
    branch: BranchId,
    action: &str,
    kind: &str,
    id: Uuid,
    at: OffsetDateTime,
) -> AuditEvent {
    AuditEvent::new(
        Some(actor),
        AuditAction::new(action).expect("literal audit action"),
        kind,
        id.to_string(),
        TraceContext::generate(),
        at,
    )
    .with_org(org)
    .with_branch(branch)
}
async fn history(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    branch: BranchId,
    id: Uuid,
    kind: &str,
    transition: &str,
    actor: UserId,
    at: OffsetDateTime,
) -> Result<(), PgLogisticsError> {
    sqlx::query("INSERT INTO logistics_history (org_id,branch_id,aggregate_kind,aggregate_id,transition,actor_id,occurred_at,trace_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)").bind(*org.as_uuid()).bind(*branch.as_uuid()).bind(kind).bind(id).bind(transition).bind(*actor.as_uuid()).bind(at).bind(Uuid::new_v4()).execute(tx.as_mut()).await?;
    Ok(())
}
