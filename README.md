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
| `jianying_open_draft` | Open an existing draft and resume editing it |
| `jianying_list_drafts` | List drafts with duration and canvas size |
| `jianying_add_video` | Add a video/image clip to a video track |
| `jianying_add_audio` | Add BGM / voiceover / SFX to an audio track |
| `jianying_add_text` | Add a title or a single caption (use `track: 1` so it can coexist with captions) |
| `jianying_add_subtitles` | Add a full subtitle track from a script (~18 chars/line) |
| `jianying_remove_media` | Remove every clip referencing a media file, plus its orphaned materials |
| `jianying_save_draft` | Write the draft to disk |
| `jianying_inspect_draft` | Structured timeline summary with caption text — the acceptance check |
| `jianying_export_srt` | Export every text track as SRT |
| `jianying_probe_media` | Probe duration / resolution / type of a media file |
| `jianying_close_draft` | Close an open draft and release its memory |

### Guards

The server refuses to produce a broken draft, and refuses to destroy anything
it was not asked to destroy. Each of these raises an error instead of
silently writing a bad file:

- **Overlapping clips** on the same track are rejected (adjacent clips are
  fine).
- **Source ranges beyond the media duration** are rejected.
- **A file with a video track cannot be used as an audio material**, and an
  audio-only file cannot be used as a video material.
- **Negative start times, durations and fades** are rejected.
- **Re-opening an already open draft** is refused, so an unsaved timeline is
  never silently discarded.
- **Creating a draft whose name already exists on disk** is refused unless
  `overwrite: true` is passed explicitly.
- **Overwriting a directory that is not a draft** is refused.
- **Unsafe draft names** (`..`, `.`, Windows device names) are rejected.
- **`export_srt` refuses to overwrite an existing file** and refuses a
  non-`.srt` output path — the path comes from the caller and could point at
  source media.

A rejected call leaves nothing behind: no orphan material, no copied media
in the draft.

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

# 4. every refusal must actually happen
node dist/guard_coverage.js ./test-media ./out_drafts/guards

# 5. the wire protocol must never leave a caller waiting
node dist/protocol_check.js

# 6. the suite must be able to fail
node dist/mutation_check.js ./test-media

# 7. the documented calls have to work
node dist/docs_check.js

# 8. a hostile draft must not crash the server
node dist/loader_check.js
```

```
[1] verify.js            Result: 171 passed, 0 failed
[2] diff_scenarios.js    Scenarios: 12 matched, 0 differed
[3] compare_drafts.py    [A] Structural diff: 0 difference(s)
                         VERDICT: PASS
