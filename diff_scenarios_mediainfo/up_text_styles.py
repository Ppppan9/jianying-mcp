
import os, sys, json, shutil, hashlib
SKILL = "/Users/houtao/Minimax/jianying-research/jianying-editor-skill"
sys.path.insert(0, os.path.join(SKILL, "scripts", "vendor"))
import pyJianYingDraft as draft

M = "./test-media"
root = "diff_scenarios_mediainfo/upstream"
name = "Up_text_styles"
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
sf.add_segment(draft.TextSegment("第一行字幕", draft.trange(0, 2_000_000)))
sf.add_segment(draft.TextSegment("Second line", draft.trange(2_000_000, 2_000_000)))

sf.dump(os.path.join(draft_dir, "draft_info.json"))
print("SAVED")
