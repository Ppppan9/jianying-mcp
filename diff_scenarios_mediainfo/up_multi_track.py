
import os, sys, json, shutil, hashlib
SKILL = "/Users/houtao/Minimax/jianying-research/jianying-editor-skill"
sys.path.insert(0, os.path.join(SKILL, "scripts", "vendor"))
import pyJianYingDraft as draft

M = "./test-media"
root = "diff_scenarios_mediainfo/upstream"
name = "Up_multi_track"
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

m1 = draft.VideoMaterial(stage(os.path.join(M, "vid1.mp4")))
m2 = draft.VideoMaterial(stage(os.path.join(M, "vid2.mp4")))
sf.add_track(draft.TrackType.video, "Track2", relative_index=1)
sf.add_track(draft.TrackType.video, "Track3", relative_index=2)
sf.add_segment(draft.VideoSegment(m1, draft.trange(0, 4_000_000)), "Track2")
sf.add_segment(draft.VideoSegment(m2, draft.trange(0, 3_000_000)), "Track3")

sf.dump(os.path.join(draft_dir, "draft_info.json"))
print("SAVED")
