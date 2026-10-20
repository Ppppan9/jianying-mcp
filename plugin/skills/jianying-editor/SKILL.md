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
- `duration` 超出来源时长会**报错**
- **同轨道片段重叠会报错** —— 相邻可以（前者结束正好是后者开始），重叠不行
- `duration` 是**时间轴上占的长度**；配 `speed: 2` 时会消耗 2 倍的源素材

### 4. 加声音

```bash
jianying_add_audio  name=...  filePath=/abs/bgm.mp3  start=0  track=0  volume=0.3  fadeIn=1  fadeOut=1
jianying_add_audio  name=...  filePath=/abs/voice.mp3  start=0  track=1  volume=1.0
```

**轨道分工铁律**：BGM 走 `track=0`，人声/配音走 `track=1`。混在一轨会互相盖住。买量素材里人声必须听得清，BGM 压到 0.2~0.4。

含视频轨的文件（如 mp4）**不能当音频素材**，会报错。

### 5. 上字幕

```bash
jianying_add_subtitles  name=...  script="第一句文案。第二句文案。"  start=0.5  duration=15
```

- 中文短视频按 **18 字/行** 拆，工具自动按标点切；超长无标点句也会硬切
- 字幕轨独立，不占视频轨
- 字幕用**字幕样式**（字号 5 + 黑色描边 + 靠下），这是剪映导入字幕的默认位置
- 要做标题/花字用 `jianying_add_text`，那是**普通文本样式**（字号 8、无描边、居中）
- 返回的 `lines` 数组要**回读检查**：AI 对数字、专有名词、多音字极易出错

**标题和字幕要分轨**：标题用 `track=1`，字幕用默认的 `track=0`。同一轨上时间重叠会被拒绝 —— 这是对的，剪映里两层文字本来就该分开。

```bash
jianying_add_subtitles  name=...  script="字幕内容"  start=0.5  duration=15  track=0
jianying_add_text      name=...  text="3秒上头"  start=0.2  duration=2.5  track=1
```

### 6. 移除素材

```bash
jianying_remove_media  name=...  filePath=/abs/bgm.mp3
```

按**源文件路径**移除：引用这个文件的所有片段（视频/音频轨都算）一起删掉，孤儿素材也会顺手清干净。

- 要删的是**一个文件的所有片段**，不是某一个片段 —— 同一个文件加过两次就会一次删光
- 素材换了位置就用新路径再调一次；工具找不到匹配就**什么都不做**，不会误删同名文件
- 删完记得重新 `jianying_inspect_draft` 看一眼时长对不对

### 7. 保存 + 验收

```bash
jianying_save_draft     name=...
jianying_inspect_draft  name=...
```

保存后草稿立刻出现在剪映首页的工程列表里。

### 8. 收工

```bash
jianying_close_draft    name=...
```

用完关掉，释放内存。同名草稿不能重复打开（会丢掉未保存的改动）。

## 验收清单（交付前必查）

- [ ] `jianying_inspect_draft` 返回的轨道数符合预期（至少 1 video / 1 audio / 1 text）
- [ ] 每个 segment 的 `material_id` 都能在 materials 里找到（工具保证，但改过就要查）
- [ ] 字幕总时长和语音轨时长对齐（误差 < 0.5s）
- [ ] BGM 音量 ≤ 0.4，人声 ≥ 0.8
- [ ] 分辨率 = 素材分辨率
- [ ] 字幕文案逐字核对过数字和专有名词
- [ ] 素材没有用同一个文件反复导入造成冗余（`remove_media` 会一并清掉孤儿素材）

## 工具会主动拦住你的错误

这些不是"建议"，是**会直接报错**的：

| 情况 | 报错 |
|---|---|
| 必填参数缺失 / 类型不对 | `Invalid arguments for ...`（例如 `"name" is required`） |
| 参数名拼错（如 `duraton`） | `unknown argument "duraton"`（**不会被忽略**，否则片段会落到错误位置） |
| 同轨道片段重叠 | `SegmentOverlap` |
| 源时长超出素材 | `exceeds media duration` |
| 拿含视频轨的文件当音频 | `must not contain a video track` |
| 拿音频文件当视频素材 | `must not be an audio-only file` |
| 负数的起点 / 时长 / 淡入淡出 | `must not be negative` |
| `maxChars` 小于 1 | `must be a number of at least 1` |
| 颜色分量不是 3 个 / alpha 不在 0~1 / 字号为负 / 对齐值非法 | `Invalid colour` / `Invalid alpha` / `Invalid font size` / `Invalid align` |
| 音量不在 0~1 | `Invalid volume` |
| 重复打开同名草稿 | `already open`（防止丢未保存的改动） |
| 建同名草稿时磁盘上已有 | `already exists`（要覆盖得显式传 `overwrite=true`） |
| 覆盖不是草稿的目录 | `does not look like a JianYing draft` |
| 草稿名是 `..` / `.` / Windows 设备名 | `Invalid draft name` |
| SRT 导出到已存在的文件 | `Refusing to overwrite`（要覆盖得显式传 `overwrite=true`） |
| SRT 导出到非 `.srt` 路径 | `must end in .srt` |

看到这些报错就按提示改参数，**不要绕过去** —— 它们拦下的都是剪映会渲染错乱、或者会毁掉你已有文件的情况。

被拒绝的调用**不会留下垃圾**：不会残留孤儿素材，也不会残留复制到草稿里的素材文件，连一个叫 `undefined` 的空草稿都不会建出来。

`track` / `width` / `height` / `fps` 这几个参数写成数字字符串（`track="1"`）会被正常识别；写成非数字（`track="第一轨"`）会直接报错，不会悄悄变成 0 号轨。

## 打开已有草稿并续编

`jianying_open_draft` 会把已有草稿读回内存，可以接着改再保存，**不会删掉原来的东西**。

```bash
jianying_open_draft   name=广告_解谜关卡_01     # 读回已有草稿
jianying_add_text    name=广告_解谜关卡_01  text=新标题  start=0  duration=2
jianying_save_draft  name=广告_解谜关卡_01     # 保存，保留原有内容
jianying_close_draft name=广告_解谜关卡_01     # 用完关掉
```

只有**故意丢弃**已有草稿时才用 `overwrite=true` —— 那会删掉原工程。

保存时会原样带回草稿里你看不到的部分：特效、贴纸、转场、蒙版、关键帧，以及**素材库里还没上时间轴的片段**。这些不会被清理掉。

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
