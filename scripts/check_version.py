#!/usr/bin/env python3
"""
Checks that the versions in the repository agree with each other.

The package version, the Plugin manifest version and the version the server
reports have to be the same number. They drifted apart once already: the
Plugin was on 1.20.0 while the package still said 1.0.0, so the MCP server
introduced itself as 1.0.0.

Usage:
    python3 scripts/check_version.py
"""

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ cannot read {path}: {exc}")
        return None


def main() -> int:
    package = read_json(REPO / "package.json")
    manifest = read_json(REPO / "plugin" / ".minimax-plugin" / "plugin.json")
    if package is None or manifest is None:
        return 1

    package_version = package.get("version")
    manifest_version = manifest.get("version")

    problems = []
    if package_version != manifest_version:
        problems.append(
            f"package.json says {package_version}, the Plugin manifest says {manifest_version}"
        )

    # The server reports whatever it finds in the manifest or the package
    # file, so a stale copy in the bundle is the remaining risk.
    server = REPO / "src" / "server.ts"
    try:
        source = server.read_text(encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ cannot read {server}: {exc}")
        return 1
    if re.search(r'version:\s*"[\d.]+"', source):
        problems.append(
            "src/server.ts has a hard-coded version; it should read the manifest"
        )

    if problems:
        print("\n  ✗ the versions do not agree:")
        for problem in problems:
            print(f"      - {problem}")
        print()
        return 1

    print(f"  ✓ versions agree: {package_version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
