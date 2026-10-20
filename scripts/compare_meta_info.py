#!/usr/bin/env python3
"""
Compares draft_meta_info.json against the upstream template.

The differential harness fingerprints only draft_info.json, so this file was
never actually compared. This script closes that gap.
"""

import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# The reference template lives inside the upstream skill. Its location comes
# from JY_UPSTREAM_SKILL, so the script works on any machine.
UPSTREAM = os.environ.get("JY_UPSTREAM_SKILL", "").strip()
TEMPLATE = (
    Path(UPSTREAM)
    / "scripts"
    / "vendor"
    / "pyJianYingDraft"
    / "assets"
    / "draft_meta_info.json"
    if UPSTREAM
    else REPO / "scripts" / "upstream_template" / "draft_meta_info.json"
)

# Fields whose value legitimately differs per draft.
VOLATILE = {
    "draft_name",
    "draft_root_path",
    "draft_id",
    "draft_fold_path",
    "tm_draft_modified",
    "tm_duration",
    "draft_cover",
}


def main() -> int:
    mine_path = Path(sys.argv[1]) / "draft_meta_info.json"
    if not mine_path.exists():
        print(f"not found: {mine_path}", file=sys.stderr)
        return 2
    if not TEMPLATE.exists():
        print(
            f"reference template not found: {TEMPLATE}\n"
            f"set JY_UPSTREAM_SKILL to a clone of jianying-editor-skill",
            file=sys.stderr,
        )
        return 2

    template = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    mine = json.loads(mine_path.read_text(encoding="utf-8"))

    problems = []

    t_keys, m_keys = set(template), set(mine)
    if t_keys != m_keys:
        problems.append(
            f"key set differs: missing={sorted(t_keys - m_keys)} extra={sorted(m_keys - t_keys)}"
        )

    for key in sorted(t_keys & m_keys):
        if key in VOLATILE:
            continue
        if template[key] != mine[key]:
            problems.append(
                f"{key}: template={json.dumps(template[key], ensure_ascii=False)[:90]} "
                f"mine={json.dumps(mine[key], ensure_ascii=False)[:90]}"
            )

    # The draft id must have the reference's dashed shape.
    draft_id = mine.get("draft_id", "")
    if not (len(draft_id) == 36 and draft_id.count("-") == 4):
        problems.append(f"draft_id is not in the dashed UUID shape: {draft_id!r}")

    print("=" * 70)
    print("draft_meta_info.json vs the upstream template")
    print("=" * 70)
    print(f"  template: {TEMPLATE}")
    print(f"  mine:     {mine_path}")
    print(f"  fields compared: {len(t_keys & m_keys) - len(VOLATILE & (t_keys | m_keys))}")

    if problems:
        print(f"\n  {len(problems)} difference(s):")
        for p in problems:
            print(f"    - {p}")
        print("\n  VERDICT: DIFFERS")
        return 1

    print("\n  VERDICT: MATCH — every comparable field equals the template")
    return 0


if __name__ == "__main__":
    sys.exit(main())
