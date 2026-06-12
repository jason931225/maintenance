use mnt_kernel_core::{BranchId, UserId, WorkOrderId};
use sqlx::PgPool;

pub async fn seed_branch(pool: &PgPool, region_name: &str, branch_name: &str) -> BranchId {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name) VALUES ($1) RETURNING id")
            .bind(region_name)
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO branches (region_id, name) VALUES ($1, $2) RETURNING id")
            .bind(region_id)
            .bind(branch_name)
            .fetch_one(pool)
            .await
            .unwrap();
    BranchId::from_uuid(branch_id)
}

pub async fn seed_user_with_branch(
    pool: &PgPool,
    user_id: UserId,
    role: &str,
    branch_id: BranchId,
) {
    sqlx::query("INSERT INTO users (id, display_name, roles) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(format!("Evidence API {role}"))
        .bind(Vec::from([role]))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

pub async fn seed_equipment(pool: &PgPool, branch_id: BranchId, management_no: &str) -> uuid::Uuid {
    let equipment_suffix = format!("{:0>4}", management_no);
    let customer_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name) VALUES ($1, $2) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(format!("Evidence Customer {management_no}"))
    .fetch_one(pool)
    .await
    .unwrap();
    let site_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, name) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(format!("Evidence Site {management_no}"))
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query_scalar(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, model, source_sheet, source_row
        )
        VALUES ($1, $2, $3, $4, $5,
                'A', 'B', 'C', '임대', '좌식', '2.5', 'GTS25DE', 'test', 1)
        RETURNING id
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(format!("ABC12-{equipment_suffix}"))
    .bind(management_no)
    .fetch_one(pool)
    .await
    .unwrap()
}

pub async fn seed_assigned_work_order(
    pool: &PgPool,
    branch_id: BranchId,
    equipment_id: uuid::Uuid,
    receptionist: UserId,
    mechanic: UserId,
) -> WorkOrderId {
    let work_order_id = WorkOrderId::new();
    sqlx::query(
        r#"
        INSERT INTO work_orders (
            id, request_no, branch_id, equipment_id, customer_id, site_id,
            requested_by, status, priority, symptom
        )
        SELECT $1, '20260612-802', $2, e.id, e.customer_id, e.site_id,
               $3, 'ASSIGNED', 'UNSET', 'Evidence mobile fixture'
        FROM registry_equipment e
        WHERE e.id = $4
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(*branch_id.as_uuid())
    .bind(*receptionist.as_uuid())
    .bind(equipment_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO work_order_assignments (work_order_id, mechanic_id, role, assigned_at)
        VALUES ($1, $2, 'PRIMARY', now())
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(*mechanic.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    work_order_id
}
