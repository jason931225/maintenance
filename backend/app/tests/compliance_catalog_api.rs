//! Contract regression lock for the real compliance catalog REST surface.
//!
//! Full request/reply, RLS, PBAC, and audit execution requires the application
//! database fixture and is run by the integration train. This fast source-level
//! gate keeps every mounted catalog route discoverable by the app router.

#[test]
fn compliance_catalog_routes_are_registered() {
    for route in [
        "/api/v1/compliance/regulations",
        "/api/v1/compliance/obligations",
        "/api/v1/compliance/obligation-regulation-links",
        "/api/v1/compliance/frameworks",
        "/api/v1/compliance/framework-controls",
        "/api/v1/compliance/control-obligation-coverage",
        "/api/v1/compliance/evidence-bindings",
    ] {
        assert!(
            mnt_compliance_rest::COMPLIANCE_ROUTE_PATHS.contains(&route),
            "missing compliance catalog route {route}",
        );
    }
}
