#!/usr/bin/env python3
"""Generate first-party BUCK files for the backend workspace crates.

reindeer generates the third-party graph; this emits one BUCK per workspace
member (rust_library / rust_binary + rust_test targets) from its Cargo.toml.
Cargo stays the source of truth — re-run after adding/moving crates, deps, or
tests. First-party sources are materialized at repository-relative paths inside
each Buck action so compile-time include paths retain the same topology as the
checkout without source-tree symlinks or copied fixtures.

Dependency mapping:
  - a dep whose (renamed) crate is another workspace member  -> //<dir>:<name>
  - sqlx 0.8 (renamed apalis-sqlx, pinned for apalis)        -> //third-party/rust:sqlx-0_8
  - any other dep                                            -> //third-party/rust:<crate>

Test targets:
  - <name>-unit            : inline #[cfg(test)] tests (recompiles the lib srcs
                             with --test; needs [dev-dependencies] too).
  - <name>-itest-<stem>    : one per tests/*.rs integration file (depends on the
                             library + dev-deps; non-test helper files in tests/
                             are added to srcs so `mod common;` resolves).
  - DB-backed tests (sqlx::test / PgPool / DATABASE_URL / mnt_rt) get
    labels=["needs-postgres"] so `buck2 test //backend/... --exclude
    needs-postgres` runs the hermetic subset, mirroring cargo test minus the DB
    suites (which need a live Postgres + the mnt_rt runtime role, same as cargo).
"""
import os
import sys
import tomllib

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MEMBER_ROOTS = ["backend/app", "backend/crates", "backend/ci"]

MIGRATION_TREE = {
    "//backend/crates/platform/db/migrations:tree":
        "backend/crates/platform/db/migrations",
}

OPENAPI_DRIFT_SOURCE_PACKAGES = [
    "backend/crates/dispatch/rest",
    "backend/crates/benefit/rest",
    "backend/crates/financial/rest",
    "backend/crates/inspection/rest",
    "backend/crates/support/rest",
    "backend/crates/identity/rest",
    "backend/crates/compliance/rest",
    "backend/crates/compliance/integrity",
    "backend/crates/registry/rest",
    "backend/crates/sales/rest",
    "backend/crates/reporting/rest",
    "backend/crates/workorder/rest",
    "backend/crates/messenger/rest",
    "backend/crates/comms/rest",
    "backend/crates/platform/platform-rest",
    "backend/crates/platform/auth-rest",
    "backend/crates/platform/realtime",
    "backend/crates/ontology/rest",
    "backend/crates/governance/rest",
    "backend/crates/platform/authz-rest",
    "backend/crates/docs/rest",
    "backend/crates/notices/rest",
    "backend/crates/finance-gl/rest",
    "backend/crates/payroll/rest",
    "backend/crates/analytics-quant/rest",
]


def source_tree_label(package):
    return "//{}:crate-source-tree".format(package)


OPENAPI_DRIFT_EXTERNAL = {
    source_tree_label(package): package + "/src"
    for package in OPENAPI_DRIFT_SOURCE_PACKAGES
}
OPENAPI_DRIFT_EXTERNAL["//backend/openapi:openapi.yaml"] = (
    "backend/openapi/openapi.yaml"
)

