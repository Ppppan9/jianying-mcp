# jianying-mcp

**Generate JianYing Pro (剪映专业版) draft projects programmatically — as a MiniMax Code Plugin, an MCP server, or a standalone Node library.**

Zero runtime dependencies. Cross-platform (macOS / Windows). No GUI automation.

[English](#english) · [中文](#中文)

---

## What this is

A re-implementation of the JianYing draft-generation capability, rebuilt from
the **JianYing draft file format** rather than from an existing tool's code
path.

The upstream community skill (`jianying-editor-skill`) works by asking the
LLM to write a fresh Python script for every single edit. That produces
non-reproducible output and litters your project with throwaway files. This
project exposes the same capability as **12 deterministic MCP tools** — one
call, one structured result, no code generation.

---

## Why the format was reverse-engineered

The claim "豆包 can control 剪映" circulates widely and is usually wrong.
The actual chain is:

```
豆包 (writes script / storyboard)
   → jianying-editor Skill (writes draft files)
      → 剪映专业版 (opens the draft)
```

**ByteDance's own desktop app does not implement the draft protocol.** A
static analysis of `抖音.app`'s `app.asar` (2320 JavaScript sources, via
[REA](https://github.com/morluto/rea)) found **zero** matches for
`draft_content`, `draft_info`, `lveditor`, `jianying` or `com.lemon.lv`.

So there is no official API and no native bridge. The skill writes draft
files to a local directory, and JianYing picks them up. This project does the
same thing — but with a verified, documented implementation.

---

## Install

### As a MiniMax Code Plugin

```bash
git clone https://github.com/Ppppan9/jianying-mcp.git
cp -r jianying-mcp/plugin ~/.minimax/plugins/jianying-editor
```

Restart MiniMax Code. The plugin is discovered automatically and the
`jianying-editor` MCP server becomes available.

### As a standalone MCP server

```json
{
  "mcpServers": {
    "jianying-editor": {
      "command": "node",
      "args": ["/absolute/path/to/jianying-mcp/dist/server.js"]
    }
  }
}
```

### As a library

```bash
npm install
npm run build
```

---

## Tools

| Tool | Purpose |
|---|---|
| `jianying_create_draft` | Create a project; canvas auto-adapts to the first video |
| `jianying_open_draft` | Open an existing draft and resume editing |
| `jianying_list_drafts` | List drafts with duration and canvas size |
| `jianying_add_video` | Add a video/image clip to a video track |
| `jianying_add_audio` | Add BGM / voiceover / SFX to an audio track |
| `jianying_add_text` | Add a title or a single caption |
| `jianying_add_subtitles` | Add a full subtitle track from a script (~18 chars/line) |
| `jianying_remove_media` | Remove every clip referencing a media file |
| `jianying_save_draft` | Write the draft to disk |
| `jianying_inspect_draft` | Structured timeline summary — the acceptance check |
| `jianying_export_srt` | Export the text track as SRT |
| `jianying_probe_media` | Probe duration / resolution / type of a media file |
| `jianying_close_draft` | Close an open draft and release its memory |

### Guards

The server refuses to produce a broken draft. Each of these raises an
error instead of writing a file JianYing would mis-render:

- **Overlapping clips** on the same track are rejected (adjacent clips are
  fine).
- **Source ranges beyond the media duration** are rejected.
- **A file with a video track cannot be used as an audio material.**
- **Re-opening an already open draft** is refused, so an unsaved timeline is
  never silently discarded.
- **Overwriting a directory that is not a draft** is refused.
- **Unsafe draft names** (`..`, `.`, Windows device names) are rejected.

---

## Example

```bash
# 1. Probe first — never guess durations
jianying_probe_media filePath=/abs/01_hook.mp4
#   → { "kind": "video", "durationSeconds": 3, "width": 1080, "height": 1920 }

# 2. Create the project (canvas auto-adapts to the footage)
jianying_create_draft name=ad_01 fps=30

# 3. Lay the storyboard
jianying_add_video name=ad_01 filePath=/abs/01_hook.mp4 start=0 duration=3
jianying_add_video name=ad_01 filePath=/abs/02_demo.mp4 start=3 duration=4

# 4. Audio: BGM on track 0, narration on track 1
jianying_add_audio name=ad_01 filePath=/abs/bgm.mp3 start=0 track=0 volume=0.25
jianying_add_audio name=ad_01 filePath=/abs/voice.mp3 start=0 track=1 volume=1.0

# 5. Subtitles
jianying_add_subtitles name=ad_01 script="你的前三秒决定完播率。" start=0.5 duration=7

# 6. Save, then verify
jianying_save_draft name=ad_01
jianying_inspect_draft name=ad_01
```

The draft appears in JianYing's project list immediately. **Export is manual**
— see [Limitations](#limitations).

---

## Verification

This project was validated by diffing its output against the reference
implementation, field by field, in three layers.

```bash
npm install && npm run build
bash scripts/make_test_media.sh

# 1. end-to-end functional suite
node dist/verify.js

# 2. differential scenarios against the reference library
export JY_UPSTREAM_SKILL=/path/to/jianying-editor-skill
export JY_UPSTREAM_PYTHON=/path/to/python-with-pymediainfo
node dist/diff_scenarios.js "$JY_UPSTREAM_SKILL" ./test-media ./diff_scenarios

# 3. full-draft diff against the wrapper skill
python3 scripts/gen_upstream_same.py
node dist/gen_compare.js ./compare_drafts/mcp
python3 scripts/compare_drafts.py \
    compare_drafts/upstream/Compare_Up \
    compare_drafts/mcp/Compare_Mcp
```

```
[1] verify.js            Result: 70 passed, 0 failed
[2] diff_scenarios.js    Scenarios: 12 matched, 0 differed
[3] compare_drafts.py    [A] Structural diff: 0 difference(s)
                         VERDICT: PASS
```

Layer 2 is the important one: it drives the **underlying `pyJianYingDraft`
library**, not the wrapper skill, because the wrapper silently drops clip
speed, audio fades and out-of-range validation. It covers still images, clip
speed, source offsets, multiple tracks, audio fades, boundary durations, text
and caption styles, overlaps, out-of-range requests and media removal.

The first implementation attempt produced **62** differences. A later review
against the reference library found **8 more** in areas the basic comparison
never reached — the missing `speeds` materials, wrong per-type segment
fields, a wrong `render_index`, two misspelled material buckets, inverted
clip-speed semantics, and `attribute` being used as a track index instead of
a mute flag. The full contract, including every rule this project enforces,
is in [`docs/DRAFT_FORMAT.md`](docs/DRAFT_FORMAT.md).

`scripts/probe_upstream_contract.py` prints the reference library's actual
behaviour for each rule — use it to re-check anything before changing the
engine.

---

## Layout

```
src/
  draft.ts         # the draft engine — the whole format contract lives here
  server.ts        # MCP protocol layer (zero-dependency JSON-RPC over stdio)
  mcp-client.ts    # minimal MCP client, used by the test harnesses
  verify.ts        # end-to-end verification harness
  diff_scenarios.ts# differential scenarios against the reference library
  gen_compare.ts   # generates the comparison draft
  ad_scenario.ts   # realistic ad-creative walkthrough
plugin/            # ready-to-install MiniMax Code Plugin package
scripts/
  compare_drafts.py          # normalized structural diff vs the reference
  gen_upstream_same.py       # drives the reference wrapper
  probe_upstream_contract.py # prints the reference library's actual rules
  make_test_media.sh         # generates the synthetic test media
  validate_plugin.py         # validates a Plugin package against the V1 spec
docs/
  DRAFT_FORMAT.md        # the reverse-engineered format contract
```

---

## Limitations

- **Export is manual.** JianYing has no reliable headless render path on
  macOS. Generate the draft, open it in JianYing, export by hand.
- **macOS and Windows only** for the drafts themselves; the format is the
  same on both.
- **Core editing only.** The schema supports keyframes, effects, transitions
  and stickers; this implementation covers the video / audio / text core.
- **No cloud assets.** JianYing's cloud music and effect library is not
  integrated.
- **Not affiliated with ByteDance.** JianYing and CapCut are trademarks of
  their respective owners.

---

## License

MIT — see [`LICENSE`](LICENSE).

Acknowledgements and third-party attribution are in [`NOTICE`](NOTICE). This
project is an independent implementation; no upstream source code is
redistributed here.

---

<a name="中文"></a>

## 中文

用 **MCP 工具**直接生成剪映专业版工程草稿：排素材、加字幕配音配乐、保存草稿、导出 SRT。

零运行时依赖，不做 GUI 自动化，macOS / Windows 通用。

### 与现有方案的差别

社区现有的 `jianying-editor-skill` 是让 LLM **每次写一段临时 Python 脚本**再跑一遍 —— 产出不可复现，还会在项目里堆垃圾文件。

本项目把同样的能力做成 **12 个确定性原子工具**：调一次拿一份结构化 JSON，不用写代码。

### 「豆包能操控剪映」的真相

网上流传的说法大多不对。真实链路是：

```
豆包（写脚本/分镜）→ jianying-editor 技能（写草稿文件）→ 剪映（打开草稿）
```

**字节自家桌面壳并不实现剪映草稿协议。** 用 REA 静态分析 `抖音.app` 的 `app.asar`（2320 个 JS 源文件），搜索 `draft_content` / `draft_info` / `lveditor` / `jianying` / `com.lemon.lv` —— **零命中**。

所以不存在官方 API，也不存在原生打通。技能只是往本地草稿目录写文件，剪映自己捡起来。本项目做的是同一件事，但实现经过验证且有完整文档。

### 验证方式

用上游实现当预言机，分三层逐字段对比：

```
[1] verify.js            Result: 70 passed, 0 failed
[2] diff_scenarios.js    Scenarios: 12 matched, 0 differed
[3] compare_drafts.py    [A] Structural diff: 0 difference(s)
                         VERDICT: PASS
```

第 2 层最关键：它驱动的是**底层 `pyJianYingDraft` 库**而不是上游 wrapper —— 因为 wrapper 会静默丢掉变速、音频淡入淡出和越界校验。覆盖静图、变速、源偏移、多轨道、淡入淡出、边界时长、文本与字幕样式、重叠、越界请求、素材移除。

第一版实现有 **62 处**差异。后来对着底层库复审，又挖出 **8 处**之前没覆盖到的：`speeds` 材质缺失、按轨道类型的段字段写错、`render_index` 不对、两个素材桶名拼错、变速语义写反、以及把 `attribute` 当成轨道编号（它其实是静音标志）。完整契约见 [`docs/DRAFT_FORMAT.md`](docs/DRAFT_FORMAT.md)。

### 安全护栏

以下情况会**直接报错**，而不是产出一个剪映会渲染错乱的草稿：

- 同轨道**片段重叠**被拒绝（相邻不算重叠）
- **源时长超出素材**被拒绝
- **含视频轨的文件不能当音频素材**
- **重复打开同名草稿**被拒绝，避免未保存的时间轴被静默丢弃
- **覆盖非草稿目录**被拒绝
- **危险草稿名**（`..`、`.`、Windows 设备名）被拒绝

### 已知限制

- **导出必须手动**：macOS 上剪映没有可靠的无头渲染通道
- 只覆盖视频 / 音频 / 文字核心，暂不含关键帧、特效、转场、贴纸
- 不集成剪映云端素材库
- 与字节无关，剪映 / CapCut 是其各自所有者的商标

### 许可

MIT，见 [`LICENSE`](LICENSE)。第三方归属见 [`NOTICE`](NOTICE)。本项目为独立实现，未分发任何上游源码。
