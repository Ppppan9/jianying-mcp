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

This project was validated by diffing its output against the upstream
reference implementation, field by field.

```bash
npm install && npm run build

# synthetic test media (requires ffmpeg)
bash scripts/make_test_media.sh

# upstream oracle — clone it first, then point JY_UPSTREAM_SKILL at it
git clone https://github.com/luoluoluo22/jianying-editor-skill /tmp/jianying-editor-skill
export JY_UPSTREAM_SKILL=/tmp/jianying-editor-skill
python3 scripts/gen_upstream_same.py

# same inputs through this server
node dist/gen_compare.js ./compare_drafts/mcp

# structural diff
python3 scripts/compare_drafts.py \
    compare_drafts/upstream/Compare_Up \
    compare_drafts/mcp/Compare_Mcp
```

```
[A] Structural diff (normalized): 0 difference(s)
[B] Track layout comparison       → MATCH
[C] Segment timing comparison     → MATCH
VERDICT: PASS — MCP draft matches upstream contract
```

The first implementation attempt produced **62** differences. The full list of
what went wrong — and the exact field-level contract — is documented in
[`docs/DRAFT_FORMAT.md`](docs/DRAFT_FORMAT.md).

A self-contained test suite runs the server over raw JSON-RPC and asserts the
draft contract end to end:

```bash
node dist/verify.js /path/to/test/media ./out_drafts
# Result: 56 passed, 0 failed
```

---

## Layout

```
src/
  draft.ts         # the draft engine — the whole format contract lives here
  server.ts        # MCP protocol layer (zero-dependency JSON-RPC over stdio)
  mcp-client.ts    # minimal MCP client, used by the test harnesses
  verify.ts        # end-to-end verification harness
  gen_compare.ts   # generates the comparison draft
  ad_scenario.ts   # realistic ad-creative walkthrough
plugin/            # ready-to-install MiniMax Code Plugin package
scripts/
  compare_drafts.py      # normalized structural diff vs the upstream oracle
  gen_upstream_same.py   # drives the upstream implementation
  validate_plugin.py     # validates a Plugin package against the V1 spec
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

用上游实现当预言机，逐字段对比两边产出：

```
[A] Structural diff (normalized): 0 difference(s)
[B] Track layout comparison       → MATCH
[C] Segment timing comparison     → MATCH
VERDICT: PASS
```

第一版实现有 **62 处**差异（`speeds` 材质缺失、text 段字段错、`render_index` 不对、素材桶名拼错等），全部记录在 [`docs/DRAFT_FORMAT.md`](docs/DRAFT_FORMAT.md)。

### 已知限制

- **导出必须手动**：macOS 上剪映没有可靠的无头渲染通道
- 只覆盖视频 / 音频 / 文字核心，暂不含关键帧、特效、转场、贴纸
- 不集成剪映云端素材库
- 与字节无关，剪映 / CapCut 是其各自所有者的商标

### 许可

MIT，见 [`LICENSE`](LICENSE)。第三方归属见 [`NOTICE`](NOTICE)。本项目为独立实现，未分发任何上游源码。