# Compile-time and runtime fixture inputs outside a crate package. Labels expose
# the authoritative bytes; mapped destinations preserve the checkout topology.
RESOURCE_CONFIG = {
    "mnt-app": {
        "external": {
            "//backend/openapi:openapi.yaml": "backend/openapi/openapi.yaml",
            **MIGRATION_TREE,
        },
        "itests": {
            "tests/openapi_drift.rs": {
                "srcs": ["src/**/*.rs"],
                "external": OPENAPI_DRIFT_EXTERNAL,
            },
            "tests/dev_seed_notification_links.rs": {
                "external": {
                    "//scripts:dev-seed.sql": "scripts/dev-seed.sql",
                },
            },
            "tests/openslo_files.rs": {
                "srcs": ["slos/**"],
            },
        },
    },
    "mnt-platform-authz": {
        "external": {
            "//docs/specs:cedar-pbac-map":
                "docs/specs/cedar-pbac-coexistence-map.json",
        },
        "itest_srcs": ["tests/fixtures/**"],
    },
    "mnt-reporting-adapter-postgres": {
        "external": {
            "//docs/reference:daily-progress":
                "docs/reference/일일업무진행현황_0605.xlsx",
            "//docs/reference:work-log":
                "docs/reference/업무일지_26.05.27.xlsx",
        },
    },
    "mnt-platform-excel": {
        "itest_external": {
            "//docs/reference:daily-progress":
                "docs/reference/일일업무진행현황_0605.xlsx",
            "//docs/reference:work-log":
                "docs/reference/업무일지_26.05.27.xlsx",
        },
    },
    "mnt-registry-adapter-postgres": {
        "itest_external": {
            "//docs/reference:master-list":
                "docs/reference/master-list_251120.xlsx",
        },
    },
    "mnt-registry-rest": {
        "itest_external": {
            "//docs/reference:master-list":
                "docs/reference/master-list_251120.xlsx",
        },
    },
}

SQLX_MACRO_MARKERS = ("query!", "query_as!", "query_scalar!")
TEST_MARKERS = ("#[test]", "#[tokio::test", "#[sqlx::test", "#[rstest")
# A test that touches a real database / the mnt_rt runtime role cannot run
# hermetically under `buck2 test` — it needs a live Postgres (same as cargo).
PG_MARKERS = ("sqlx::test", "PgPool", "DATABASE_URL", "mnt_rt", "with_org_conn")
# The production REST crate has SQL in its library implementation, but its
# inline tests exercise only parser/HMAC helpers. Its HTTP/RLS suite remains a
# separately labeled integration target below.
PURE_UNIT_PACKAGES = {"mnt-production-rest"}


def find_members():
    dirs = []
    for root in MEMBER_ROOTS:
        for dirpath, _, files in os.walk(os.path.join(REPO, root)):
            if "Cargo.toml" in files and os.path.basename(dirpath) != "rust":
                with open(os.path.join(dirpath, "Cargo.toml"), "rb") as f:
                    if "package" in tomllib.load(f):
                        dirs.append(dirpath)
    return sorted(dirs)


def load(dirpath):
    with open(os.path.join(dirpath, "Cargo.toml"), "rb") as f:
        return tomllib.load(f)


def crate_ident(name):
    return name.replace("-", "_")


def file_has(path, *markers):
    try:
        txt = open(path, encoding="utf-8", errors="ignore").read()
    except OSError:
        return False
    return any(mk in txt for mk in markers)


def tree_has(root, *markers):
    for dp, _, files in os.walk(root):
        for f in files:
            if f.endswith(".rs") and file_has(os.path.join(dp, f), *markers):
                return True
    return False


def map_deps(dep_table, first_party):
    """Map a [dependencies]/[dev-dependencies] table to (deps_list, named_dict)."""
    deps, named = [], {}
    for key, spec in (dep_table or {}).items():
        pkg = spec.get("package", key) if isinstance(spec, dict) else key
        version = spec.get("version", "") if isinstance(spec, dict) else spec
        if pkg in first_party:
            target = first_party[pkg]
        elif pkg == "sqlx" and str(version).lstrip("=").startswith("0.8"):
            target = "//third-party/rust:sqlx-0_8"  # buckify.sh renames the 0.8 alias
        else:
            target = "//third-party/rust:{}".format(pkg)
        if key != pkg:  # renamed dependency -> named_dep so the crate sees `key`
            named[crate_ident(key)] = target
        else:
            deps.append(target)
    return deps, named


def globstr(patterns, exclude=None):
    pats = ", ".join('"{}"'.format(p) for p in patterns)
    if exclude:
        ex = ", ".join('"{}"'.format(e) for e in exclude)
        return "glob([{}], exclude = [{}])".format(pats, ex)
    return "glob([{}])".format(pats)


def listsrcs(paths):
    return "[" + ", ".join('"{}"'.format(p) for p in paths) + "]"


