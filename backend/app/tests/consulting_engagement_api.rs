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
    assert!(spec.contains("idempotently replayed original response"));
    assert!(spec.contains("Idempotency key was previously used with a different request payload"));
}

/// Buck-ready database-contract coverage: the integration database applies this
/// migration before REST tests, so keep every fail-closed invariant explicit.
#[test]
fn consulting_database_contract_enforces_tenant_reference_and_replay_boundaries() {
    let migration =
        include_str!("../../crates/platform/db/migrations/0174_create_consulting_engagements.sql");
    for clause in [
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
        "idempotency_request_hash",
        "idempotency_response_status",
        "idempotency_response JSONB",
        "consulting_require_reference_kinds",
        "'customer_document_id', 'DOCUMENT'",
        "'ontology_instance_id', 'ONTOLOGY_INSTANCE'",
        "'evidence_id', 'EVIDENCE'",
        "'kpi_definition_id', 'KPI_DEFINITION'",
        "trg_consulting_history_no_update",
        "trg_consulting_history_no_delete",
        "terminal consulting engagement is immutable",
    ] {
        assert!(
            migration.contains(clause),
            "missing database invariant: {clause}"
        );
    }
}

#[test]
fn consulting_rest_contract_uses_atomic_replay_sod_and_terminal_guards() {
    let rest = include_str!("../../crates/consulting/rest/src/lib.rs");
    for clause in [
        "ON CONFLICT (org_id, idempotency_key) DO NOTHING",
        "idempotency key was already used with a different request payload",
        "idempotency_response",
        "require_reference_kind",
        "a.target_ref=$4",
        "a.requested_by <> $2",
        "ON CONFLICT (org_id, approval_id) DO NOTHING",
        "ensure_writable_engagement",
        "ORDER BY occurred_at,id",
    ] {
        assert!(
            rest.contains(clause),
            "missing REST/database integration guard: {clause}"
        );
    }
}
