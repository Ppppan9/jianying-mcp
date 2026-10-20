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

### `audio_fades` material — audio fades live in their own bucket

A fade is **not** a field on the segment. It is a separate material in the
`audio_fades` bucket, referenced through `extra_material_refs`:

```json
{ "id": "<uuid>", "fade_in_duration": 1000000, "fade_out_duration": 1000000,
  "fade_type": 0, "type": "audio_fade" }
```

A segment with a fade therefore carries **two** entries in
`extra_material_refs`: its speed material and its fade material.

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

**`check_flag` is a bitmask** of the effects a text material carries:

| Bit | Meaning |
|---|---|
| `7` | base, always set |
| `8` | has a border (outline) |
| `16` | has a background |
| `32` | has a shadow |

So a plain text run is `check_flag: 7` with an empty `strokes` array; a run
with a black outline is `check_flag: 15`.

The material `type` is `"subtitle"` only when the style enables auto-wrapping
(`auto_wrapping: true`); otherwise it is `"text"`. The reference
implementation does not enable auto-wrapping, so subtitles created through it
are `"text"` as well.

### Two text presets

The upstream library exposes the raw defaults; the upstream *skill* wraps
them with a caption look. This project keeps the two cases separate:

| | `jianying_add_text` | `jianying_add_subtitles` |
|---|---|---|
| size | 8.0 | 5.0 |
| outline | none | black, width 40 (→ `0.08000000000000002`) |
| `clip.transform.y` | `0.0` | `-0.8` |
| material `type` | `"text"` | `"text"` |

Plain text uses the library defaults. Captions get the smaller outlined style
and sit low on the canvas, which is where JianYing places imported subtitles.

---

## 3. `tracks` and segments

```json
{
  "attribute": 0,
  "flag": 0,
  "id": "<uuid>",
  "is_default_name": false,
  "name": "VideoTrack",
  "segments": [ ... ],
  "type": "video" | "audio" | "text"
}
```

### `attribute` is the mute flag, not a track index

This is the easiest field to get wrong. In the schema:

- `attribute` = `int(mute)` — it is `0` for every track that is not muted.
- The **stacking order** is `render_index`, not `attribute`.

Track names are what distinguish two tracks of the same type. The reference
implementation names the first track of each type `VideoTrack`, `Audio` and
`Subtitles`.

### Base render index per track type

`render_index` = the type's base index + the track's relative index among
tracks of that type:

| Track type | Base render index |
|---|---|
| video | 0 |
| audio | 0 |
| text | 15000 |

The reference implementation leaves the relative index at 0, so every track of
a type shares its base index — only text differs, at 15000.

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

Points at the `speeds` material for this segment, and at the `audio_fade`
material when the segment has a fade.

### Clip speed

`duration` is the length of the **timeline slot**. How much source material
that consumes depends on the speed:

| Inputs | source range | target range | speed |
|---|---|---|---|
| `duration` only | `duration × speed` | `duration` | as given |
| `duration` + `speed` | `duration × speed` | `duration` | as given |
| `sourceStart` only | rest of the file | rest of the file | 1 |

With `speed: 2` and `duration: 2s`, the clip occupies 2 seconds on the
timeline and consumes 4 seconds of source material.

---

## 4. Validation rules the reference implementation enforces

These are not optional. A draft that violates them opens incorrectly or
renders unpredictably, so this project rejects them up front rather than
producing a broken file.

| Rule | Error |
|---|---|
| Two segments on the same track may not overlap | `SegmentOverlap` |
| A source range may not exceed the media duration | `ValueError` |
| A file with a video track may not be used as an audio material | `ValueError` |
| Adjacent segments (one ends exactly where the next begins) are valid | — |

Overlap is computed as `not (a.end <= b.start or b.end <= a.start)`, so
touching segments do not overlap.

---

## 5. Media classification

A still image exposes a video stream but reports no duration. The reference
implementation falls back to **10 seconds** and keeps the material classified
as `video`, so PNG and other images land in the `videos` bucket, not `images`.

An image with no decodable stream at all is treated as a `photo` with a
3-hour duration.

---

## 6. Verification

The implementation in `src/draft.ts` is validated in three layers.

### Layer 1 — end-to-end functional suite

```bash
bash scripts/make_test_media.sh
node dist/verify.js
```

Drives the server over raw JSON-RPC and asserts the contract end to end:
tool surface, draft lifecycle, on-disk layout, segment serialization,
referential integrity, error handling and the safety guards.

### Layer 2 — differential scenarios against the reference library

```bash
export JY_UPSTREAM_SKILL=/path/to/jianying-editor-skill
export JY_UPSTREAM_PYTHON=/path/to/python-with-pymediainfo
node dist/diff_scenarios.js "$JY_UPSTREAM_SKILL" ./test-media ./diff_scenarios
```

Each scenario is generated twice — once by the reference `pyJianYingDraft`
library and once by this server — and the two drafts are diffed field by
field. The reference is the **underlying library**, not the wrapper skill,
because the wrapper silently drops clip speed, audio fades and out-of-range
validation.

Covered scenarios: still images, clip speed, source offsets, multiple tracks,
audio fades, exact boundary durations, text styles, caption styles,
overlapping clips, out-of-range durations, video-as-audio, adjacent clips and
the removal of media.

### Layer 3 — full-draft diff against the wrapper skill

```bash
python3 scripts/gen_upstream_same.py
node dist/gen_compare.js ./compare_drafts/mcp
python3 scripts/compare_drafts.py \
    compare_drafts/upstream/Compare_Up \
    compare_drafts/mcp/Compare_Mcp
```

Current result: **0 structural differences**, matching track layout and
matching segment timing.

The first implementation attempt produced **62** differences. A later review
against the reference library found **8 more** in areas the basic comparison
never reached — the missing `speeds` materials, the wrong per-type segment
fields, the wrong `render_index`, two misspelled material buckets, inverted
clip-speed semantics, and `attribute` being used as a track index instead of
a mute flag. All of them are fixed.

### Probing the reference contract directly

```bash
python3 scripts/probe_upstream_contract.py
```

Prints the reference library's actual behaviour for multi-track render
indices, clip speed, audio fades, out-of-range durations, overlap, image
classification and audio material validation. Use it to re-check any rule
before changing the engine.

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
