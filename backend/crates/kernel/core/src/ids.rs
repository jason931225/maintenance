//! Typed UUID newtypes. A `WorkOrderId` can never be passed where a `UserId`
//! is expected; the type system carries the discipline the prior project kept
//! in naming conventions.

/// Defines a UUID-backed ID newtype with serde, parsing, and display.
macro_rules! typed_id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash,
            serde::Serialize, serde::Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(uuid::Uuid);

        impl $name {
            /// Generates a fresh random ID.
            #[must_use]
            pub fn new() -> Self {
                Self(uuid::Uuid::new_v4())
            }

            #[must_use]
            pub const fn from_uuid(value: uuid::Uuid) -> Self {
                Self(value)
            }

            #[must_use]
            pub const fn as_uuid(&self) -> &uuid::Uuid {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }

        impl std::str::FromStr for $name {
            type Err = uuid::Error;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self(uuid::Uuid::parse_str(s)?))
            }
        }

        impl From<$name> for uuid::Uuid {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

typed_id!(
    /// An organizational branch (지점). Day-1 scoping concept: every
    /// work order, user membership, equipment row, KPI rollup, and chat
    /// team-channel carries one.
    BranchId
);
typed_id!(
    /// A region (지역) grouping branches (수도권/충청/영남/호남 rollout units).
    RegionId
);
typed_id!(UserId);
typed_id!(EquipmentId);
typed_id!(CustomerId);
typed_id!(SiteId);
typed_id!(WorkOrderId);
typed_id!(AssignmentId);
typed_id!(EquipmentSubstitutionId);
typed_id!(ApprovalId);
typed_id!(DailyPlanId);
typed_id!(ConsentId);
typed_id!(LocationPingId);
typed_id!(P1DispatchId);
typed_id!(P1DispatchResponseId);
typed_id!(P1DispatchAlertId);
typed_id!(ThreadId);
typed_id!(MessageId);
typed_id!(EvidenceId);
typed_id!(DeviceId);
typed_id!(VendorId);
typed_id!(QuoteId);
typed_id!(PurchaseRequestId);
typed_id!(InspectionId);
typed_id!(InspectionScheduleId);
typed_id!(InspectionRoundId);
typed_id!(AuditEventId);

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn ids_are_distinct_types_and_roundtrip_serde() {
        let id = WorkOrderId::new();
        let json = serde_json::to_string(&id).unwrap();
        let back: WorkOrderId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, back);
        // transparent serde: plain UUID string, no wrapper object
        assert!(json.starts_with('"') && json.ends_with('"'));
    }

    #[test]
    fn ids_parse_from_canonical_uuid_strings() {
        let id = BranchId::new();
        let parsed = BranchId::from_str(&id.to_string()).unwrap();
        assert_eq!(id, parsed);
    }

    #[test]
    fn invalid_uuid_string_is_rejected() {
        assert!(UserId::from_str("not-a-uuid").is_err());
    }

    #[test]
    fn fresh_ids_are_unique() {
        assert_ne!(UserId::new(), UserId::new());
    }
}
