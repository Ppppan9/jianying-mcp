# JianYing Draft Format (剪映草稿格式契约)

Reverse-engineered on 2026-10-21 by generating real drafts with the upstream
`jianying-editor-skill` (which vendors `pyJianYingDraft`) and diffing the
output field by field.

This document is the authoritative reference for the draft layout implemented
in `src/draft.ts`.

---

## 1. A draft is a directory

JianYing Pro stores each project as a folder:

```
<drafts root>/<draft name>/
├── draft_info.json        # the timeline itself
├── draft_meta_info.json   # project registry entry
├── draft_settings         # legacy settings — INI, not JSON
├── key_value.json         # legacy key/value blob — {}
└── materials/             # self-contained copies of every referenced media
```

### Drafts root location

| Platform | Path |
|---|---|
| macOS | `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft` |
| macOS | `~/Movies/JianyingPro Drafts` |
| macOS (sandboxed) | `~/Library/Containers/com.lemon.lvpro/Data/Library/Application Support/JianyingPro/User Data/Projects/com.lveditor.draft` |
| macOS (sandboxed) | `~/Library/Containers/com.bytedance.JianyingPro/Data/Library/Application Support/JianyingPro/User Data/Projects/com.lveditor.draft` |
| Windows | `%LOCALAPPDATA%\JianyingPro\User Data\Projects\com.lveditor.draft` |
| Windows | `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft` |

Override with the `JY_PROJECTS_ROOT` environment variable.

### The four contract files

`draft_settings` is **INI format**, despite the `.json`-less name:

```ini
[General]
draft_create_time=0
draft_last_edit_time=0
real_edit_keys=1
real_edit_seconds=0
```

`key_value.json` is literally `{}`.

`draft_meta_info.json` has a **fixed key set** — the upstream template is the
reference. Notable entries:

```json
{
  "draft_id": "<MD5 of the draft name, uppercase>",
  "draft_name": "<draft name>",
  "draft_root_path": "<draft name>/draft_info.json",
  "draft_cover": "",
  "draft_is_from_deeplink": "false",
  "draft_materials": [{ "type": 0, "value": [] }, { "type": 1, "value": [] }, { "type": 2, "value": [] }],
  "tm_draft_modified": 0,
  "tm_duration": 0
}
```

---

## 2. `draft_info.json` — the timeline

All durations are **microseconds**.

### Top-level keys

```
business_info, canvas_config, color_space, complement_frame_config, config,
cover, create_time, duration, extra_info, fps, free_render_index_mode_on,
group_container, id, keyframe_graph_list, keyframes, last_modified_platform,
materials, mutable_config, name, new_version, platform, relationships,
render_index_track_mode_on, retouch_cover, source, static_cover_image_path,
time_marks, tracks, update_time, version, video_algorithm
```

Fixed values worth knowing:

| Field | Value |
|---|---|
| `version` | `360000` |
| `new_version` | `"110.0.0"` |
| `platform.app_id` | `3704` |
| `platform.app_source` | `"lv"` |
| `platform.app_version` | `"5.9.0"` |
| `platform.os` | `platform.system().lower()` — `"mac"` on macOS, **not** `"darwin"` |
| `id` | `"91E08AC5-22FB-47e2-9AA0-7DC300FAEA2B"` |

`platform.os` and `last_modified_platform.os` are both written from the host
system at save time.

### `canvas_config`

```json
{ "height": 1080, "ratio": "original", "width": 1920 }
```

When the canvas is not explicitly chosen, **the first video's dimensions
define it**. This avoids black bars around the footage.

### `materials` — 45 buckets

The bucket set is fixed. JianYing may not recognise a draft that is missing
one:

```
ai_translates, audio_balances, audio_effects, audio_fades,
audio_track_indexes, audios, beats, canvases, chromas, color_curves,
digital_humans, drafts, effects, flowers, green_screens, handwrites, hsl,
images, log_color_wheels, loudnesses, manual_deformations, masks,
material_animations, material_colors, multi_language_refs, placeholders,
plugin_effects, primary_color_wheels, realtime_denoises, shapes, smart_crops,
smart_relights, sound_channel_mappings, speeds, stickers, tail_leaders,
text_templates, texts, time_marks, transitions, video_effects,
video_trackings, videos, vocal_beautifys, vocal_separations
```

> Gotcha: the bucket is `chromas` (plural) and `stickers` (plural). Writing
> `chroma` or `sticker` produces a draft JianYing may reject.

### Media materials are self-contained

Every referenced media file is **copied into `materials/`**, named after the
MD5 of its source absolute path:

```
materials/4085af6dc88070f46f6a85fcba56daf1.mp4
```

The `local_material_id` is that MD5 **without** the extension, and
`material_name` is the staged filename with extension. This is what makes a
draft portable — it no longer depends on the original media paths.

### `speeds` material — required per media segment

Every **video and audio** segment needs a matching `speeds` entry, referenced
through `extra_material_refs`:

