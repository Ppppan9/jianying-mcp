#!/usr/bin/env python3
"""
Round-trips a draft through the reference implementation.

The reference loads the whole draft_info.json into a document and, on save,
overwrites only the keys it models. Everything else survives. This script
produces the reference's own round-trip output so the two can be compared
on which keys survived — the property that decides whether a user's file
loses anything.

Usage:
    python3 scripts/roundtrip_upstream.py <seedDir> <outDir>

Requires the upstream skill to be cloned locally:

    export JY_UPSTREAM_SKILL=/path/to/jianying-editor-skill
"""

import json
import os
import sys
from pathlib import Path

SKILL = os.environ.get("JY_UPSTREAM_SKILL", "").strip()
if not SKILL:
    print(
        "Set JY_UPSTREAM_SKILL to a clone of "
        "https://github.com/luoluoluo22/jianying-editor-skill",
        file=sys.stderr,
    )
    sys.exit(2)

# The underlying library, not the wrapper: the wrapper is a thin convenience
# layer, and the library is what defines the format.
sys.path.insert(0, os.path.join(SKILL, "scripts", "vendor"))
sys.path.insert(0, os.path.join(SKILL, "scripts"))

try:
    import pyJianYingDraft as draft  # noqa: E402
except ImportError as exc:  # pragma: no cover
    print(f"Cannot import pyJianYingDraft from {SKILL}: {exc}", file=sys.stderr)
    sys.exit(2)


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: roundtrip_upstream.py <seedDir> <outDir>", file=sys.stderr)
        return 2

    seed_dir = Path(sys.argv[1]).resolve()
    out_dir = Path(sys.argv[2]).resolve()
    seed_info = seed_dir / "draft_info.json"
    if not seed_info.exists():
        print(f"No draft_info.json in {seed_dir}", file=sys.stderr)
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)
    out_info = out_dir / "draft_info.json"

    script = draft.ScriptFile.load_template(str(seed_info))
    script.dump(str(out_info))

    seed = json.loads(seed_info.read_text(encoding="utf-8"))
    result = json.loads(out_info.read_text(encoding="utf-8"))

    seed_top = set(seed.keys())
    seed_config = set((seed.get("config") or {}).keys())
    seed_buckets = set((seed.get("materials") or {}).keys())

    summary = {
        "top_level_survived": sorted(key for key in result if key in seed_top),
        "top_level_lost": sorted(key for key in seed_top if key not in result),
        "config_survived": sorted(
            key for key in (result.get("config") or {}) if key in seed_config
        ),
        "config_lost": sorted(
            key for key in seed_config if key not in (result.get("config") or {})
        ),
        "buckets_survived": sorted(
            key for key in (result.get("materials") or {}) if key in seed_buckets
        ),
        "buckets_lost": sorted(
            key for key in seed_buckets if key not in (result.get("materials") or {})
        ),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
