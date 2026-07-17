use std::collections::BTreeSet;

use mnt_app::{AUDIT_ROUTE_PATH, CONFIGURED_ROUTE_SURFACES};

#[test]
fn configured_route_surface_is_nonempty_unique_and_api_scoped() {
    assert_eq!(AUDIT_ROUTE_PATH, "/api/audit");
    assert!(!CONFIGURED_ROUTE_SURFACES.is_empty());
    let mut names = BTreeSet::new();
    for surface in CONFIGURED_ROUTE_SURFACES {
        assert!(names.insert(surface.name), "duplicate route surface {}", surface.name);
        assert!(!surface.paths.is_empty(), "empty route surface {}", surface.name);
        assert!(
            surface.paths.iter().all(|path| path.starts_with("/api/")),
            "non-API route in surface {}",
            surface.name,
        );
    }
}