```json
{ "curve_speed": null, "id": "<uuid>", "mode": 0, "speed": 1.0, "type": "speed" }
```

**Text segments do not get a `speeds` material.** Getting this wrong is the
single most common cause of a draft that opens empty.

### Text material — `content` is a stringified JSON

```json
{
  "id": "<uuid>",
  "content": "{\"styles\":[{\"fill\":{\"alpha\":1.0,\"content\":{\"render_type\":\"solid\",\"solid\":{\"alpha\":1.0,\"color\":[1.0,1.0,1.0]}}},\"range\":[0,6],\"size\":5.0,\"bold\":false,\"italic\":false,\"underline\":false,\"strokes\":[{\"content\":{\"solid\":{\"alpha\":1.0,\"color\":[0.0,0.0,0.0]}},\"width\":0.08000000000000002}]}],\"text\":\"黄金样本字幕\"}",
  "typesetting": 0,
  "alignment": 0,
  "letter_spacing": 0.0,
  "line_spacing": 0.02,
  "line_feed": 1,
  "line_max_width": 0.82,
  "force_apply_line_max_width": false,
  "check_flag": 15,
  "type": "text",
  "global_alpha": 1.0
}
```

Note `content` is a **string**, not a nested object.

**Stroke width must be computed as `width / 100.0 * 0.2`.** Writing the
literal `0.08` is numerically equivalent but byte-different from what the
upstream produces (`0.08000000000000002`). This project reproduces the
upstream expression exactly.

`alignment` defaults to `0` (left).

---

## 3. `tracks` and segments

```json
{
  "attribute": 0,
  "flag": 0,
  "id": "<uuid>",
  "is_default_name": false,
  "name": "",
  "segments": [ ... ],
  "type": "video" | "audio" | "text"
}
```

### Segment serialization differs per track type

This is the part that is easy to get wrong. All three types share the base
fields:

```
enable_adjust: true, enable_color_correct_adjust: false,
enable_color_curves: true, enable_color_match_adjust: false,
enable_color_wheels: true, enable_lut: true,
enable_smart_color_adjust: false, last_nonzero_volume: 1.0,
reverse: false, track_attribute, track_render_index, visible: true,
id, material_id, target_timerange, common_keyframes: [], keyframe_refs: [],
source_timerange, speed, volume, extra_material_refs, is_tone_modify: false
```

Then the per-type differences:

| Field | video | audio | text |
|---|---|---|---|
| `clip` | full object | `null` | full object |
| `uniform_scale` | `{on:true,value:1.0}` | **absent** | `{on:true,value:1.0}` |
| `hdr_settings` | `{intensity:1.0,mode:1,nits:1000}` | `null` | **absent** |
| `source_timerange` | `{start,duration}` | `{start,duration}` | **`null`** |
| `render_index` | `0` | `0` | **`15000`** |
| `clip.transform.y` | `0.0` | — | **`-0.8`** |

Why text differs:

- Text has no source media, so `source_timerange` is `null`.
- Text renders above every visual layer, hence `render_index: 15000`.
- `clip.transform.y = -0.8` places subtitles low on the canvas. The upstream
  source comments this explicitly: *"剪映导入的字幕似乎取此值为 -0.8"*.
- Audio is not visual, so JianYing expects explicit `null`s rather than
  omitted keys.

### `clip` object

```json
{
  "alpha": 1.0,
  "flip": { "horizontal": false, "vertical": false },
  "rotation": 0.0,
  "scale": { "x": 1.0, "y": 1.0 },
  "transform": { "x": 0.0, "y": 0.0 }
}
```

`transform.x` / `transform.y` are in **half-canvas** units.

### `extra_material_refs`

Points at the `speeds` material for this segment (media segments only).

---

## 4. Verification

The implementation in `src/draft.ts` is validated against the upstream
reference implementation by `scripts/compare_drafts.py`, which normalises
UUIDs, MD5s and timestamps, then diffs the two drafts field by field.

```bash
# 1. Generate the upstream oracle draft
python3 scripts/gen_upstream_same.py

# 2. Generate the same draft through this MCP server
node dist/gen_compare.js ./compare_drafts/mcp

# 3. Diff them
python3 scripts/compare_drafts.py \
    compare_drafts/upstream/Compare_Up \
    compare_drafts/mcp/Compare_Mcp
```

Current result: **0 structural differences**, matching track layout and
matching segment timing.

The first implementation attempt produced **62** differences, including the
missing `speeds` materials, the wrong per-type segment fields, the wrong
`render_index`, and two misspelled material buckets.

---

## 5. What this format does **not** do

- **No export.** JianYing has no headless render path on macOS. The draft
  must be opened in JianYing and exported by hand. (The upstream project
  drives Windows UI Automation for this; it is fragile and breaks on app
  updates.)
- **No cloud assets.** The upstream skill can resolve and download JianYing
  cloud music and effects through an internal API. That path is not
  reproduced here — it depends on private endpoints.
- **No keyframes, effects, transitions, stickers.** The draft schema supports
  all of these, but this implementation covers the video / audio / text core.
