#!/usr/bin/env node
/**
 * Realistic business scenario: build a 10-second vertical ad draft for a
 * casual puzzle game, the way the buy-side creative team would.
 *
 * Usage: node dist/ad_scenario.js <draftsRoot>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "./mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.js");

/**
 * Media directory and output root. Both are configurable so the scenario runs
 * on any machine; they default to paths relative to the repository root.
 */
const REPO_ROOT = path.resolve(__dirname, "..");
const MEDIA = process.env.JY_TEST_MEDIA ?? path.join(REPO_ROOT, "ad_media");
const DRAFTS_ROOT = process.argv[2] ?? path.join(REPO_ROOT, "ad_drafts");
const DRAFT = "休闲解谜_竖版广告_01";

async function main() {
  const client = new McpClient(SERVER, { JY_PROJECTS_ROOT: DRAFTS_ROOT });
  await client.initialize();

  // 1. Probe the footage first — never guess durations.
  console.log("1) 探测素材");
  for (const f of ["01_hook.mp4", "02_demo.mp4", "03_cta.mp4", "bgm.mp3", "voice.mp3"]) {
    const p = await client.call("jianying_probe_media", { filePath: path.join(MEDIA, f) });
    console.log(
      `   ${f.padEnd(14)} ${p.kind.padEnd(6)} ${p.durationSeconds.toFixed(2)}s  ${p.width}x${p.height}`,
    );
  }

  // 2. Create the project. Canvas left unset so it adapts to the footage.
  console.log("\n2) 建工程");
  const created = await client.call("jianying_create_draft", { name: DRAFT, fps: 30, overwrite: true });
  console.log(`   canvas = ${created.draft.width}x${created.draft.height}`);

  // 3. Lay the storyboard: hook -> demo -> CTA.
  console.log("\n3) 排画面");
  await client.call("jianying_add_video", {
    name: DRAFT, filePath: path.join(MEDIA, "01_hook.mp4"), start: 0, duration: 3,
  });
  await client.call("jianying_add_video", {
    name: DRAFT, filePath: path.join(MEDIA, "02_demo.mp4"), start: 3, duration: 4,
  });
  await client.call("jianying_add_video", {
    name: DRAFT, filePath: path.join(MEDIA, "03_cta.mp4"), start: 7, duration: 3,
  });

  // 4. Audio: BGM on track 0, narration on track 1.
  console.log("\n4) 铺声音");
  await client.call("jianying_add_audio", {
    name: DRAFT, filePath: path.join(MEDIA, "bgm.mp3"), start: 0,
    track: 0, volume: 0.25, fadeIn: 1, fadeOut: 1,
  });
  await client.call("jianying_add_audio", {
    name: DRAFT, filePath: path.join(MEDIA, "voice.mp3"), start: 0.5,
    track: 1, volume: 1.0,
  });

  // 5. Subtitles + a title card.
  console.log("\n5) 上字幕与标题");
  const script =
    "解压超解压，一秒就上头。" +
    "三消关卡，越玩越上瘾。" +
    "现在下载，领取百抽奖励。";
  const subs = await client.call("jianying_add_subtitles", {
    name: DRAFT, script, start: 0.5, duration: 9, maxChars: 12,
  });
  console.log(`   字幕 ${subs.lineCount} 行：`);
  for (const l of subs.lines) console.log(`     · ${l}`);

  // The title goes on a separate text track so it can coexist with the
  // captions.
  await client.call("jianying_add_text", {
    name: DRAFT, text: "3秒上头", start: 0.2, duration: 2.5, track: 1,
    style: { size: 9.0, bold: true, color: [1.0, 0.85, 0.1], align: 1 },
  });

  // 6. Save.
  console.log("\n6) 保存");
  const saved = await client.call("jianying_save_draft", { name: DRAFT });
  console.log(`   ${saved.draftPath}`);

  // 7. Acceptance check.
  console.log("\n7) 验收");
  const inspected = await client.call("jianying_inspect_draft", { name: DRAFT });
  const d = inspected.draft;
  console.log(`   时长        ${d.durationSeconds}s`);
  console.log(`   画布        ${d.width}x${d.height}`);
  for (const t of d.tracks) {
    console.log(
      `   ${t.type.padEnd(6)} track${t.index}  ${t.segmentCount} 段  ${t.durationSeconds}s`,
    );
  }

  const info = JSON.parse(
    fs.readFileSync(path.join(saved.draftPath, "draft_info.json"), "utf8"),
  );
  const bgmTrack = info.tracks.find((t: any) => t.type === "audio" && t.name === "Audio");
  const voiceTrack = info.tracks.find((t: any) => t.type === "audio" && t.name === "Audio_1");
  console.log(`   BGM 音量    ${bgmTrack?.segments?.[0]?.volume}`);
  console.log(`   人声音量    ${voiceTrack?.segments?.[0]?.volume}`);
  console.log(`   素材自包含  ${fs.readdirSync(path.join(saved.draftPath, "materials")).length} 个文件`);

  const srtPath = path.join(DRAFTS_ROOT, "ad.srt");
  await client.call("jianying_export_srt", { name: DRAFT, outputPath: srtPath });
  console.log(`\n   SRT 预览:`);
  console.log(fs.readFileSync(srtPath, "utf8").trim().split("\n").map((l) => `     ${l}`).join("\n"));

  client.close();
  console.log(`\n✅ 草稿就绪: ${saved.draftPath}\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
