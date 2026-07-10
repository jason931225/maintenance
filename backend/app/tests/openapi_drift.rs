use std::collections::{BTreeMap, BTreeSet};

use mnt_app::{AUDIT_ROUTE_PATH, CONFIGURED_ROUTE_SURFACES};
use mnt_platform_rest::PLATFORM_ROUTE_OPERATIONS;

const OPENAPI_YAML: &str = include_str!("../../openapi/openapi.yaml");
const REQUIRED_CONFIGURED_SURFACES: &[&str] = &[
    "audit",
    "dispatch",
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
        name: "dispatch REST router",
        surface: "dispatch",
        source: include_str!("../../crates/dispatch/rest/src/lib.rs"),
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