[4] compare_meta_info.py VERDICT: MATCH (25 fields vs the reference template)
[5] guard_coverage.js  Guards: 34 enforced, 0 not enforced
[6] protocol_check.js   Protocol: 34 passed, 0 failed
[7] mutation_check.js   Mutations: 31 of 31 caught, 0 survived
[8] docs_check.js      Documentation: 40 passed, 0 failed
[9] loader_check.js    Loader: 20 passed, 0 failed
```

The fifth suite is a different question from the others: not "does the draft
come out right" but "does every refusal actually happen". A guard that is
never reached is a guard that does not protect.

The sixth suite asks the same question of the wire protocol: a request that
arrives must always get an answer, and a message the server cannot read must
produce an error rather than silence. It found that a malformed line, a
non-object message and a request with a null id were all dropped without a
reply — the caller waited forever for an answer that never came.

The seventh suite is the one that keeps the other six honest. It breaks the
engine on purpose, one rule at a time, and the suite has to notice. A green
suite proves nothing until you know it can go red.

The ninth suite feeds the loader hostile files: a draft_info.json holding
an array, a string, null, or an object with no tracks in it, a material bucket whose value is not a
list. It found that those were read as an empty draft — so saving one
would have overwritten the user's file with nothing, and a null would have
thrown a TypeError.

The eighth suite makes the documentation executable. Every call the Skill
file and this README show is sent to the server, and it has to come back
without an argument complaint — the agent follows the documentation, so a
documented call that the server refuses is a documented call that does not
work. It also checks that every tool the server offers is mentioned in the
Skill file; `jianying_remove_media` was missing entirely, so the agent had
no idea it existed.

The differential harness also runs a **load → save round trip**: a draft
seeded with effects, stickers, transitions and a media bin is opened, saved
and compared. It is what catches the silent data loss that a
generate-and-compare check cannot see.

The round trip is compared against the **reference implementation's own**
round trip on the same seed. The question is not whether the two files are
identical — they write the timeline differently — but whether this
implementation keeps what the reference keeps. The reference loads the
whole document and overwrites only the keys it models; everything else
survives. That comparison is what found the top-level and config keys
being dropped, and it names them when they are lost again.

Layer 2 is the important one: it drives the **underlying `pyJianYingDraft`
library**, not the wrapper skill, because the wrapper silently drops clip
speed, audio fades and out-of-range validation. It covers still images, clip
speed, source offsets, multiple tracks, audio fades, boundary durations, text
and caption styles, overlaps, out-of-range requests and media removal.

The implementation went through two review rounds. The first comparison
produced **62** differences. A differential review against the reference
library found **8 more** in areas the basic comparison never reached — the
missing `speeds` materials, wrong per-type segment fields, a wrong
`render_index`, two misspelled material buckets, inverted clip-speed
semantics, and `attribute` being used as a track index instead of a mute
flag. A second, adversarial review found **21 further issues**, of which the
substantive ones were: `create_draft` deleting an existing draft before
refusing to open it, the media cache letting a video track reference an
audio material, `ms` being parsed as minutes, a non-idempotent name
sanitisation that made a draft unaddressable, cover art being mistaken for a
video track, and `export_srt` overwriting whatever file it was pointed at.
A third review of those fixes caught one regression the second round
introduced — a video whose audio track was shorter than its picture had its
material duration truncated to the audio length — along with JPEG stills
being unusable and a malformed track index writing `render_index: null`
into the draft. A fourth review confirmed those fixes and closed the last
residuals: a decoder reporting an unknown duration could still write
`null` into a draft, a still image without an explicit duration became a
40 millisecond blip, and the still-image heuristic broke on ffprobe builds
that report an unknown frame count as `"N/A"`. A fifth review closed the last
residuals: a still image was classified as a `video` material instead of a
`photo`, an animated image's real length was overwritten by the fallback, an
audio file with an unreadable duration was refused instead of falling back,
and a subtitle conflict reported the wrong track. A sixth review caught a
regression in the fifth round — a still image that ffprobe could not read
was written as a `video` material — and exposed a deployment problem: a
GUI-launched app inherits a minimal PATH, so ffprobe, installed by Homebrew
under `/opt/homebrew/bin`, was not on it. The prober now searches the usual
install locations itself. A seventh review found the most serious defect of
all: `jianying_open_draft` advertised "resume editing" but had no loader at
all — it could only delete the draft and hand back an empty timeline, so an
agent that hit the "already exists" error and retried with `overwrite` would
destroy the user's project. The draft is now read back into memory, edited
and saved again without losing anything. The same review found that a single
`maxChars: 0` argument drove the subtitle splitter into a loop that
allocated 2.3 GB before V8 gave up.

A final pass closed the remaining gaps: the draft registry entry now matches
the reference template field for field (it had a different id shape, three
material types instead of seven, and a null where the template has a list),
the macOS draft location now includes the domestic build's container
(`com.lemon.jianyingpro`), an animated GIF is no longer mistaken for a still
image, and the numeric values written straight into the draft — colour
components, alpha, font size, alignment, volume, canvas size and frame rate
— are validated instead of being passed through unchecked.

An eighth review then found that the loader was the weak point: opening a
draft and saving it again stripped every material the engine does not model
(effects, stickers, transitions, masks, keyframes) and could delete the
media bin — clips that are staged but not on the timeline. The reference
implementation carries that material through, and so does this one now. The
round-trip check was added to the harness at the same time, because the
generate-and-compare check could never have caught it.

A further pass found that saving was not atomic: the four files of a draft
were written one after another, so a failure part-way through left a mix of
old and new files. The save now stages every file and renames them into
place together, keeping the previous version aside so it can be restored.
Two more defects came out of probing the paths the earlier rounds had not
touched: a photo in the `images` bucket was moved to `videos` on the way
through, and adding a file that a loaded draft already held created a
duplicate material for it.

The full contract, including every rule now enforced, is in
[`docs/DRAFT_FORMAT.md`](docs/DRAFT_FORMAT.md).

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

## Hands-on verification

The automated suites prove the draft matches the reference implementation
field for field. They cannot prove that JianYing itself opens it, because
the application is not involved in the test.

`npm run verify-drafts` produces three drafts for opening by hand — one
covering the basics (video, music, voice-over, subtitles, a title), one
covering the edges (a still image, a speed change, adjacent clips, a
second video track), and one that is opened, edited and saved again. The
generator makes its own media, so it runs anywhere ffmpeg does.

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
[1] verify.js            Result: 171 passed, 0 failed
[2] diff_scenarios.js    Scenarios: 12 matched, 0 differed
[3] compare_drafts.py    [A] Structural diff: 0 difference(s)
                         VERDICT: PASS
[4] compare_meta_info.py VERDICT: MATCH (25 fields vs the reference template)
[5] guard_coverage.js  Guards: 34 enforced, 0 not enforced
[6] protocol_check.js   Protocol: 34 passed, 0 failed
[7] mutation_check.js   Mutations: 31 of 31 caught, 0 survived
[8] docs_check.js      Documentation: 40 passed, 0 failed
[9] loader_check.js    Loader: 20 passed, 0 failed
```

