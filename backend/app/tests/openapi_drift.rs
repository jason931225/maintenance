use std::collections::{BTreeMap, BTreeSet};

use mnt_app::{AUDIT_ROUTE_PATH, CONFIGURED_ROUTE_SURFACES};
use mnt_platform_rest::PLATFORM_ROUTE_OPERATIONS;

const OPENAPI_YAML: &str = include_str!("../../openapi/openapi.yaml");
const REQUIRED_CONFIGURED_SURFACES: &[&str] = &[
    "audit",
    "attendance",
    "inventory",
    "dispatch",
    "benefit",
    "financial",
    "integrity",
    "hr",
    "workflow-studio",
    "collaboration",
    "sales",
    "workorder",
    "workorder-mobile",
    "comms",
    "platform",
    "auth",
    "realtime",
    "ontology",
    "governance",
    "policy",
];

struct RouteSource {
    name: &'static str,
    surface: &'static str,
    source: &'static str,
    ignored_route_refs: &'static [&'static str],
}

const CONFIGURED_ROUTE_SOURCES: &[RouteSource] = &[
    RouteSource {
        name: "attendance REST router",
        surface: "attendance",
        source: include_str!("../../crates/attendance/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "inventory REST router",
        surface: "inventory",
        source: include_str!("../../crates/inventory/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "dispatch REST router",
        surface: "dispatch",
        source: include_str!("../../crates/dispatch/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "benefit REST router",
        surface: "benefit",
        source: include_str!("../../crates/benefit/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "financial REST router",
        surface: "financial",
        source: include_str!("../../crates/financial/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "inspection REST router",
        surface: "inspection",
        source: include_str!("../../crates/inspection/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "support REST router",
        surface: "support",
        source: include_str!("../../crates/support/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "identity REST router",
        surface: "identity",
        source: include_str!("../../crates/identity/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "compliance REST router",
        surface: "compliance",
        source: include_str!("../../crates/compliance/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "integrity REST router",
        surface: "integrity",
        source: include_str!("../../crates/compliance/integrity/src/rest.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "registry REST router",
        surface: "registry",
        source: include_str!("../../crates/registry/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "HR app router",
        surface: "hr",
        source: include_str!("../src/hr.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "Workflow Studio app router",
        surface: "workflow-studio",
        source: include_str!("../src/workflow_studio.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "collaboration app router",
        surface: "collaboration",
        source: include_str!("../src/collaboration.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "sales REST router",
        surface: "sales",
        source: include_str!("../../crates/sales/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "reporting REST router",
        surface: "reporting",
        source: include_str!("../../crates/reporting/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "workorder REST routers",
        surface: "workorder",
        source: include_str!("../../crates/workorder/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "messenger REST router",
        surface: "messenger",
        source: include_str!("../../crates/messenger/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "comms REST router",
        surface: "comms",
        source: include_str!("../../crates/comms/rest/src/lib.rs"),
        // The MOX inbound webhook authenticates with a provider HMAC secret (not a
        // customer session) and is deliberately absent from the customer OpenAPI +
        // SDK clients; keep it out of the drift inventory intentionally.
        ignored_route_refs: &["MAIL_MOX_WEBHOOK_PATH"],
    },
    RouteSource {
        name: "platform REST router",
        surface: "platform",
        source: include_str!("../../crates/platform/platform-rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "platform view-as router",
        surface: "platform",
        source: include_str!("../../crates/platform/platform-rest/src/view_as.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "auth REST router",
        surface: "auth",
        source: include_str!("../../crates/platform/auth-rest/src/lib.rs"),
        // `dev-auth` is feature-gated and intentionally absent from the production
        // OpenAPI contract/inventory.
        ignored_route_refs: &["DEV_AUTH_SESSION_PATH"],
    },
    RouteSource {
        name: "realtime router",
        surface: "realtime",
        source: include_str!("../../crates/platform/realtime/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "ontology REST router",
        surface: "ontology",
        source: include_str!("../../crates/ontology/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "governance REST router",
        surface: "governance",
        source: include_str!("../../crates/governance/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "policy (cedar authoring) REST router",
        surface: "policy",
        source: include_str!("../../crates/platform/authz-rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "evidence (docs) REST router",
        surface: "evidence",
        source: include_str!("../../crates/docs/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "notices REST router",
        surface: "notices",
        source: include_str!("../../crates/notices/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "finance-gl REST router",
        surface: "finance-gl",
        source: include_str!("../../crates/finance-gl/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "payroll REST router",
        surface: "payroll",
        source: include_str!("../../crates/payroll/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "analytics-quant REST router",
        surface: "analytics",
        source: include_str!("../../crates/analytics-quant/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "equipment 3R REST router",
        surface: "equipment-3r",
        source: include_str!("../../crates/equipment/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
];

#[test]
fn configured_route_inventory_includes_each_configured_surface() {
    let surface_names: BTreeSet<_> = CONFIGURED_ROUTE_SURFACES
        .iter()
        .map(|surface| surface.name)
        .collect();

    for required in REQUIRED_CONFIGURED_SURFACES {
        assert!(
            surface_names.contains(required),
            "configured route inventory is missing the {required} surface"
        );
    }

    let audit_paths = CONFIGURED_ROUTE_SURFACES
        .iter()
        .find(|surface| surface.name == "audit")
        .map(|surface| surface.paths)
        .unwrap_or_default();
    assert!(
        audit_paths.contains(&AUDIT_ROUTE_PATH),
        "configured route inventory is missing {AUDIT_ROUTE_PATH}"
    );

    for surface in CONFIGURED_ROUTE_SURFACES {
        assert!(
            !surface.paths.is_empty(),
            "configured route inventory surface {} has no paths",
            surface.name
        );
    }
}

#[test]
fn configured_route_inventory_covers_router_route_calls() {
    let mut missing_surfaces = Vec::new();
    let mut uncovered_routes = Vec::new();
    let mut unresolved_routes = Vec::new();

    for source in CONFIGURED_ROUTE_SOURCES {
        let Some(inventory_paths) = configured_source_inventory_paths(source.surface) else {
            missing_surfaces.push(source.surface);
            continue;
        };

        for route in route_calls(source.source, source.ignored_route_refs) {
            let Some(path) = route.path else {
                unresolved_routes.push(format!(
                    "{} has unresolved route argument {}",
                    source.name, route.argument
                ));
                continue;
            };
            let normalized = normalize_path_parameters(&path);
            if !inventory_paths.contains(&normalized) {
                uncovered_routes.push(format!(
                    "{} route {path} ({}) is missing from configured surface {}",
                    source.name, route.argument, source.surface
                ));
            }
        }
    }

    assert!(
        missing_surfaces.is_empty(),
        "configured route source references unknown surfaces: {}",
        missing_surfaces.join(", ")
    );
    assert!(
        unresolved_routes.is_empty(),
        "configured router source parsing found unresolved route refs:\n{}",
        unresolved_routes.join("\n")
    );
    assert!(
        uncovered_routes.is_empty(),
        "configured router route calls are missing from the OpenAPI drift inventory:\n{}",
        uncovered_routes.join("\n")
    );
}

#[test]
fn openapi_yaml_covers_configured_route_inventory() {
    let openapi_paths = openapi_path_keys(OPENAPI_YAML);

    for surface in CONFIGURED_ROUTE_SURFACES {
        for path in surface.paths {
            let normalized = normalize_path_parameters(path);
            assert!(
                openapi_paths.contains(&normalized),
                "OpenAPI YAML is missing configured {surface} route {path}",
                surface = surface.name
            );
        }
    }
}

#[test]
fn openapi_documents_closed_inventory_movement_source_variants() {
    let start = OPENAPI_YAML
        .find("    InventoryMovementSourceWorkOrder:\n")
        .expect("OpenAPI YAML must define the work-order movement source");
    let end = OPENAPI_YAML[start..]
        .find("    InventoryReceiptResult:\n")
        .map(|offset| start + offset)
        .expect("Inventory movement source variants must precede receipt results");
    let schema = &OPENAPI_YAML[start..end];

    for variant in [
        "InventoryMovementSourceWorkOrder",
        "InventoryMovementSourceP1Dispatch",
        "InventoryMovementSourceCycleCount",
        "InventoryMovementSourceExternalRef",
    ] {
        assert!(
            schema.contains(variant),
            "OpenAPI movement source is missing {variant}"
        );
    }
    assert!(
        schema.contains("source: { $ref: '#/components/schemas/InventoryMovementSource' }"),
        "InventoryMovement.source must not degrade to an untyped object"
    );
    assert!(
        schema.contains("InventoryMovementSource:\n      oneOf:")
            && schema.contains("discriminator:\n        propertyName: kind"),
        "Inventory movement sources must remain a kind-discriminated union"
    );
    assert!(
        schema.matches("additionalProperties: false").count() >= 4,
        "every inventory movement source variant must be closed to unknown fields"
    );
    for wire_kind in ["work_order", "p1_dispatch", "cycle_count", "external_ref"] {
        assert!(
            schema.contains(wire_kind),
            "OpenAPI movement source must document the {wire_kind} runtime discriminator"
        );
    }
}

#[test]
fn openapi_documents_closed_month_as_year_month_not_calendar_date() {
    let start = OPENAPI_YAML
        .find("    AttendanceMonthClose:\n")
        .expect("OpenAPI YAML must define AttendanceMonthClose");
    let end = OPENAPI_YAML[start..]
        .find("    AttendanceCloseBoard:\n")
        .map(|offset| start + offset)
        .expect("AttendanceMonthClose must precede AttendanceCloseBoard");
    let schema = &OPENAPI_YAML[start..end];
    assert!(
        schema.contains("month: { type: string, pattern: '^\\\\d{4}-\\\\d{2}$' }"),
        "closed-month response must match the server's YYYY-MM wire value, not an OpenAPI calendar date"
    );
}

#[test]
fn openapi_documents_hr_attendance_branch_scope_query() {
    for (path, next_path) in [
        (
            "/api/v1/hr/attendance-summary:",
            "/api/v1/hr/readiness-summary:",
        ),
        (
            "/api/v1/hr/attendance-records:",
            "/api/v1/employees/import:",
        ),
    ] {
        let start = OPENAPI_YAML
            .find(path)
            .unwrap_or_else(|| panic!("OpenAPI YAML is missing {path}"));
        let end = OPENAPI_YAML[start..]
            .find(next_path)
            .map(|offset| start + offset)
            .unwrap_or(OPENAPI_YAML.len());
        let operation = &OPENAPI_YAML[start..end];
        assert!(
            operation.contains("- name: branch_id\n        in: query"),
            "{path} must expose the optional snake_case branch_id query accepted by its Axum handler"
        );
    }
}

#[test]
fn openapi_yaml_covers_platform_route_operations() {
    let missing = missing_platform_route_operations(OPENAPI_YAML);
    assert!(
        missing.is_empty(),
        "OpenAPI YAML is missing platform route operation coverage:\n{}",
        missing.join("\n")
    );

    let expected = platform_route_operation_keys();
    let unexpected: Vec<_> = openapi_operation_keys(OPENAPI_YAML)
        .into_iter()
        .filter(|(path, _method)| path.starts_with("/api/platform/"))
        .filter(|operation| !expected.contains(operation))
        .map(|(path, method)| format!("{} {path}", method.to_ascii_uppercase()))
        .collect();
    assert!(
        unexpected.is_empty(),
        "OpenAPI YAML documents platform operations that are not in mnt_platform_rest::PLATFORM_ROUTE_OPERATIONS:\n{}",
        unexpected.join("\n")
    );
}

#[test]
fn platform_route_operation_gate_rejects_missing_contract_entry() {
    let broken_yaml = OPENAPI_YAML.replacen(
        "    delete:\n      tags:\n        - platform\n      operationId: removePlatformOrgFromGroup",
        "    x-delete-missing-for-test:\n      tags:\n        - platform\n      operationId: removePlatformOrgFromGroup",
        1,
    );
    assert_ne!(
        broken_yaml, OPENAPI_YAML,
        "test fixture anchor no longer matches the OpenAPI YAML; update the replacen target so the DELETE operation is actually removed before asserting the gate detects it"
    );
    let missing = missing_platform_route_operations(&broken_yaml);

    assert!(
        missing
            .iter()
            .any(|entry| entry == "DELETE /api/platform/groups/{id}/organizations/{org_id}"),
        "deliberately removing DELETE /api/platform/groups/{{id}}/organizations/{{org_id}} from OpenAPI should be reported; missing={missing:?}"
    );
}

fn openapi_path_keys(yaml: &str) -> BTreeSet<String> {
    yaml.lines()
        .filter_map(|line| {
            let trimmed = line.trim_end();
            if !line.starts_with("  /") || !trimmed.ends_with(':') {
                return None;
            }
            Some(normalize_path_parameters(
                trimmed.trim_end_matches(':').trim(),
            ))
        })
        .collect()
}

fn missing_platform_route_operations(yaml: &str) -> Vec<String> {
    let openapi_operations = openapi_operation_keys(yaml);
    PLATFORM_ROUTE_OPERATIONS
        .iter()
        .filter_map(|operation| {
            let key = (
                normalize_path_parameters(operation.path),
                operation.method.to_ascii_lowercase(),
            );
            if openapi_operations.contains(&key) {
                None
            } else {
                Some(format!("{} {}", operation.method, operation.path))
            }
        })
        .collect()
}

fn platform_route_operation_keys() -> BTreeSet<(String, String)> {
    PLATFORM_ROUTE_OPERATIONS
        .iter()
        .map(|operation| {
            (
                normalize_path_parameters(operation.path),
                operation.method.to_ascii_lowercase(),
            )
        })
        .collect()
}

fn openapi_operation_keys(yaml: &str) -> BTreeSet<(String, String)> {
    let mut current_path: Option<String> = None;
    let mut operations = BTreeSet::new();

    for line in yaml.lines() {
        let trimmed = line.trim_end();

        if line.starts_with("  /") && trimmed.ends_with(':') {
            current_path = Some(normalize_path_parameters(
                trimmed.trim_end_matches(':').trim(),
            ));
            continue;
        }

        if !line.starts_with(' ') {
            current_path = None;
            continue;
        }

        let Some(path) = current_path.as_ref() else {
            continue;
        };
        if line.starts_with("    ") && !line.starts_with("      ") && trimmed.ends_with(':') {
            let method = trimmed.trim_end_matches(':').trim();
            if is_openapi_method(method) {
                operations.insert((path.clone(), method.to_ascii_lowercase()));
            }
        }
    }

    operations
}

fn is_openapi_method(value: &str) -> bool {
    matches!(
        value,
        "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace"
    )
}

struct RouteCall {
    argument: String,
    path: Option<String>,
}

fn configured_surface_paths(surface_name: &str) -> Option<&'static [&'static str]> {
    CONFIGURED_ROUTE_SURFACES
        .iter()
        .find(|surface| surface.name == surface_name)
        .map(|surface| surface.paths)
}

fn configured_source_inventory_paths(surface_name: &str) -> Option<BTreeSet<String>> {
    let mut inventory = BTreeSet::new();
    if surface_name == "workorder" {
        for name in ["workorder", "workorder-mobile"] {
            let paths = configured_surface_paths(name)?;
            inventory.extend(paths.iter().map(|path| normalize_path_parameters(path)));
        }
        return Some(inventory);
    }

    let paths = configured_surface_paths(surface_name)?;
    inventory.extend(paths.iter().map(|path| normalize_path_parameters(path)));
    Some(inventory)
}

fn route_calls(source: &'static str, ignored_route_refs: &[&str]) -> Vec<RouteCall> {
    let constants = route_path_constants(source);
    let mut calls = Vec::new();
    let mut offset = 0;
    while let Some(relative_start) = source[offset..].find(".route(") {
        let args_start = offset + relative_start + ".route(".len();
        let Some(argument) = first_route_argument(&source[args_start..]) else {
            break;
        };
        let trimmed = argument.trim();
        let parsed = route_argument_path(trimmed, &constants, ignored_route_refs);
        if !parsed.ignored {
            calls.push(RouteCall {
                argument: trimmed.to_owned(),
                path: parsed.path,
            });
        }
        offset = args_start + argument.len();
    }
    calls
}

struct ParsedRouteArgument {
    path: Option<String>,
    ignored: bool,
}

fn route_argument_path(
    argument: &str,
    constants: &BTreeMap<String, String>,
    ignored_route_refs: &[&str],
) -> ParsedRouteArgument {
    if let Some(path) = quoted_argument(argument) {
        return ParsedRouteArgument {
            path: Some(path.to_owned()),
            ignored: false,
        };
    }

    let Some(identifier) = leading_identifier(argument) else {
        return ParsedRouteArgument {
            path: None,
            ignored: false,
        };
    };
    if ignored_route_refs.contains(&identifier) {
        return ParsedRouteArgument {
            path: None,
            ignored: true,
        };
    }

    ParsedRouteArgument {
        path: constants.get(identifier).cloned(),
        ignored: false,
    }
}

fn route_path_constants(source: &str) -> BTreeMap<String, String> {
    let mut constants = BTreeMap::new();
    let mut offset = 0;
    while let Some(relative_start) = source[offset..].find("const ") {
        let name_start = offset + relative_start + "const ".len();
        let Some(statement_end) = source[name_start..].find(';') else {
            break;
        };
        let statement = &source[name_start..name_start + statement_end];
        offset = name_start + statement_end + 1;

        if !statement.contains("&str") {
            continue;
        }
        let Some(name_end) = statement.find(':') else {
            continue;
        };
        let Some(path) = quoted_argument(statement) else {
            continue;
        };
        constants.insert(statement[..name_end].trim().to_owned(), path.to_owned());
    }
    constants
}

fn first_route_argument(source: &str) -> Option<&str> {
    let mut in_string = false;
    let mut escaped = false;
    let mut nested = 0usize;

    for (idx, ch) in source.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '(' | '[' | '{' => nested += 1,
            ')' | ']' | '}' => nested = nested.saturating_sub(1),
            ',' if nested == 0 => return Some(&source[..idx]),
            _ => {}
        }
    }
    None
}

fn quoted_argument(value: &str) -> Option<&str> {
    let first_quote = value.find('"')?;
    let after_first = &value[first_quote + '"'.len_utf8()..];
    let second_quote = after_first.find('"')?;
    Some(&after_first[..second_quote])
}

fn leading_identifier(value: &str) -> Option<&str> {
    let trimmed = value.trim_start();
    let end = trimmed
        .char_indices()
        .find_map(|(idx, ch)| (!is_identifier_char(ch)).then_some(idx))
        .unwrap_or(trimmed.len());
    (end > 0).then_some(&trimmed[..end])
}

fn is_identifier_char(ch: char) -> bool {
    ch == '_' || ch.is_ascii_alphanumeric()
}

fn normalize_path_parameters(path: &str) -> String {
    let mut normalized = String::with_capacity(path.len());
    let mut in_parameter = false;
    for ch in path.chars() {
        match ch {
            '{' => {
                in_parameter = true;
                normalized.push_str("{}");
            }
            '}' => in_parameter = false,
            _ if !in_parameter => normalized.push(ch),
            _ => {}
        }
    }
    normalized
}

#[test]
fn dispatch_read_openapi_operations_match_generated_client_faces() {
    const TS: &str = include_str!("../../clients/ts/src/schema.d.ts");
    const KOTLIN: &str = include_str!(
        "../../clients/kotlin/src/main/kotlin/com/maintenance/api/client/api/P1DispatchesApi.kt"
    );
    const SWIFT: &str =
        include_str!("../../clients/swift/Sources/MaintenanceAPIClient/Generated/Client.swift");
    for (path, operation, schema) in [
        (
            "/api/v1/console/dispatch/queue",
            "listConsoleDispatchQueue",
            "DispatchQueuePage",
        ),
        (
            "/api/v1/p1-dispatches/{dispatchId}/candidates",
            "listP1DispatchCandidates",
            "DispatchCandidatePage",
        ),
        (
            "/api/v1/p1-dispatches/{dispatchId}/responses",
            "listP1DispatchResponses",
            "P1DispatchResponsePage",
        ),
    ] {
        let start = OPENAPI_YAML
            .find(&format!("  {path}:\n"))
            .unwrap_or_else(|| panic!("missing {path}"));
        let operation_yaml = &OPENAPI_YAML[start..];
        assert!(
            operation_yaml.contains(&format!("operationId: {operation}"))
                && operation_yaml.contains(&format!("$ref: '#/components/schemas/{schema}'"))
        );
        assert!(
            TS.contains(operation),
            "TS generated client lacks {operation}"
        );
        assert!(
            KOTLIN.contains(operation),
            "Kotlin generated client lacks {operation}"
        );
        assert!(
            SWIFT.contains(operation),
            "Swift generated client lacks {operation}"
        );
    }
}

fn operation_section<'a>(yaml: &'a str, path: &str, operation: &str) -> &'a str {
    let start = yaml
        .find(&format!("  {path}:\n"))
        .unwrap_or_else(|| panic!("missing {path}"));
    let remainder = &yaml[start..];
    let end = remainder[1..]
        .find("\n  /")
        .map(|offset| start + offset + 1)
        .unwrap_or(yaml.len());
    let section = &yaml[start..end];
    assert!(section.contains(&format!("operationId: {operation}")));
    section
}

fn bounded_section<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    let start = source
        .find(start)
        .unwrap_or_else(|| panic!("missing start {start}"));
    let after_start = start + source[start..].find('\n').unwrap_or(0) + 1;
    let end = source[after_start..]
        .find(end)
        .map(|offset| after_start + offset)
        .unwrap_or_else(|| panic!("missing end {end}"));
    &source[start..end]
}

#[test]
fn dispatch_queue_parameter_and_error_faces_preserve_wire_contract() {
    const TS: &str = include_str!("../../clients/ts/src/schema.d.ts");
    const KOTLIN: &str = include_str!(
        "../../clients/kotlin/src/main/kotlin/com/maintenance/api/client/api/P1DispatchesApi.kt"
    );
    const KOTLIN_ENUM: &str = include_str!(
        "../../clients/kotlin/src/main/kotlin/com/maintenance/api/client/model/DispatchQueueStatus.kt"
    );
    const SWIFT: &str =
        include_str!("../../clients/swift/Sources/MaintenanceAPIClient/Generated/Client.swift");
    const SWIFT_TYPES: &str =
        include_str!("../../clients/swift/Sources/MaintenanceAPIClient/Generated/Types.swift");
    let queue = operation_section(
        OPENAPI_YAML,
        "/api/v1/console/dispatch/queue",
        "listConsoleDispatchQueue",
    );
    for required in [
        "type: array",
        "style: form",
        "explode: false",
        "'400': { $ref: '#/components/responses/BadRequest' }",
    ] {
        assert!(
            queue.contains(required),
            "queue OpenAPI contract lacks {required}"
        );
    }
    let openapi_enum = bounded_section(
        OPENAPI_YAML,
        "    DispatchQueueStatus:\n",
        "    DispatchQueueDispatch:\n",
    );
    let ts_op = bounded_section(
        TS,
        "    listConsoleDispatchQueue: {",
        "    listP1DispatchCandidates: {",
    );
    let kotlin_op = bounded_section(
        KOTLIN,
        "    fun listConsoleDispatchQueueRequestConfig",
        "    /**\n     * GET /api/v1/p1-dispatches/{dispatchId}/candidates",
    );
    let swift_op = bounded_section(
        SWIFT,
        "    public func listConsoleDispatchQueue",
        "    /// List manager-authorized ranked dispatch candidates",
    );
    let ts_enum = bounded_section(
        TS,
        "        DispatchQueueStatus: ",
        "        DispatchQueueDispatch: {",
    );
    let swift_enum = bounded_section(
        SWIFT_TYPES,
        "        @frozen public enum DispatchQueueStatus",
        "        public struct DispatchQueueDispatch",
    );
    for wire in [
        "RECEIVED",
        "UNASSIGNED",
        "ASSIGNED",
        "IN_PROGRESS",
        "PART_WAITING",
        "DELAYED",
    ] {
        assert!(
            openapi_enum.contains(wire),
            "OpenAPI DispatchQueueStatus lacks {wire}"
        );
        assert!(
            ts_enum.contains(wire),
            "TS DispatchQueueStatus lacks {wire}"
        );
        assert!(
            KOTLIN_ENUM.contains(wire),
            "Kotlin DispatchQueueStatus lacks {wire}"
        );
        assert!(
            swift_enum.contains(wire),
            "Swift DispatchQueueStatus lacks {wire}"
        );
    }
    assert!(
        ts_op.contains("status?: components[\"schemas\"][\"DispatchQueueStatus\"][]")
            && ts_op.contains("400: components[\"responses\"][\"BadRequest\"]")
    );
    assert!(
        kotlin_op.contains("kotlin.collections.List<DispatchQueueStatus>")
            && kotlin_op.contains("toMultiValue(status.toList(), \"csv\")")
            && kotlin_op.contains("Accept\"] = \"application/json\"")
    );
    assert!(
        swift_op.contains("style: .form,")
            && swift_op.contains("explode: false,")
            && swift_op.contains("name: \"status\"")
            && swift_op.contains("case 400:")
            && swift_op.contains("\"application/json\"")
    );
}

#[test]
fn bounded_generated_sections_reject_later_operation_or_enum_text() {
    let operation = bounded_section("target\nnext target", "target", "next");
    assert!(
        !operation.contains("next target"),
        "later operation text must not satisfy target assertions"
    );
    let status = bounded_section(
        "DispatchQueueStatus\nRECEIVED\nOtherStatus\nDELAYED",
        "DispatchQueueStatus",
        "OtherStatus",
    );
    assert!(
        status.contains("RECEIVED") && !status.contains("DELAYED"),
        "later enum text must not satisfy target assertions"
    );
}

#[test]
#[should_panic(expected = "missing end absent")]
fn bounded_generated_sections_reject_missing_end_boundary() {
    let _ = bounded_section("target only", "target", "absent");
}