def base_env(package, uses_sqlx=False):
    env = {"CARGO_MANIFEST_DIR": package}
    if uses_sqlx:
        env.update({
            "SQLX_OFFLINE": "true",
            "SQLX_OFFLINE_DIR": "$(location //backend:sqlx-offline)",
        })
    return env


def integration_resource_config(name, test_file):
    crate = RESOURCE_CONFIG.get(name, {})
    specific = crate.get("itests", {}).get(test_file, {})
    return {
        "srcs": list(crate.get("itest_srcs", [])) + list(specific.get("srcs", [])),
        "external": {
            **crate.get("itest_external", {}),
            **specific.get("external", {}),
        },
    }


def integration_external_resources(name, test_file, contents):
    external = dict(integration_resource_config(name, test_file)["external"])
    if "#[sqlx::test" in contents:
        external.update(MIGRATION_TREE)
    return external


def mapped_srcs_lines(package, srcs, external):
    if not external:
        return [
            '    mapped_srcs = repo_mapped_srcs("{}", {}),'.format(
                package, srcs
            ),
        ]
    lines = [
        '    mapped_srcs = repo_mapped_srcs("{}", {}, external = {{'.format(
            package, srcs
        ),
    ]
    lines += [
        '        "{}": "{}",'.format(label, destination)
        for label, destination in sorted(external.items())
    ]
    lines.append("    }),")
    return lines


def _block(
    rule,
    name,
    srcs,
    crate,
    deps,
    named,
    env,
    *,
    package,
    crate_root,
    external=None,
    labels=None,
):
    lines = [
        "{}(".format(rule),
        '    name = "{}",'.format(name),
    ]
    lines += mapped_srcs_lines(package, srcs, external or {})
    lines += [
        '    crate = "{}",'.format(crate),
        '    edition = "2024",',
        '    crate_root = "{}",'.format(crate_root),
    ]
    lines.append('    visibility = ["PUBLIC"],')
    if env:
        items = ", ".join('"{}": "{}"'.format(k, v) for k, v in env.items())
        lines.append("    env = {" + items + "},")
    if labels:
        lines.append("    labels = [" + ", ".join('"{}"'.format(x) for x in labels) + "],")
    if deps:
        lines.append("    deps = [")
        lines += ['        "{}",'.format(t) for t in sorted(set(deps))]
        lines.append("    ],")
    if named:
        lines.append("    named_deps = {")
        lines += ['        "{}": "{}",'.format(k, v) for k, v in sorted(named.items())]
        lines.append("    },")
    lines.append(")")
    return lines


def main():
    members = find_members()
    first_party, meta = {}, {}
    for d in members:
        m = load(d)
        name = m["package"]["name"]
        first_party[name] = "//{}:{}".format(os.path.relpath(d, REPO), name)
        meta[d] = (name, m)

    generated = 0
    for d in members:
        name, m = meta[d]
        deps, named = map_deps(m.get("dependencies"), first_party)
        dev_deps, dev_named = map_deps(m.get("dev-dependencies"), first_party)
        emit(d, name, sorted(deps), named, sorted(dev_deps), dev_named)
        generated += 1
    print("generated {} first-party BUCK files".format(generated))