The fifth suite is a different question from the others: not "does the draft
come out right" but "does every refusal actually happen". A guard that is
never reached is a guard that does not protect.

第六个套件问的是同一个问题的协议层版本：**进来的请求一定要有回音**，读不懂的消息要报错而不是装作没听见。它查出了畸形行、非对象消息、`id: null` 的请求全都被静默丢弃 —— 调用方会一直等一个永远不会来的回复。

第七个套件负责让前六个不敢说谎：它一次故意破坏一条规则，套件必须发现。**绿色的套件在证明它能变红之前，什么都不能证明。**

The differential harness also runs a **load → save round trip**: a draft
seeded with effects, stickers, transitions and a media bin is opened, saved
and compared. It is what catches the silent data loss that a
generate-and-compare check cannot see.

The round trip is compared against the **reference implementation's own**
round trip on the same seed. The question is not whether the two files are
identical — they write the timeline differently — but whether this
implementation keeps what the reference keeps. The reference loads the
whole document and overwrites only the keys it models; everything else
survives. That comparison is what found the top-level and config keys
being dropped, and it names them when they are lost again.

第 2 层最关键：它驱动的是**底层 `pyJianYingDraft` 库**而不是上游 wrapper —— 因为 wrapper 会静默丢掉变速、音频淡入淡出和越界校验。覆盖静图、变速、源偏移、多轨道、淡入淡出、边界时长、文本与字幕样式、重叠、越界请求、素材移除。

第一版实现有 **62 处**差异。后来对着底层库复审，又挖出 **8 处**之前没覆盖到的：`speeds` 材质缺失、按轨道类型的段字段写错、`render_index` 不对、两个素材桶名拼错、变速语义写反、以及把 `attribute` 当成轨道编号（它其实是静音标志）。完整契约见 [`docs/DRAFT_FORMAT.md`](docs/DRAFT_FORMAT.md)。

### 安全护栏

以下情况会**直接报错**，而不是产出一个剪映会渲染错乱的草稿：

- 同轨道**片段重叠**被拒绝（相邻不算重叠）
- **源时长超出素材**被拒绝
- **含视频轨的文件不能当音频素材**，**纯音频文件也不能当视频素材**
- **负数的起点 / 时长 / 淡入淡出**被拒绝
- **必填参数缺失、类型不对、参数名拼错**被拒绝（拼错不会被忽略 —— 否则 `duraton` 会让片段落到错误位置）
- **重复打开同名草稿**被拒绝，避免未保存的时间轴被静默丢弃
- **磁盘上已有同名草稿**时不会自动覆盖，必须显式传 `overwrite=true`
- **覆盖非草稿目录**被拒绝
- **危险草稿名**（`..`、`.`、Windows 设备名）被拒绝
- **SRT 导出不会覆盖已有文件**，也**拒绝非 `.srt` 路径**（路径可能指向你的源素材）

被拒绝的调用**不会留下垃圾**：不残留孤儿素材，也不残留复制进草稿的素材文件，连一个叫 `undefined` 的空草稿都不会建出来。

### 验证过程

实现经过七轮审查。第一轮逐字段比对发现 **62 处**差异；对着底层库做差分复审又挖出 **8 处**之前没覆盖到的（`speeds` 材质缺失、按轨道类型的段字段写错、`render_index` 不对、两个素材桶名拼错、变速语义写反、把 `attribute` 当成轨道编号）。第二轮对抗式审查再发现 **21 项**问题，其中实质性的是：`create_draft` 在拒绝打开前先删掉已有草稿、媒体缓存让视频轨引用到音频素材、`ms` 被解析成分钟、名字净化不幂等导致草稿无法被寻址、封面图被误判成视频轨、以及 `export_srt` 会覆写它被指向的任意文件。第三轮复审这些修复，又抓出一处第二轮**引入**的回归：音轨比画面短的视频，素材时长被截成了音轨长度；同时 JPEG 静帧仍不可用、畸形轨道号会把 `render_index: null` 写进草稿。第四轮复审确认这批修复，并清掉最后几处残留：解码器报"未知时长"时仍会把 `null` 写进草稿、没给时长的静帧会变成 40 毫秒一闪而过、静帧判定在把未知帧数报成 `"N/A"` 的 ffprobe 上会失效。

完整契约见 [`docs/DRAFT_FORMAT.md`](docs/DRAFT_FORMAT.md)。

### 已知限制

- **导出必须手动**：macOS 上剪映没有可靠的无头渲染通道
- 只覆盖视频 / 音频 / 文字核心，暂不含关键帧、特效、转场、贴纸
- 不集成剪映云端素材库
- 与字节无关，剪映 / CapCut 是其各自所有者的商标

### 许可

MIT，见 [`LICENSE`](LICENSE)。第三方归属见 [`NOTICE`](NOTICE)。本项目为独立实现，未分发任何上游源码。
