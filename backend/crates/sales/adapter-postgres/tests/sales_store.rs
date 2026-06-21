#![allow(clippy::unwrap_used)]

use mnt_kernel_core::{CustomerInquiryId, OrgId, SalesListingId, TraceContext, UserId};
use mnt_sales_adapter_postgres::PgSalesStore;
use mnt_sales_application::{
    CatalogQuery, CreateListingCommand, InquiryInboxQuery, ListingInput, SubmitInquiryCommand,
    UpdateInquiryStatusCommand, UpdateListingCommand, UpdateListingFields,
};
use mnt_sales_domain::{InquiryStatus, InquiryTopic, ListingKind, ListingStatus, ListingType};
use sqlx::PgPool;
use time::macros::datetime;

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn listing_and_inquiry_lifecycle_is_tenant_scoped_and_audited(pool: PgPool) {
    mnt_platform_request_context::scope_org(OrgId::knl(), async move {
        let actor = seed_user(&pool).await;
        let store = PgSalesStore::new(pool.clone());

        // A DRAFT listing.
        let listing_id = SalesListingId::new();
        store
            .create_listing(CreateListingCommand {
                actor,
                listing_id,
                input: ListingInput {
                    kind: ListingKind::Electric,
                    model_name: "전동 지게차 2.5톤".into(),
                    capacity_milli: Some(2500),
                    model_year: Some(2021),
                    usage_hours: Some(1200),
                    price_won: Some(12_000_000),
                    badge: Some("실내 창고 추천".into()),
                    usage_label: Some("물류창고".into()),
                    condition_label: Some("검수 완료".into()),
                    availability: Some("렌탈·구매 가능".into()),
                    location: Some("창원".into()),
                    description: None,
                    listing_type: ListingType::Both,
                    status: ListingStatus::Draft,
                    sort_weight: 10,
                    equipment_id: None,
                },
                trace: TraceContext::generate(),
                occurred_at: datetime!(2026-06-21 09:00:00 UTC),
            })
            .await
            .unwrap();

        // Admin sees the draft; the public catalog does not.
        assert_eq!(store.list_listings(catalog(true)).await.unwrap().total, 1);
        assert_eq!(
            store.list_listings(catalog(false)).await.unwrap().total,
            0,
            "draft is hidden from the public catalog"
        );

        // Publish + reprice.
        let fields = UpdateListingFields {
            status: Some(ListingStatus::Published),
            price_won: Some(Some(11_500_000)),
            ..UpdateListingFields::default()
        };
        store
            .update_listing(UpdateListingCommand {
                actor,
                listing_id,
                fields,
                trace: TraceContext::generate(),
                occurred_at: datetime!(2026-06-21 10:00:00 UTC),
            })
            .await
            .unwrap();
        let public = store.list_listings(catalog(false)).await.unwrap();
        assert_eq!(public.total, 1, "published listing is public");
        assert_eq!(public.items[0].price_won, Some(11_500_000));
        assert_eq!(public.items[0].kind, ListingKind::Electric);

        // A public inquiry against the listing.
        let inquiry_id = CustomerInquiryId::new();
        store
            .submit_inquiry(SubmitInquiryCommand {
                inquiry_id,
                name: "홍길동".into(),
                phone: "010-1234-5678".into(),
                topic: InquiryTopic::UsedSales,
                location: Some("창원".into()),
                message: Some("2.5톤 전동 재고 문의".into()),
                listing_id: Some(listing_id),
                trace: TraceContext::generate(),
                occurred_at: datetime!(2026-06-21 11:00:00 UTC),
            })
            .await
            .unwrap();
        let inbox = store
            .list_inquiries(InquiryInboxQuery {
                status: None,
                limit: 50,
                offset: 0,
            })
            .await
            .unwrap();
        assert_eq!(inbox.total, 1);
        assert_eq!(inbox.items[0].name, "홍길동");
        assert_eq!(inbox.items[0].status, InquiryStatus::New);

        // The inquiry audit snapshot is PII-LIGHT: no name/phone leaked into it.
        let pii_in_audit: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events \
             WHERE action = 'sales_inquiry.submit' \
               AND COALESCE(after_snap::text, '') ~ '(홍길동|010-1234)'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(pii_in_audit, 0, "no PII in the inquiry audit snapshot");

        // Triage the inquiry.
        store
            .update_inquiry_status(UpdateInquiryStatusCommand {
                actor,
                inquiry_id,
                status: InquiryStatus::Contacted,
                trace: TraceContext::generate(),
                occurred_at: datetime!(2026-06-21 12:00:00 UTC),
            })
            .await
            .unwrap();
        let inbox = store
            .list_inquiries(InquiryInboxQuery {
                status: Some(InquiryStatus::Contacted),
                limit: 50,
                offset: 0,
            })
            .await
            .unwrap();
        assert_eq!(inbox.total, 1);
        assert_eq!(inbox.items[0].status, InquiryStatus::Contacted);
    })
    .await;
}

fn catalog(include_non_public: bool) -> CatalogQuery {
    CatalogQuery {
        kind: None,
        listing_type: None,
        include_non_public,
        limit: 50,
        offset: 0,
    }
}

async fn seed_user(pool: &PgPool) -> UserId {
    let id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind("Sales Admin")
    .bind(vec!["ADMIN".to_string()])
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    UserId::from_uuid(id)
}
