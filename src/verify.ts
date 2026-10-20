/**
 * End-to-end verification harness.
 *
 * Drives the MCP server over raw JSON-RPC stdio, builds a real draft, and
 * asserts the resulting files satisfy the JianYing draft contract that was
 * reverse-engineered from the upstream implementation.
 *
 * Usage: node dist/verify.js <mediaDir> <draftsRoot>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "./mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.js");

const REPO_ROOT = path.resolve(__dirname, "..");
/**
 * Media directory and output root. Both fall back to repository-relative
 * paths so the harness runs on any machine after
 * `bash scripts/make_test_media.sh`.
 */
const MEDIA_DIR = process.argv[2] ?? path.join(REPO_ROOT, "test-media");
const DRAFTS_ROOT =
  process.argv[3] ?? path.join(REPO_ROOT, "out_drafts");
const HAS_MEDIA = fs.existsSync(MEDIA_DIR) && fs.statSync(MEDIA_DIR).isDirectory();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    if (detail !== undefined) {
      console.log(
        `      → ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}`,
      );
    }
  }
}

async function main() {
  console.log(`\n\x1b[1mJianYing MCP verification\x1b[0m`);
  console.log(`  server:      ${SERVER}`);
  console.log(`  media:       ${HAS_MEDIA ? MEDIA_DIR : "(missing — run scripts/make_test_media.sh)"}`);
  console.log(`  drafts root: ${DRAFTS_ROOT}\n`);

  const client = new McpClient(SERVER, { JY_PROJECTS_ROOT: DRAFTS_ROOT });

  // --- handshake ---------------------------------------------------------
  console.log("\x1b[1m[1] MCP handshake & tool surface\x1b[0m");
  const init = await client.initialize();
  check("initialize returns serverInfo", init?.serverInfo?.name === "jianying-mcp", init?.serverInfo);
  check("initialize advertises tool capability", !!init?.capabilities?.tools, init?.capabilities);

  const tools = await client.listTools();
  const toolNames = tools.map((t: any) => t.name).sort();
  const expected = [
    "jianying_add_audio", "jianying_add_subtitles", "jianying_add_text",
    "jianying_add_video", "jianying_create_draft", "jianying_export_srt",
    "jianying_inspect_draft", "jianying_list_drafts", "jianying_open_draft",
    "jianying_probe_media", "jianying_remove_media", "jianying_save_draft",
  ];
  check(
    `tools/list exposes all ${expected.length} tools`,
    JSON.stringify(toolNames) === JSON.stringify(expected),
    toolNames,
  );
  check("every tool has an object schema", tools.every((t: any) => t.inputSchema?.type === "object"));
  check("every tool has a description", tools.every((t: any) => (t.description ?? "").length > 20));

  // --- draft lifecycle ---------------------------------------------------
  console.log("\n\x1b[1m[2] Draft lifecycle\x1b[0m");
  const created = await client.call("jianying_create_draft", {
    name: "Verify_Draft", width: 1920, height: 1080, fps: 30,
  });
  check("create_draft returns ok", created.ok === true);
  check("create_draft reports canvas", created.draft.width === 1920 && created.draft.height === 1080);

  if (HAS_MEDIA) {
    const vid1 = path.join(MEDIA_DIR, "vid1.mp4");
    const vid2 = path.join(MEDIA_DIR, "vid2.mp4");
    const bgm = path.join(MEDIA_DIR, "bgm.mp3");

    const probed = await client.call("jianying_probe_media", { filePath: vid1 });
    check("probe_media reports video", probed.kind === "video", probed);
    check("probe_media reports ~4s duration", Math.abs(probed.durationSeconds - 4) < 0.5, probed);
    check("probe_media reports 640x360", probed.width === 640 && probed.height === 360, probed);

    const v1 = await client.call("jianying_add_video", {
      name: "Verify_Draft", filePath: vid1, start: 0, duration: 4,
    });
    check("add_video places clip at 0s", v1.segment.startSeconds === 0, v1.segment);

    const v2 = await client.call("jianying_add_video", {
      name: "Verify_Draft", filePath: vid2, start: 4, duration: 3,
    });
    check("add_video places second clip at 4s", v2.segment.startSeconds === 4, v2.segment);

    const appended = await client.call("jianying_add_video", {
      name: "Verify_Draft", filePath: vid2, duration: 3,
    });
    check("add_video appends when start omitted", appended.segment.startSeconds === 7, appended.segment);

    const aud = await client.call("jianying_add_audio", {
      name: "Verify_Draft", filePath: bgm, start: 0, track: 0, volume: 0.3,
    });
    check("add_audio honors volume", aud.segment.volume === 0.3, aud.segment);

    const subs = await client.call("jianying_add_subtitles", {
      name: "Verify_Draft",
      script: "黄金样本字幕第一行，这是一段测试文案。第二行内容。",
      start: 1, duration: 6,
    });
    check("add_subtitles splits into lines", subs.lineCount >= 2, subs.lines);
    check("add_subtitles returns line text", typeof subs.lines[0] === "string" && subs.lines[0].length > 0);

    // Out-of-range must fail loudly, not silently truncate.
    let rangeErr: string | null = null;
    try {
      await client.call("jianying_add_video", {
        name: "Verify_Draft", filePath: vid2, start: 0, duration: 99,
      });
    } catch (e: any) {
      rangeErr = e.message;
    }
    check("out-of-range clip is rejected", rangeErr !== null && /exceeds media duration/.test(rangeErr), rangeErr);

    const removed = await client.call("jianying_remove_media", {
      name: "Verify_Draft", filePath: vid2,
    });
    check("remove_media removes matching segments", removed.removedSegments >= 1, removed.removedSegments);
  }

  // --- persistence -------------------------------------------------------
  console.log("\n\x1b[1m[3] Persistence & contract\x1b[0m");
  const saved = await client.call("jianying_save_draft", { name: "Verify_Draft" });
  check("save_draft returns a path", !!saved.draftPath, saved.draftPath);

  const dir = path.join(DRAFTS_ROOT, "Verify_Draft");
  for (const f of ["draft_info.json", "draft_meta_info.json", "draft_settings", "key_value.json"]) {
    check(`draft contains ${f}`, fs.existsSync(path.join(dir, f)));
  }

  if (HAS_MEDIA) {
    const staged = fs.readdirSync(path.join(dir, "materials"));
    check("materials are self-contained (3 staged)", staged.length === 3, staged);
  }

  const info = JSON.parse(fs.readFileSync(path.join(dir, "draft_info.json"), "utf8"));
  check("canvas_config width", info.canvas_config.width === 1920);
  check("canvas_config height", info.canvas_config.height === 1080);
  check("fps is 30", info.fps === 30);
  check("version is 360000", info.version === 360000);
  check("platform.app_source is lv", info.platform.app_source === "lv");
  check("materials has ~45 buckets", Object.keys(info.materials).length >= 40, Object.keys(info.materials).length);

  // Track and segment assertions require media to have been added.
  if (!HAS_MEDIA) {
    console.log(
      "  ! skipping track/segment assertions — run scripts/make_test_media.sh to enable them",
    );
  }

  const byType: Record<string, number> = {};
  for (const t of info.tracks) byType[t.type] = (byType[t.type] ?? 0) + 1;
  if (HAS_MEDIA) {
    check("has a video track", byType.video === 1, byType);
    check("has an audio track", byType.audio === 1, byType);
    check("has a text track", byType.text === 1, byType);
  }

  const matIds = new Set<string>([
    ...info.materials.videos.map((m: any) => m.id),
    ...info.materials.audios.map((m: any) => m.id),
    ...info.materials.texts.map((m: any) => m.id),
    ...info.materials.speeds.map((m: any) => m.id),
  ]);
  let dangling = 0;
  for (const t of info.tracks) {
    for (const seg of t.segments) if (!matIds.has(seg.material_id)) dangling++;
  }
  check("no dangling material references", dangling === 0, dangling);

  let badText = 0;
  for (const m of info.materials.texts) {
    try {
      const c = JSON.parse(m.content);
      if (typeof c.text !== "string" || !Array.isArray(c.styles)) badText++;
    } catch {
      badText++;
    }
  }
  check("all text materials carry valid content JSON", badText === 0, badText);

  const videoSeg = info.tracks.find((t: any) => t.type === "video")?.segments?.[0];
  const audioSeg = info.tracks.find((t: any) => t.type === "audio")?.segments?.[0];
  const textSeg = info.tracks.find((t: any) => t.type === "text")?.segments?.[0];
  if (HAS_MEDIA) {
    check("segment has target_timerange", !!videoSeg?.target_timerange);
    check("segment has source_timerange", !!videoSeg?.source_timerange);
    check("segment has clip settings", !!videoSeg?.clip && videoSeg.clip.scale?.x === 1);
    check("segment has uniform_scale", !!videoSeg?.uniform_scale);
    check("segment has hdr_settings", !!videoSeg?.hdr_settings);
    check("segment has render_index", typeof videoSeg?.render_index === "number");

    check("audio segment has null clip", audioSeg?.clip === null, audioSeg?.clip);
    check("audio segment has null hdr_settings", audioSeg?.hdr_settings === null);

    check("text segment has null source_timerange", textSeg?.source_timerange === null, textSeg?.source_timerange);
    check("text segment render_index is 15000", textSeg?.render_index === 15000, textSeg?.render_index);

    check("speeds material exists", (info.materials.speeds ?? []).length > 0, (info.materials.speeds ?? []).length);
  }

  const settings = fs.readFileSync(path.join(dir, "draft_settings"), "utf8");
  check("draft_settings is INI format", settings.trimStart().startsWith("[General]"), settings.slice(0, 40));
  check("key_value.json is valid JSON", (() => {
    try { JSON.parse(fs.readFileSync(path.join(dir, "key_value.json"), "utf8")); return true; }
    catch { return false; }
  })());

  const meta = JSON.parse(fs.readFileSync(path.join(dir, "draft_meta_info.json"), "utf8"));
  check("meta has draft_name", meta.draft_name === "Verify_Draft");
  check("meta has draft_root_path", meta.draft_root_path === path.join("Verify_Draft", "draft_info.json"));

  // --- listing & SRT -----------------------------------------------------
  console.log("\n\x1b[1m[4] Listing & SRT export\x1b[0m");
  const listed = await client.call("jianying_list_drafts", {});
  check("list_drafts finds the draft", listed.drafts.some((d: any) => d.name === "Verify_Draft"), listed.drafts);

  const srtPath = path.join(DRAFTS_ROOT, "verify.srt");
  const srt = await client.call("jianying_export_srt", { name: "Verify_Draft", outputPath: srtPath });
  if (HAS_MEDIA) {
    check("export_srt wrote cues", srt.cueCount >= 1, srt);
    const srtText = fs.readFileSync(srtPath, "utf8");
    check("SRT has valid timestamps", /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/.test(srtText));
  }

  const inspected = await client.call("jianying_inspect_draft", { name: "Verify_Draft" });
  check("inspect_draft returns tracks", Array.isArray(inspected.draft.tracks));

  // --- error surface -----------------------------------------------------
  console.log("\n\x1b[1m[5] Error handling\x1b[0m");
  const badDraft = await client.callTool("jianying_inspect_draft", { name: "Does_Not_Exist" });
  check("unknown draft returns a tool error", badDraft.isError === true, badDraft.content?.[0]?.text);

  // An unknown tool name is a protocol-level error, not a tool error.
  let unknownToolErr: string | null = null;
  try {
    await client.callTool("jianying_nope", {});
  } catch (e: any) {
    unknownToolErr = e.message;
  }
  check(
    "unknown tool is rejected at the protocol level",
    unknownToolErr !== null && /Unknown tool/.test(unknownToolErr),
    unknownToolErr,
  );

  client.close();

  console.log(`\n\x1b[1mResult: ${passed} passed, ${failed} failed\x1b[0m`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nDraft written to: ${dir}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n\x1b[31mHarness crashed:\x1b[0m", err);
  process.exit(1);
});
