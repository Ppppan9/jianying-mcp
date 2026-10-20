#!/usr/bin/env python3
"""
Oracle generator: produces an upstream (pyJianYingDraft) draft from the same
inputs the MCP server receives, so the two can be compared apples-to-apples.

Requires the upstream skill to be cloned locally:

    git clone https://github.com/luoluoluo22/jianying-editor-skill

Then point JY_UPSTREAM_SKILL at it and run:

    python3 scripts/gen_upstream_same.py
"""

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

SKILL = os.environ.get("JY_UPSTREAM_SKILL", "").strip()
if not SKILL:
    print(
        "Set JY_UPSTREAM_SKILL to a clone of "
        "https://github.com/luoluoluo22/jianying-editor-skill\n"
        "  export JY_UPSTREAM_SKILL=/path/to/jianying-editor-skill",
        file=sys.stderr,
    )
    sys.exit(2)

sys.path.insert(0, os.path.join(SKILL, "scripts"))

try:
    from jy_wrapper import JyProject  # noqa: E402
except ImportError as exc:  # pragma: no cover
    print(f"Cannot import jy_wrapper from {SKILL}: {exc}", file=sys.stderr)
    sys.exit(2)

MEDIA = Path(os.environ.get("JY_TEST_MEDIA", REPO_ROOT / "test-media")).resolve()
ROOT = Path(
    os.environ.get("JY_COMPARE_ROOT", REPO_ROOT / "compare_drafts" / "upstream")
).resolve()

p = JyProject("Compare_Up", width=1920, height=1080, drafts_root=str(ROOT), overwrite=True)
p.add_media_safe(str(MEDIA / "vid1.mp4"), "0s")
p.add_media_safe(str(MEDIA / "vid2.mp4"), "4s")
p.add_media_safe(str(MEDIA / "bgm.mp3"), "0s", track_name="Audio")
p.add_text_simple("黄金样本字幕", start_time="1s", duration="3s")
p.save()
print("UPSTREAM SAVED")
