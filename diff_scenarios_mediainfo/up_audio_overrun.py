
import os, sys, json, shutil, hashlib
SKILL = "/Users/houtao/Minimax/jianying-research/jianying-editor-skill"
sys.path.insert(0, os.path.join(SKILL, "scripts", "vendor"))
import pyJianYingDraft as draft

M = "./test-media"
root = "diff_scenarios_mediainfo/upstream"
name = "Up_audio_overrun"
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

amat = draft.AudioMaterial(stage(os.path.join(M, "bgm.mp3")))
sf.add_track(draft.TrackType.audio)
try:
    sf.add_segment(draft.AudioSegment(amat, draft.trange(0, 99_000_000)))
    print("OVERRUN_ALLOWED")
except Exception as e:
    print("OVERRUN_REJECTED:", type(e).__name__)

sf.dump(os.path.join(draft_dir, "draft_info.json"))
print("SAVED")
