
import os, sys, json, shutil, hashlib
SKILL = "/Users/houtao/Minimax/jianying-research/jianying-editor-skill"
sys.path.insert(0, os.path.join(SKILL, "scripts", "vendor"))
import pyJianYingDraft as draft

M = "./test-media"
root = "diff_scenarios_mediainfo/upstream"
name = "Up_subtitle_style"
draft_dir = os.path.join(root, name)
os.makedirs(os.path.join(draft_dir, "materials"), exist_ok=True)

def stage(src):
    """Copy media into the draft's materials folder, md5-named like the MCP server."""
    src = os.path.abspath(src)
    digest = hashlib.md5(src.encode("utf-8")).hexdigest()
    ext = os.path.splitext(src)[1]
    staged = os.path.join(draft_dir, "materials", digest + ext)
    shutil.copy2(src, staged)
    return staged

sf = draft.ScriptFile(1920, 1080, 30, False)

sf.add_track(draft.TrackType.text)
seg = draft.TextSegment(
    "字幕测试",
    draft.trange(0, 2_000_000),
    style=draft.TextStyle(size=5.0),
    border=draft.TextBorder(color=(0.0, 0.0, 0.0), alpha=1.0, width=40.0),
    clip_settings=draft.ClipSettings(transform_y=-0.8),
)
sf.add_segment(seg)

sf.dump(os.path.join(draft_dir, "draft_info.json"))
print("SAVED")
