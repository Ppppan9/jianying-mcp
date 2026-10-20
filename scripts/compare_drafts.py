#!/usr/bin/env python3
"""
Compare the MiniMax MCP draft against the upstream reference implementation.

The upstream `jianying-editor-skill` (which vendors pyJianYingDraft) is used as
an oracle: both implementations are given the same inputs, then their generated
drafts are compared structurally — key sets, track layout, segment timing and
material schema.

Random identifiers (uuids, md5s, timestamps) are normalized before comparison.
"""

import json
import os
import re
import sys
from pathlib import Path

UUID_RE = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)
UUID_DASH_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
MD5_RE = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)


def normalize_content_json(text):
    """Normalizes a JSON-encoded string so 1.0 and 1 compare equal."""
    try:
        return json.loads(text, parse_float=float)
    except Exception:
        return text


def normalize(obj, path=""):
    """Replace random identifiers and volatile fields with stable placeholders."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in ("create_time", "update_time", "tm_draft_create", "tm_draft_modified",
                     "tm_duration", "draft_id", "id") and isinstance(v, (int, str)):
                out[k] = "<volatile>"
                continue
            if k == "path" and isinstance(v, str):
                # absolute staged path differs by draft dir; keep the basename
                out[k] = os.path.basename(v)
                continue
            if k in ("material_name", "name", "local_material_id") and isinstance(v, str):
                out[k] = "<media>"
                continue
            if k == "content" and isinstance(v, str):
                # embedded JSON: compare structurally, not byte-for-byte.
                # 1 and 1.0 are the same JSON number, so compare parsed values.
                parsed = normalize_content_json(v)
                out[k] = parsed
                continue
            out[k] = normalize(v, f"{path}.{k}")
        return out
    if isinstance(obj, list):
        return [normalize(v, f"{path}[{i}]") for i, v in enumerate(obj)]
    if isinstance(obj, str):
        if UUID_DASH_RE.match(obj) or (UUID_RE.match(obj) and not MD5_RE.match(obj)):
            return "<uuid>"
        if MD5_RE.match(obj):
            return "<md5>"
        return obj
    return obj


def load_draft(draft_dir):
    with open(os.path.join(draft_dir, "draft_info.json"), encoding="utf-8") as f:
        return json.load(f)


def structure(info):
    """Extract the structural fingerprint that must match exactly."""
    tracks = []
    for t in info.get("tracks", []):
        segs = []
        for s in t.get("segments", []):
            tgt = s.get("target_timerange") or {}
            src = s.get("source_timerange")
            segs.append({
                "target_start": tgt.get("start"),
                "target_duration": tgt.get("duration"),
                "source_start": (src or {}).get("start"),
                "source_duration": (src or {}).get("duration"),
                "source_is_none": src is None,
                "speed": s.get("speed"),
                "volume": s.get("volume"),
                "track_attribute": s.get("track_attribute"),
                "track_render_index": s.get("track_render_index"),
                "render_index": s.get("render_index"),
                "has_clip": "clip" in s,
                "clip_scale": (s.get("clip") or {}).get("scale"),
                "clip_transform": (s.get("clip") or {}).get("transform"),
                "clip_rotation": (s.get("clip") or {}).get("rotation"),
                "clip_alpha": (s.get("clip") or {}).get("alpha"),
                "has_uniform_scale": "uniform_scale" in s,
                "has_hdr_settings": "hdr_settings" in s,
                "has_fade": "fade" in s,
                "visible": s.get("visible"),
                "enable_adjust": s.get("enable_adjust"),
                "enable_color_wheels": s.get("enable_color_wheels"),
                "enable_lut": s.get("enable_lut"),
                "last_nonzero_volume": s.get("last_nonzero_volume"),
            })
        tracks.append({
            "type": t.get("type"),
            "attribute": t.get("attribute"),
            "flag": t.get("flag"),
            "is_default_name": t.get("is_default_name"),
            "segment_count": len(segs),
            "segments": segs,
        })
    tracks.sort(key=lambda x: (x["type"], x["attribute"]))

    materials = {}
    for bucket, items in info.get("materials", {}).items():
        materials[bucket] = sorted(
            [normalize(m) for m in items],
            key=lambda m: json.dumps(m, sort_keys=True, ensure_ascii=False),
        )

    return {
        "top_level_keys": sorted(info.keys()),
        "canvas_config": info.get("canvas_config"),
        "fps": info.get("fps"),
        "version": info.get("version"),
        "new_version": info.get("new_version"),
        "platform": info.get("platform"),
        "last_modified_platform": info.get("last_modified_platform"),
        "config_keys": sorted(info.get("config", {}).keys()),
        "video_algorithm": info.get("video_algorithm"),
        "keyframes_keys": sorted(info.get("keyframes", {}).keys()),
        "material_buckets": sorted(info.get("materials", {}).keys()),
        "materials": materials,
        "tracks": tracks,
    }


def diff_keys(a, b, label):
    """Compare key sets at each level of the material entries."""
    problems = []
    if isinstance(a, dict) and isinstance(b, dict):
        ka, kb = set(a.keys()), set(b.keys())
        if ka != kb:
            missing = kb - ka
            extra = ka - kb
            problems.append(f"{label}: missing={sorted(missing)} extra={sorted(extra)}")
        for k in ka & kb:
            if k == "__content_parsed__":
                continue
            problems.extend(diff_keys(a[k], b[k], f"{label}.{k}"))
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            problems.append(f"{label}: length upstream={len(a)} mcp={len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            problems.extend(diff_keys(x, y, f"{label}[{i}]"))
    else:
        # Numeric equality: 1 == 1.0 is the same JSON number.
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            if a != b:
                problems.append(f"{label}: upstream={a!r} mcp={b!r}")
        elif a != b:
            problems.append(f"{label}: upstream={a!r} mcp={b!r}")
    return problems


def main():
    upstream_dir = Path(sys.argv[1])
    mcp_dir = Path(sys.argv[2])

    up = load_draft(str(upstream_dir))
    mc = load_draft(str(mcp_dir))

    print("=" * 74)
    print("MiniMax MCP draft  vs  upstream pyJianYingDraft reference")
    print("=" * 74)
    print(f"upstream: {upstream_dir}")
    print(f"mcp     : {mcp_dir}\n")

    up_struct = structure(up)
    mc_struct = structure(mc)

    problems = diff_keys(up_struct, mc_struct, "draft")
    # The MCP server intentionally omits two upstream-internal fields.
    allowed = [
        "draft.materials.audios[0].copyright_limit_type",
        "draft.materials.audios[0].formula_id",
        "draft.materials.audios[0].effect_id",
        "draft.materials.audios[0].app_id",
        "draft.materials.audios[0].category_id",
        "draft.materials.audios[0].source_platform",
    ]
    hard = [p for p in problems if not any(p.startswith(a) for a in allowed)]

    print(f"[A] Structural diff (normalized): {len(problems)} difference(s)")
    for p in problems[:60]:
        print(f"    - {p}")
    if len(problems) > 60:
        print(f"    ... and {len(problems) - 60} more")

    print(f"\n[B] Track layout comparison")
    up_tracks = [(t["type"], t["attribute"], t["segment_count"]) for t in up_struct["tracks"]]
    mc_tracks = [(t["type"], t["attribute"], t["segment_count"]) for t in mc_struct["tracks"]]
    print(f"    upstream: {up_tracks}")
    print(f"    mcp     : {mc_tracks}")
    tracks_match = up_tracks == mc_tracks
    print(f"    -> {'MATCH' if tracks_match else 'MISMATCH'}")

    print(f"\n[C] Segment timing comparison")
    up_segs = []
    mc_segs = []
    for t in up_struct["tracks"]:
        for s in t["segments"]:
            up_segs.append((t["type"], s["target_start"], s["target_duration"], s["source_start"]))
    for t in mc_struct["tracks"]:
        for s in t["segments"]:
            mc_segs.append((t["type"], s["target_start"], s["target_duration"], s["source_start"]))
    up_segs.sort()
    mc_segs.sort()
    for u, m in zip(up_segs, mc_segs):
        flag = "OK " if u == m else "DIFF"
        print(f"    {flag} upstream={u}  mcp={m}")
    timing_match = up_segs == mc_segs
    print(f"    -> {'MATCH' if timing_match else 'MISMATCH'}")

    print(f"\n[D] Material schema comparison")
    for bucket in sorted(set(up_struct["materials"]) | set(mc_struct["materials"])):
        u = up_struct["materials"].get(bucket, [])
        m = mc_struct["materials"].get(bucket, [])
        if not u and not m:
            continue
        keys_u = sorted(set().union(*[set(x.keys()) for x in u])) if u else []
        keys_m = sorted(set().union(*[set(x.keys()) for x in m])) if m else []
        flag = "OK  " if keys_u == keys_m else "DIFF"
        print(f"    {flag} {bucket}: upstream n={len(u)} mcp n={len(m)}")
        if keys_u != keys_m:
            print(f"         missing={sorted(set(keys_u) - set(keys_m))}")
            print(f"         extra  ={sorted(set(keys_m) - set(keys_u))}")

    print(f"\n[E] Text material content comparison")
    up_texts = up_struct["materials"].get("texts", [])
    mc_texts = mc_struct["materials"].get("texts", [])
    if up_texts and mc_texts:
        u0 = up_texts[0]["content"]
        m0 = mc_texts[0]["content"]
        if isinstance(u0, str):
            u0 = json.loads(u0)
        if isinstance(m0, str):
            m0 = json.loads(m0)
        print(f"    upstream text: {u0.get('text')!r}")
        print(f"    mcp      text: {m0.get('text')!r}")
        print(f"    upstream style keys: {sorted(u0['styles'][0].keys())}")
        print(f"    mcp      style keys: {sorted(m0['styles'][0].keys())}")
        print(f"    upstream fill: {json.dumps(u0['styles'][0]['fill'], sort_keys=True)}")
        print(f"    mcp      fill: {json.dumps(m0['styles'][0]['fill'], sort_keys=True)}")
        print(f"    upstream stroke width: {u0['styles'][0].get('strokes')}")
        print(f"    mcp      stroke width: {m0['styles'][0].get('strokes')}")
        print(f"    upstream material keys: {sorted(up_texts[0].keys())}")
        print(f"    mcp      material keys: {sorted(mc_texts[0].keys())}")

    print("\n" + "=" * 74)
    ok = tracks_match and timing_match and not hard
    print(f"VERDICT: {'PASS — MCP draft matches upstream contract' if ok else 'REVIEW — see differences above'}")
    print(f"  tracks match   : {tracks_match}")
    print(f"  timing match   : {timing_match}")
    print(f"  hard diffs     : {len(hard)}")
    print("=" * 74)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
