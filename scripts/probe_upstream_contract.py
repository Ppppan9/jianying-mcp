#!/usr/bin/env python3
"""
Probes the underlying pyJianYingDraft library (not the wrapper skill) for the
behaviours the wrapper does not expose: multi-track render indices, clip
speed, audio fades and out-of-range durations.

This is the authoritative contract for the draft format — the wrapper skill
simply does not expose all of it.
"""

import json
import os
import sys
import tempfile

SKILL = os.environ.get("JY_UPSTREAM_SKILL", "")
if not SKILL:
    print("set JY_UPSTREAM_SKILL to a clone of jianying-editor-skill", file=sys.stderr)
    sys.exit(2)

sys.path.insert(0, os.path.join(SKILL, "scripts", "vendor"))

import pyJianYingDraft as draft  # noqa: E402

MEDIA = os.environ.get("JY_TEST_MEDIA", "")
OUT = tempfile.mkdtemp(prefix="jy-probe-")

results = {}

# --- multi-track render indices -------------------------------------------
sf = draft.ScriptFile(1920, 1080, 30, False)
sf.add_track(draft.TrackType.video, "Track2")
sf.add_track(draft.TrackType.video, "Track3")
sf.add_track(draft.TrackType.audio, "Audio")
sf.add_track(draft.TrackType.text, "Subtitles")
print("=== multi-track render indices ===")
for name, track in sf.tracks.items():
    print(f"  {name}: render_index={track.render_index} mute={track.mute}")

# --- clip speed ------------------------------------------------------------
print("\n=== clip speed ===")
mat = draft.VideoMaterial(os.path.join(MEDIA, "vid1.mp4"))
seg_speed = draft.VideoSegment(mat, draft.trange(0, 2_000_000), speed=2.0)
print(f"  speed=2, target=2s -> source={seg_speed.source_timerange} target={seg_speed.target_timerange} speed={seg_speed.speed}")

seg_src = draft.VideoSegment(
    mat,
    draft.trange(0, 1_000_000),
    source_timerange=draft.trange(1_000_000, 2_000_000),
    speed=2.0,
)
print(f"  speed=2, source=2s -> source={seg_src.source_timerange} target={seg_src.target_timerange} speed={seg_src.speed}")

seg_src_nospd = draft.VideoSegment(
    mat,
    draft.trange(0, 1_000_000),
    source_timerange=draft.trange(0, 2_000_000),
)
print(f"  no speed, source=2s -> source={seg_src_nospd.source_timerange} target={seg_src_nospd.target_timerange} speed={seg_src_nospd.speed}")

# --- audio fade ------------------------------------------------------------
print("\n=== audio fade ===")
amat = draft.AudioMaterial(os.path.join(MEDIA, "bgm.mp3"))
aseg = draft.AudioSegment(amat, draft.trange(0, 3_000_000))
aseg.add_fade(1_000_000, 1_000_000)
print(f"  fade export: {json.dumps(aseg.fade.export_json(), sort_keys=True)}")
print(f"  segment extra_material_refs: {aseg.extra_material_refs}")

# --- out-of-range duration -------------------------------------------------
print("\n=== out-of-range duration ===")
try:
    bad = draft.AudioSegment(amat, draft.trange(0, 99_000_000))
    print(f"  AudioSegment 99s accepted: source={bad.source_timerange}")
except Exception as exc:
    print(f"  AudioSegment 99s rejected: {type(exc).__name__}: {exc}")

# --- overlap ---------------------------------------------------------------
print("\n=== overlap ===")
sf2 = draft.ScriptFile(1920, 1080, 30, False)
sf2.add_track(draft.TrackType.video)
try:
    sf2.add_segment(draft.VideoSegment(mat, draft.trange(0, 4_000_000)))
    sf2.add_segment(draft.VideoSegment(mat, draft.trange(2_000_000, 3_000_000)))
    print("  overlapping segments accepted")
except Exception as exc:
    print(f"  overlapping segments rejected: {type(exc).__name__}: {exc}")

# --- adjacent (touching) segments -----------------------------------------
try:
    sf2.add_segment(draft.VideoSegment(mat, draft.trange(4_000_000, 3_000_000)))
    print("  adjacent segments accepted")
except Exception as exc:
    print(f"  adjacent segments rejected: {type(exc).__name__}: {exc}")

# --- photo material classification ----------------------------------------
print("\n=== photo material ===")
try:
    pm = draft.VideoMaterial(os.path.join(MEDIA, "photo.png"))
    print(f"  png: type={pm.material_type} duration={pm.duration} size={pm.width}x{pm.height}")
except Exception as exc:
    print(f"  png probe failed: {type(exc).__name__}: {exc}")

# --- audio material validation --------------------------------------------
print("\n=== audio material validation ===")
try:
    bad_audio = draft.AudioMaterial(os.path.join(MEDIA, "vid1.mp4"))
    print("  video file accepted as audio material")
except Exception as exc:
    print(f"  video file rejected as audio: {type(exc).__name__}: {exc}")

results["out"] = OUT
print(f"\nprobe artifacts: {OUT}")
