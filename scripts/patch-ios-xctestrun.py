#!/usr/bin/env python3
"""Patch Xcode UI-test xctestrun metadata for CI.

Xcode's build-for-testing action emits a .xctestrun plist that test-without-
building consumes. On the GitHub macOS/Xcode 16.4 runner, XcodeGen's generated
UI-test target relationship can produce an extensionless UITargetAppPath
(`.../MaintenanceFieldApp`) even though the built host is
`MaintenanceFieldApp.app`. This script makes the xctestrun explicit and injects
the test-runner environment variables that the suite reads via ProcessInfo.
"""

from __future__ import annotations

import argparse
import os
import plistlib
from pathlib import Path
from typing import Any


def _iter_test_targets(plist: dict[str, Any]) -> list[dict[str, Any]]:
    """Return mutable test target dictionaries for xctestrun v2 and v1 shapes."""

    targets: list[dict[str, Any]] = []

    for config in plist.get("TestConfigurations", []) or []:
        if isinstance(config, dict):
            for target in config.get("TestTargets", []) or []:
                if isinstance(target, dict):
                    targets.append(target)

    # Older xctestrun files used one top-level dictionary per target. Keep the
    # fallback cheap and harmless for future compatibility.
    if not targets:
        for value in plist.values():
            if isinstance(value, dict) and "BlueprintName" in value:
                targets.append(value)

    return targets


def _patch_target(
    target: dict[str, Any],
    *,
    ui_target_app_path: str,
    env_names: list[str],
) -> None:
    target["UITargetAppPath"] = ui_target_app_path

    dependent_paths = target.get("DependentProductPaths")
    if isinstance(dependent_paths, list):
        normalized: list[Any] = []
        for item in dependent_paths:
            if isinstance(item, str) and item.endswith("/MaintenanceFieldApp"):
                normalized.append(ui_target_app_path)
            else:
                normalized.append(item)
        if ui_target_app_path not in normalized:
            normalized.append(ui_target_app_path)
        target["DependentProductPaths"] = normalized

    environment = target.setdefault("EnvironmentVariables", {})
    if not isinstance(environment, dict):
        environment = {}
        target["EnvironmentVariables"] = environment

    for name in env_names:
        environment[name] = os.environ.get(name, "")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("xctestrun", type=Path)
    parser.add_argument("--target", required=True)
    parser.add_argument("--ui-target-app-path", required=True)
    parser.add_argument(
        "--env",
        action="append",
        default=[],
        dest="env_names",
        help="Environment variable name to copy into the test runner",
    )
    args = parser.parse_args()

    with args.xctestrun.open("rb") as handle:
        plist = plistlib.load(handle)

    patched = 0
    for target in _iter_test_targets(plist):
        if target.get("BlueprintName") == args.target:
            _patch_target(
                target,
                ui_target_app_path=args.ui_target_app_path,
                env_names=args.env_names,
            )
            patched += 1

    if patched == 0:
        raise SystemExit(f"target not found in xctestrun: {args.target}")

    with args.xctestrun.open("wb") as handle:
        plistlib.dump(plist, handle, fmt=plistlib.FMT_XML, sort_keys=False)

    print(
        f"patched {args.xctestrun}: {patched} test target(s), "
        f"UITargetAppPath={args.ui_target_app_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
