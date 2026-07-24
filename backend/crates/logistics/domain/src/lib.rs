//! Logistics-pilot finite-state vocabulary.  The pilot has one warehouse leg;
//! its state machine intentionally has no routing, valuation, or finance edge.
use mnt_kernel_core::KernelError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FulfillmentState {
    Released,
    Picked,
    ShortPick,
    Packed,
    Dispatched,
    Delivered,
    Settled,
}
impl FulfillmentState {
    pub fn can_transition_to(self, next: Self) -> Result<(), KernelError> {
        let allowed = matches!(
            (self, next),
            (Self::Released, Self::Picked | Self::ShortPick)
                | (Self::Picked | Self::ShortPick, Self::Packed)
                | (Self::Packed, Self::Dispatched)
                | (Self::Dispatched, Self::Delivered)
                | (Self::Delivered, Self::Settled)
        );
        if allowed {
            Ok(())
        } else {
            Err(KernelError::conflict("illegal logistics state transition"))
        }
    }
}