def emit(d, name, deps, named, dev_deps, dev_named):
    header = "# @generated by tools/buck/gen_first_party.py from Cargo.toml — do not edit by hand."
    ident = crate_ident(name)
    has_main = os.path.isfile(os.path.join(d, "src", "main.rs"))
    has_lib = os.path.isfile(os.path.join(d, "src", "lib.rs"))
    src = os.path.join(d, "src")
    package = os.path.relpath(d, REPO)
    uses_sqlx = tree_has(src, *(SQLX_MACRO_MARKERS + ("#[sqlx::test",)))
    env = base_env(package, uses_sqlx=uses_sqlx)
    resources = RESOURCE_CONFIG.get(name, {})
    lib_pats = ["src/**/*.rs"] + list(resources.get("srcs", []))
    lib_external = dict(resources.get("external", {}))
    if tree_has(src, "#[sqlx::test"):
        lib_external.update(MIGRATION_TREE)

    out = [
        header,
        'load("//tools/buck:rust_source_layout.bzl", "repo_mapped_srcs")',
        "",
        "export_file(",
        '    name = "crate-source-tree",',
        '    src = "src",',
        '    mode = "reference",',
        '    visibility = ["PUBLIC"],',
        ")",
        "",
    ]
    if has_main and has_lib:
        out += _block("rust_library", name + "-lib", globstr(lib_pats, exclude=["src/main.rs"]),
                      ident, deps, named, env, package=package,
                      crate_root=package + "/src/lib.rs", external=lib_external)
        out.append("")
        out += _block("rust_binary", name, listsrcs(["src/main.rs"]), ident,
                      sorted(deps + [":" + name + "-lib"]), {},
                      base_env(package), package=package,
                      crate_root=package + "/src/main.rs")
        lib_target, unit_root, unit_excl = ":" + name + "-lib", "src/lib.rs", ["src/main.rs"]
    elif has_main:
        out += _block("rust_binary", name, globstr(lib_pats), ident, deps, named, env,
                      package=package, crate_root=package + "/src/main.rs",
                      external=lib_external)
        lib_target, unit_root, unit_excl = ":" + name, "src/main.rs", None
    else:
        out += _block("rust_library", name, globstr(lib_pats), ident, deps, named, env,
                      package=package, crate_root=package + "/src/lib.rs",
                      external=lib_external)
        lib_target, unit_root, unit_excl = ":" + name, "src/lib.rs", None

    test_deps = sorted(set(deps + dev_deps))
    test_named = {**named, **dev_named}

    # Unit tests: recompile the lib srcs with --test (only if inline tests exist).
    # SQL-backed suites are emitted and labeled rather than hidden: the migration
    # input is hermetic at compile time, while execution still requires Postgres.
    if tree_has(src, "#[cfg(test)]"):
        labels = (
            None
            if name in PURE_UNIT_PACKAGES
            else ["needs-postgres"] if tree_has(src, *PG_MARKERS) else None
        )
        out.append("")
        out += _block("rust_test", name + "-unit",
                      globstr(lib_pats, exclude=unit_excl), ident,
                      test_deps, test_named, env, package=package,
                      crate_root=package + "/" + unit_root,
                      external=lib_external, labels=labels)

    # Integration tests: one rust_test per tests/*.rs with a test marker; non-test
    # helper files (tests/config.rs, tests/common/**) are added to srcs so their
    # `mod` declarations resolve (unreferenced ones are ignored by rustc).
    testsdir = os.path.join(d, "tests")
    if os.path.isdir(testsdir):
        all_rs = []
        for dp, _, files in os.walk(testsdir):
            for f in files:
                if f.endswith(".rs"):
                    all_rs.append(os.path.relpath(os.path.join(dp, f), d))
        test_files = sorted(p for p in all_rs if file_has(os.path.join(d, p), *TEST_MARKERS))
        helpers = sorted(p for p in all_rs if p not in test_files)
        for tf in test_files:
            test_path = os.path.join(d, tf)
            contents = open(test_path, encoding="utf-8", errors="ignore").read()
            stem = crate_ident(os.path.splitext(os.path.basename(tf))[0])
            labels = ["needs-postgres"] if any(marker in contents for marker in PG_MARKERS) else None
            config = integration_resource_config(name, tf)
            srcs_expr = listsrcs(sorted(set([tf] + helpers)))
            if config["srcs"]:
                srcs_expr += " + " + globstr(config["srcs"])
            external = integration_external_resources(name, tf, contents)
            itest_env = base_env(
                package,
                uses_sqlx=any(marker in contents for marker in SQLX_MACRO_MARKERS)
                or "#[sqlx::test" in contents,
            )
            out.append("")
            out += _block("rust_test", "{}-itest-{}".format(name, stem),
                          srcs_expr, stem,
                          sorted(set(test_deps + [lib_target])), test_named, itest_env,
                          package=package, crate_root=package + "/" + tf,
                          external=external, labels=labels)

    with open(os.path.join(d, "BUCK"), "w") as f:
        f.write("\n".join(out) + "\n")


if __name__ == "__main__":
    sys.exit(main())
