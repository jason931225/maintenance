//! Contract guard for the consulting engagement route inventory.

#[test]
fn consulting_openapi_covers_the_closed_loop_routes() {
    let spec = include_str!("../../openapi/openapi.yaml");
    for path in [
        "/api/v1/consulting/engagements:",
        "/api/v1/consulting/engagements/{engagement_id}/diagnostics:",
        "/api/v1/consulting/engagements/{engagement_id}/findings:",
        "/api/v1/consulting/engagements/{engagement_id}/initiatives:",
        "/api/v1/consulting/engagements/{engagement_id}/transition:",
        "/api/v1/consulting/engagements/{engagement_id}/observations:",
        "/api/v1/consulting/engagements/{engagement_id}/history:",
    ] {
        assert!(spec.contains(path), "missing consulting route {path}");
    }
    assert!(spec.contains("expectedVersion"));
    assert!(spec.contains("kpi_definition_id"));
    assert!(spec.contains("evidence_id"));
}
