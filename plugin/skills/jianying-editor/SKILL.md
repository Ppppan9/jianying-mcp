---
name: jianying-editor
description: 用 MiniMax 原生 MCP 工具自动生成剪映专业版 (JianYing Pro) 工程草稿——素材排布、字幕、配音、BGM、封面。当用户要"自动剪辑""批量生成剪映工程""做一条短视频""按分镜生成剪映草稿""把素材拼成片"时使用。纯本地文件操作，不调用 GUI 自动化，macOS 与 Windows 通用。
---

# 剪映自动剪辑（MiniMax 版）

用 `jianying-mcp` 的原子工具直接生成剪映草稿。**不要手写 Python/JS 脚本**去拼 JSON——工具已经封装了草稿格式契约。

## 为什么是工具而不是脚本

上游 `jianying-editor-skill` 的做法是：Agent 每次都写一段一次性 Python 脚本丢进项目目录再跑一遍。问题是每次生成结果都不同、出错难复现、还要清理垃圾文件。

本插件把同样的能力做成了**确定性原子工具**：调一次工具 = 完成一次操作 = 拿到一份结构化 JSON 结果。可以直接读结果判断对错，不需要猜。

## 核心机制

剪映草稿就是一个目录，里面 4 个文件 + 一个素材目录：

```
<草稿根目录>/<草稿名>/
  draft_info.json       ← 时间线本体（轨道、片段、素材）
  draft_meta_info.json  ← 工程登记信息
  draft_settings        ← INI 格式的旧版设置
  key_value.json        ← 旧版键值对
  materials/            ← 素材副本（v5.9+ 自包含机制）
```

工具会自动把素材**复制进 `materials/`** 并按 md5 改名，所以草稿可以整体移动、不依赖原始路径。

## 标准流程

### 1. 探素材（必做）

```bash
jianying_probe_media   filePath=/abs/path/clip.mp4
```

拿到时长和分辨率后再排时间轴。凭感觉写时间点必然错位。

### 2. 建工程

```bash
jianying_create_draft  name=广告_解谜关卡_01  fps=30
```

**别手写 width/height**。不传时工具会自动采用第一个视频素材的分辨率（竖屏 1080x1920 / 横屏 1920x1080），这是最不容易出错的用法。只有当素材分辨率和投放规格不一致、且你要按投放规格出片时，才显式指定。

### 3. 排素材

```bash
jianying_add_video  name=广告_解谜关卡_01  filePath=/abs/a.mp4  start=0  duration=3
jianying_add_video  name=广告_解谜关卡_01  filePath=/abs/b.mp4  start=3  duration=4
```

- `start` 省略 = 追加到该轨道末尾
- `track=0` 主画面轨，`track=1` 叠加层（B-roll/画中画）
- `duration` 超出来源时长会**报错**（不静默截断）

### 4. 加声音

```bash
jianying_add_audio  name=...  filePath=/abs/bgm.mp3  start=0  track=0  volume=0.3  fadeIn=1  fadeOut=1
jianying_add_audio  name=...  filePath=/abs/voice.mp3  start=0  track=1  volume=1.0
```

**轨道分工铁律**：BGM 走 `track=0`，人声/配音走 `track=1`。混在一轨会互相盖住。买量素材里人声必须听得清，BGM 压到 0.2~0.4。

### 5. 上字幕

```bash
jianying_add_subtitles  name=...  script="第一句文案。第二句文案。"  start=0.5  duration=15
```

- 中文短视频按 **18 字/行** 拆，工具自动按标点切
- 字幕轨独立，不占视频轨
- 返回的 `lines` 数组要**回读检查**：AI 对数字、专有名词、多音字极易出错

### 6. 保存 + 验收

```bash
jianying_save_draft     name=...
jianying_inspect_draft  name=...
```

保存后草稿立刻出现在剪映首页的工程列表里。

## 验收清单（交付前必查）

- [ ] `jianying_inspect_draft` 返回的轨道数符合预期（至少 1 video / 1 audio / 1 text）
- [ ] 每个 segment 的 `material_id` 都能在 materials 里找到（工具保证，但改过就要查）
- [ ] 字幕总时长和语音轨时长对齐（误差 < 0.5s）
- [ ] BGM 音量 ≤ 0.4，人声 ≥ 0.8
- [ ] 分辨率 = 素材分辨率
- [ ] 字幕文案逐字核对过数字和专有名词

## 导出

**本插件不导出视频。** 草稿生成后必须在剪映专业版里手动导出（macOS 无可靠的无头导出通道，Windows 上游方案依赖 UI Automation，稳定性差且会被版本更新打断）。

字幕可以单独导出核对：

```bash
jianying_export_srt  name=...  outputPath=/abs/out.srt
```

## 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 剪映里看不到草稿 | 草稿根目录不对 | `jianying_list_drafts` 看实际根目录；用 `JY_PROJECTS_ROOT` 指定 |
| 素材显示丢失 | 直接改了 `materials/` 里的文件 | 改素材请改源文件后重新生成草稿 |
| 画面有黑边 | 建工程时分辨率和素材不一致 | 不传 width/height 让它自动适配；或显式对齐素材 |
| 字幕和配音对不上 | 时长分配是均分的 | 用 `jianying_add_text` 手动指定每条的 start |
| 音频听不见 | BGM 和人声同轨 | BGM 用 track=0，人声用 track=1 |

## 批量生产

- 每条广告用**独立草稿名**，不要覆盖已有草稿
- 素材目录按 `01_钩子.mp4` / `02_展示.mp4` 编号，识别质量明显更好
- 先跑一条完整的验证流程，再批量

## 与其它工具的分工

- 本插件：**排结构**（时间轴、轨道、字幕）
- 素材分析、脚本撰写、分镜设计：模型自己完成，或配合专门工具
- 最终审美、版权确认、发布：人来做
