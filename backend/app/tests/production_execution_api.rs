//! Contract guard for the production-execution API surface.
//!
//! The database-backed lifecycle is exercised by the production REST crate's
//! request-context/RLS integration path; this app-level guard makes accidental
//! route de-registration visible alongside the assembled router inventory.

use mnt_app::CONFIGURED_ROUTE_SURFACES;
use mnt_production_rest::{
    PRODUCTION_OPERATION_RECORDS_PATH, PRODUCTION_PLAN_PATH, PRODUCTION_PLAN_RELEASE_PATH,
    PRODUCTION_PLANS_PATH,
};

#[test]
fn production_execution_routes_are_assembled_and_contract_stable() {
    let production = CONFIGURED_ROUTE_SURFACES
        .iter()
        .find(|surface| surface.name == "production")
        .expect("production router must be mounted in the application");
    assert_eq!(
        production.paths,
        [
            PRODUCTION_PLANS_PATH,
            PRODUCTION_PLAN_PATH,
            PRODUCTION_PLAN_RELEASE_PATH,
            PRODUCTION_OPERATION_RECORDS_PATH,
        ]
    );
}
