#!/usr/bin/env node
/**
 * Generates the drafts used for the hands-on JianYing verification.
 *
 * Each draft exercises a different part of the format, so a single run in
 * JianYing tells us which capability works and which does not.
 *
 * Usage: node dist/make_verify_drafts.js <mediaDir> <outDir>
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpClient } from "./mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.js");

const MEDIA = process.argv[2];
const OUT = process.argv[3];

if (!MEDIA || !OUT) {
  console.error("Usage: node dist/make_verify_drafts.js <mediaDir> <outDir>");
  process.exit(2);
}

const media = (name: string) => path.join(MEDIA, name);

/**
 * Generates the media the drafts need, so the whole set can be produced on a
 * machine with nothing but ffmpeg.
 */
function ensureMedia(): void {
  fs.mkdirSync(MEDIA, { recursive: true });
  const have = (name: string) => fs.existsSync(media(name));
  const run = (args: string[]) => {
    try {
      execFileSync("ffmpeg", args, { stdio: "ignore" });
    } catch {
      console.warn(
        `  ! ffmpeg failed for ${args[args.length - 1]}; reusing whatever is there.`,
      );
    }
  };

  const clips: Array<[string, number]> = [
    ["01_开场.mp4", 3],
    ["02_演示.mp4", 4],
    ["03_结尾.mp4", 3],
  ];
  for (const [name, seconds] of clips) {
    if (have(name)) continue;
    run([
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=size=1080x1920:rate=30:duration=${seconds}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", media(name),
    ]);
  }
  if (!have("04_静帧.png")) {
    run([
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=orange:size=1080x1920",
      "-frames:v", "1", media("04_静帧.png"),
    ]);
  }
  for (const [name, freq] of [["05_背景音乐.mp3", 300], ["06_配音.mp3", 180]] as const) {
    if (have(name)) continue;
    run([
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=12`,
      "-c:a", "libmp3lame", media(name),
    ]);
  }
}

async function main() {
  ensureMedia();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const client = new McpClient(SERVER, { JY_PROJECTS_ROOT: OUT });
  await client.initialize();

  // ---------------------------------------------------------------------
  // 1. 基础 —— 视频 + 背景音乐 + 字幕 + 标题
  // ---------------------------------------------------------------------
  const basic = "01_基础_视频音乐字幕";
  await client.call("jianying_create_draft", {
    name: basic, width: 1080, height: 1920, fps: 30, overwrite: true,
  });
  await client.call("jianying_add_video", {
    name: basic, filePath: media("01_开场.mp4"), start: 0, duration: 3,
  });
  await client.call("jianying_add_video", {
    name: basic, filePath: media("02_演示.mp4"), start: 3, duration: 4,
  });
  await client.call("jianying_add_video", {
    name: basic, filePath: media("03_结尾.mp4"), start: 7, duration: 3,
  });
  await client.call("jianying_add_audio", {
    name: basic, filePath: media("05_背景音乐.mp3"), start: 0, track: 0,
    volume: 0.3, fadeIn: 1, fadeOut: 1,
  });
  await client.call("jianying_add_audio", {
    name: basic, filePath: media("06_配音.mp3"), start: 0, track: 1, volume: 1,
  });
  await client.call("jianying_add_subtitles", {
    name: basic, start: 0.5, duration: 9, maxChars: 12,
    script: "解压超解压，一秒就上头。三消关卡，越玩越瘾。现在下载，领百抽。",
  });
  await client.call("jianying_add_text", {
    name: basic, text: "3秒上头", start: 0.2, duration: 2.5, track: 1,
    style: { size: 9, bold: true, color: [1, 0.85, 0.1], align: 1 },
  });
  await client.call("jianying_save_draft", { name: basic });

  // ---------------------------------------------------------------------
  // 2. 边界 —— 静帧 + 变速 + 多轨叠加 + 相邻片段
  // ---------------------------------------------------------------------
  const edge = "02_边界_静帧变速多轨";
  await client.call("jianying_create_draft", {
    name: edge, width: 1080, height: 1920, fps: 30, overwrite: true,
  });
  // 静帧
  await client.call("jianying_add_video", {
    name: edge, filePath: media("04_静帧.png"), start: 0, duration: 2,
  });
  // 变速（2 倍速）
  await client.call("jianying_add_video", {
    name: edge, filePath: media("01_开场.mp4"), start: 2, duration: 1.5, speed: 2,
  });
  // 相邻片段
  await client.call("jianying_add_video", {
    name: edge, filePath: media("02_演示.mp4"), start: 3.5, duration: 4,
  });
  // 叠加层（第二条视频轨）
  await client.call("jianying_add_video", {
    name: edge, filePath: media("03_结尾.mp4"), start: 3.5, duration: 3, track: 1,
  });
  await client.call("jianying_add_audio", {
    name: edge, filePath: media("05_背景音乐.mp3"), start: 0, track: 0, volume: 0.35,
  });
  await client.call("jianying_add_text", {
    name: edge, text: "静帧 / 2倍速 / 相邻 / 叠加", start: 0, duration: 2, track: 1,
  });
  await client.call("jianying_save_draft", { name: edge });

  // ---------------------------------------------------------------------
  // 3. 续编 —— 打开已有草稿再改再存，验证不会丢东西
  // ---------------------------------------------------------------------
  const resume = "03_续编_打开再改再存";
  await client.call("jianying_create_draft", {
    name: resume, width: 1920, height: 1080, fps: 30, overwrite: true,
  });
  await client.call("jianying_add_video", {
    name: resume, filePath: media("01_开场.mp4"), start: 0, duration: 3,
  });
  await client.call("jianying_add_text", {
    name: resume, text: "第一版字幕", start: 0.5, duration: 2,
  });
  await client.call("jianying_save_draft", { name: resume });
  await client.call("jianying_close_draft", { name: resume });

  // Reopen it, change it, save it again.
  await client.call("jianying_open_draft", { name: resume });
  await client.call("jianying_add_text", {
    name: resume, text: "续编新增的字幕", start: 5, duration: 2, track: 1,
  });
  await client.call("jianying_save_draft", { name: resume });

  // ---------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------
  console.log("\n生成的验证草稿：\n");
  for (const name of [basic, edge, resume]) {
    const dir = path.join(OUT, name);
    const info = JSON.parse(
      fs.readFileSync(path.join(dir, "draft_info.json"), "utf8"),
    );
    const tracks = info.tracks
      .map((t: any) => `${t.type}(${t.segments.length})`)
      .join(" + ");
    console.log(
      `  ${name}\n    画布 ${info.canvas_config.width}x${info.canvas_config.height} @${info.fps}fps  时长 ${(info.duration / 1e6).toFixed(1)}s  轨道 ${tracks}  素材 ${fs.readdirSync(path.join(dir, "materials")).length} 个`,
    );
  }
  console.log(`\n草稿根目录: ${OUT}\n`);

  client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
