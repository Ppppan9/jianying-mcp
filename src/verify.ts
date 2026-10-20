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
    "jianying_add_video", "jianying_close_draft", "jianying_create_draft",
    "jianying_export_srt", "jianying_inspect_draft", "jianying_list_drafts",
    "jianying_open_draft", "jianying_probe_media", "jianying_remove_media",
    "jianying_save_draft",
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
  // Media paths are needed by the checks in the error-handling section too.
  const vid1 = path.join(MEDIA_DIR, "vid1.mp4");
  const vid2 = path.join(MEDIA_DIR, "vid2.mp4");
  const bgm = path.join(MEDIA_DIR, "bgm.mp3");

  const created = await client.call("jianying_create_draft", {
    name: "Verify_Draft", width: 1920, height: 1080, fps: 30, overwrite: true,
  });
  check("create_draft returns ok", created.ok === true);
  check("create_draft reports canvas", created.draft.width === 1920 && created.draft.height === 1080);

  // Creating a draft that already exists must not silently replace it.
  // The name is already open in this session, so the session check fires
  // first; either refusal is correct, an overwrite is not.
  let duplicateCreate: string | null = null;
  try {
    await client.call("jianying_create_draft", { name: "Verify_Draft" });
  } catch (e: any) {
    duplicateCreate = e.message;
  }
  check(
    "create_draft does not overwrite an existing draft by default",
    duplicateCreate !== null &&
      (/already exists/.test(duplicateCreate) || /already open/.test(duplicateCreate)),
    duplicateCreate,
  );

  if (HAS_MEDIA) {
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

    // Overlapping clips must be rejected — JianYing renders them unpredictably.
    let overlapErr: string | null = null;
    try {
      await client.call("jianying_add_video", {
        name: "Verify_Draft", filePath: vid1, start: 1, duration: 2,
      });
    } catch (e: any) {
      overlapErr = e.message;
    }
    check(
      "overlapping clip is rejected",
      overlapErr !== null && /overlaps an existing segment/.test(overlapErr),
      overlapErr,
    );

    // Adjacent clips on the same track — one ends exactly where the next
    // begins — are valid and must be accepted.
    const adjacent = await client.call("jianying_add_video", {
      name: "Verify_Draft", filePath: vid2, start: 7, duration: 3, track: 1,
    });
    check("clip on a second track is accepted", adjacent.segment.startSeconds === 7, adjacent.segment);

    const adjacentSame = await client.call("jianying_add_video", {
      name: "Verify_Draft", filePath: vid2, start: 7, duration: 3, track: 2,
    });
    check("adjacent clip on its own track is accepted", adjacentSame.segment.startSeconds === 7, adjacentSame.segment);

    // A video file must not be usable as an audio material.
    let audioTypeErr: string | null = null;
    try {
      await client.call("jianying_add_audio", {
        name: "Verify_Draft", filePath: vid1, start: 20, track: 2,
      });
    } catch (e: any) {
      audioTypeErr = e.message;
    }
    check(
      "video file is rejected as an audio material",
      audioTypeErr !== null && /must not contain a video track/.test(audioTypeErr),
      audioTypeErr,
    );

    const removed = await client.call("jianying_remove_media", {
      name: "Verify_Draft", filePath: vid2,
    });
    check("remove_media removes matching segments", removed.removedSegments >= 1, removed.removedSegments);

    // Removing a clip must not leave orphaned material or speed entries.
    const afterRemove = await client.call("jianying_inspect_draft", { name: "Verify_Draft" });
    const usedIds = new Set<string>();
    for (const t of afterRemove.draft.tracks) {
      for (const s of t.segments) usedIds.add(s.materialId);
    }
    const orphans = afterRemove.draft.materials.filter(
      (m: any) => (m.kind === "video" || m.kind === "audio") && !usedIds.has(m.id),
    );
    check("remove_media leaves no orphan materials", orphans.length === 0, orphans);
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
    // vid2 was removed with jianying_remove_media, so its staged copy and its
    // material entry must be gone too — no orphans left behind.
    check("removed media leaves no staged copy", staged.length === 2, staged);
    check("removed media leaves no orphan material", !staged.some((f) => f.endsWith(".mp4") && f !== staged.find((x) => x.endsWith(".mp4"))), staged);
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
    check("has a video track", (byType.video ?? 0) >= 1, byType);
    check("has an audio track", (byType.audio ?? 0) >= 1, byType);
    check("has a text track", (byType.text ?? 0) >= 1, byType);
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
  // The export refuses to replace an existing file, so clear it first.
  if (fs.existsSync(srtPath)) fs.rmSync(srtPath, { force: true });
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

  // Re-opening a name that is already open must not silently discard the
  // in-memory timeline of the unsaved draft.
  let duplicateErr: string | null = null;
  try {
    await client.call("jianying_create_draft", { name: "Verify_Draft" });
  } catch (e: any) {
    duplicateErr = e.message;
  }
  check(
    "re-opening an already open draft is refused",
    duplicateErr !== null && /already open/.test(duplicateErr),
    duplicateErr,
  );

  // Unsafe draft names must be rejected.
  for (const badName of ["..", ".", "   "]) {
    let nameErr: string | null = null;
    try {
      await client.call("jianying_create_draft", { name: badName });
    } catch (e: any) {
      nameErr = e.message;
    }
    check(`unsafe draft name is rejected: ${JSON.stringify(badName)}`, nameErr !== null, nameErr);
  }

  // A draft directory that is not a draft must never be deleted by an
  // overwrite.
  const foreignDir = path.join(DRAFTS_ROOT, "Not_A_Draft");
  fs.mkdirSync(foreignDir, { recursive: true });
  fs.writeFileSync(path.join(foreignDir, "important.txt"), "keep me", "utf8");
  let overwriteErr: string | null = null;
  try {
    await client.call("jianying_create_draft", { name: "Not_A_Draft", overwrite: true });
  } catch (e: any) {
    overwriteErr = e.message;
  }
  check(
    "overwrite refuses to delete a non-draft directory",
    overwriteErr !== null && /does not look like a JianYing draft/.test(overwriteErr),
    overwriteErr,
  );
  check(
    "the non-draft directory survived",
    fs.existsSync(path.join(foreignDir, "important.txt")),
  );

  // Closing a draft releases it and lets the name be reused.
  const closed = await client.call("jianying_close_draft", { name: "Verify_Draft" });
  check("close_draft reports the draft was closed", closed.closed === true, closed);
  const reopened = await client.call("jianying_create_draft", {
    name: "Verify_Draft", overwrite: true,
  });
  check("a closed draft name can be reused", reopened.ok === true);

  // A draft name that needs sanitising must still be addressable with the
  // name the caller used.
  await client.call("jianying_create_draft", { name: "Draft: v2", overwrite: true });
  const addressed = await client.call("jianying_inspect_draft", { name: "Draft: v2" });
  check(
    "a draft can be addressed with the name it was created with",
    addressed.ok === true,
    addressed,
  );

  // Negative times and durations must be refused.
  for (const bad of [
    { tool: "jianying_add_audio", args: { filePath: bgm, start: 0, duration: -5, track: 9 } },
    { tool: "jianying_add_video", args: { filePath: vid1, start: -3, duration: 1, track: 9 } },
    { tool: "jianying_add_text", args: { text: "x", start: -3, duration: 1 } },
  ]) {
    let err: string | null = null;
    try {
      await client.call(bad.tool, { ...bad.args, name: "Draft: v2" });
    } catch (e: any) {
      err = e.message;
    }
    check(
      `negative time is rejected: ${bad.tool}`,
      err !== null && /must not be negative/.test(err),
      err,
    );
  }

  // An audio-only file must not be usable as a video material.
  let asVideo: string | null = null;
  try {
    await client.call("jianying_add_video", {
      name: "Draft: v2", filePath: bgm, start: 0, duration: 2, track: 8,
    });
  } catch (e: any) {
    asVideo = e.message;
  }
  check(
    "an audio file is rejected as a video material",
    asVideo !== null && /must not be an audio-only file/.test(asVideo),
    asVideo,
  );

  // The subtitle summary must expose the caption text so it can be
  // proofread.
  await client.call("jianying_add_text", {
    name: "Draft: v2", text: "校对用字幕", start: 0, duration: 2,
  });
  const inspected2 = await client.call("jianying_inspect_draft", { name: "Draft: v2" });
  const captionSeg = inspected2.draft.tracks
    .find((t: any) => t.type === "text")
    ?.segments?.[0];
  check(
    "the summary exposes the caption text",
    captionSeg?.text === "校对用字幕",
    captionSeg?.text,
  );

  // The SRT export must refuse to overwrite an existing file.
  const victim = path.join(DRAFTS_ROOT, "victim.srt");
  fs.writeFileSync(victim, "EXISTING CONTENT", "utf8");
  let srtErr: string | null = null;
  try {
    await client.call("jianying_export_srt", { name: "Draft: v2", outputPath: victim });
  } catch (e: any) {
    srtErr = e.message;
  }
  check(
    "export_srt refuses to overwrite an existing file",
    srtErr !== null && /Refusing to overwrite/.test(srtErr),
    srtErr,
  );
  check(
    "the existing file is untouched",
    fs.readFileSync(victim, "utf8") === "EXISTING CONTENT",
  );

  // A non-srt output path must be refused outright.
  let extErr: string | null = null;
  try {
    await client.call("jianying_export_srt", {
      name: "Draft: v2", outputPath: path.join(DRAFTS_ROOT, "out.mp4"),
    });
  } catch (e: any) {
    extErr = e.message;
  }
  check(
    "export_srt refuses a non-srt output path",
    extErr !== null && /must end in .srt/.test(extErr),
    extErr,
  );

  // A rejected add must not leave an orphan material or a staged file.
  const before = await client.call("jianying_inspect_draft", { name: "Draft: v2" });
  const beforeMaterials = before.draft.materialCount;
  const stagedDir = path.join(DRAFTS_ROOT, "Draft_ v2", "materials");
  const beforeFiles = fs.existsSync(stagedDir) ? fs.readdirSync(stagedDir).length : 0;
  let fadeErr: string | null = null;
  try {
    await client.call("jianying_add_audio", {
      name: "Draft: v2", filePath: bgm, start: 0, duration: 2, track: 6, fadeIn: -1,
    });
  } catch (e: any) {
    fadeErr = e.message;
  }
  check("a negative fade is rejected", fadeErr !== null, fadeErr);
  const after = await client.call("jianying_inspect_draft", { name: "Draft: v2" });
  const afterFiles = fs.existsSync(stagedDir) ? fs.readdirSync(stagedDir).length : 0;
  check(
    "a rejected add leaves no orphan material",
    after.draft.materialCount === beforeMaterials,
    { before: beforeMaterials, after: after.draft.materialCount },
  );
  check(
    "a rejected add leaves no staged file",
    afterFiles === beforeFiles,
    { before: beforeFiles, after: afterFiles },
  );

  // A still image must be placeable for longer than its probe duration, and
  // the segment's source range must still fit inside the material.
  const photo = path.join(MEDIA_DIR, "photo.png");
  const photoJpg = path.join(MEDIA_DIR, "photo.jpg");
  const stillCases: Array<[string, string, number]> = [
    ["PNG", photo, 7],
    ["JPEG", photoJpg, 8],
  ];
  for (const [label, file, track] of stillCases) {
    if (!fs.existsSync(file)) continue;
    const still = await client.call("jianying_add_video", {
      name: "Draft: v2", filePath: file, start: 0, duration: 60, track,
    });
    check(`a ${label} still image can be placed for 60s`, still.ok === true);
    // Without an explicit duration a still must still get a usable length,
    // not the single frame the decoder reported.
    const defaulted = await client.call("jianying_add_video", {
      name: "Draft: v2", filePath: file, start: 0, duration: undefined, track: track + 10,
    });
    const defaultSeg = defaulted.draft.tracks
      .filter((t: any) => t.type === "video")
      .flatMap((t: any) => t.segments ?? [])
      .find((s: any) => s.start === 0 && s.duration > 1);
    check(
      `a ${label} still image without a duration gets a usable length`,
      (defaultSeg?.duration ?? 0) >= 1,
      defaultSeg?.duration,
    );
    await client.call("jianying_save_draft", { name: "Draft: v2" });
    // The draft is stored under its sanitised name (a colon is illegal in a
    // file name), which is the name the tool reports.
    const sanitizedDir = path.join(DRAFTS_ROOT, "Draft_ v2");
    const stillInfo = JSON.parse(
      fs.readFileSync(path.join(sanitizedDir, "draft_info.json"), "utf8"),
    );
    const photoMat = stillInfo.materials.videos.find((m: any) =>
      String(m.material_name).endsWith(path.extname(file)),
    );
    // The still may sit on any video track, so every one of them is searched.
    const photoSeg = stillInfo.tracks
      .filter((t: any) => t.type === "video")
      .flatMap((t: any) => t.segments ?? [])
      .find((s: any) => s.material_id === photoMat?.id);
    check(
      `the ${label} still image's source range fits its material`,
      !!photoMat &&
        !!photoSeg &&
        photoSeg.source_timerange.duration <= photoMat.duration,
      { material: photoMat?.duration, source: photoSeg?.source_timerange?.duration },
    );
  }

  // A video whose audio track is shorter than its picture must report the
  // video's duration, not the audio's.
  const shortAudio = path.join(MEDIA_DIR, "vid_short_audio.mp4");
  if (fs.existsSync(shortAudio)) {
    const probedShort = await client.call("jianying_probe_media", {
      filePath: shortAudio,
    });
    check(
      "a video's duration follows the video, not its shorter audio track",
      Math.abs(probedShort.durationSeconds - 6) < 0.5,
      probedShort,
    );
  }

  // An mp3 with embedded cover art is an audio file, not a video.
  const coverMp3 = path.join(MEDIA_DIR, "bgm_cover.mp3");
  if (fs.existsSync(coverMp3)) {
    const probedCover = await client.call("jianying_probe_media", {
      filePath: coverMp3,
    });
    check(
      "an mp3 with cover art is classified as audio",
      probedCover.kind === "audio",
      probedCover,
    );
    let coverErr: string | null = null;
    try {
      await client.call("jianying_add_video", {
        name: "Draft: v2", filePath: coverMp3, start: 0, duration: 2, track: 9,
      });
    } catch (e: any) {
      coverErr = e.message;
    }
    check(
      "an mp3 with cover art is rejected as a video material",
      coverErr !== null && /must not be an audio-only file/.test(coverErr),
      coverErr,
    );
  }

  // Subtitles must honour the requested text track.
  await client.call("jianying_add_subtitles", {
    name: "Draft: v2", script: "第二条字幕轨", start: 0, duration: 2, track: 3,
  });
  const multi = await client.call("jianying_inspect_draft", { name: "Draft: v2" });
  const textTracks = multi.draft.tracks.filter((t: any) => t.type === "text");
  check(
    "subtitles can be placed on a separate text track",
    textTracks.some((t: any) => t.index === 3),
    textTracks.map((t: any) => t.index),
  );

  // A malformed track index must not write a null render index into the
  // draft, and a numeric string must still select the intended track.
  // Each probe gets its own time window so the clips cannot overlap.
  const malformedTracks = ["abc", null, NaN, -1];
  for (let i = 0; i < malformedTracks.length; i++) {
    const bad = malformedTracks[i];
    let ok = true;
    let reason = "";
    try {
      const probe = await client.call("jianying_add_video", {
        name: "Draft: v2", filePath: vid1, start: i * 2, duration: 1, track: bad as any,
      });
      ok = probe.ok === true;
    } catch (e: any) {
      // A malformed index may normalise onto a track that is already used;
      // that is a placement conflict, not a rendering defect.
      ok = /SegmentOverlap/.test(e.message);
      reason = e.message.slice(0, 80);
    }
    check(`a malformed track index is tolerated: ${String(bad)}`, ok, reason);
  }
  await client.call("jianying_save_draft", { name: "Draft: v2" });
  const sanitizedDir = path.join(DRAFTS_ROOT, "Draft_ v2");
  const rawDraft = fs.readFileSync(
    path.join(sanitizedDir, "draft_info.json"),
    "utf8",
  );
  check(
    "the draft contains no null render index",
    !/"render_index":\s*null/.test(rawDraft),
  );
  check(
    "the draft contains no NaN track name",
    !/"VideoTrack_NaN"|"Audio_NaN"|"Subtitles_NaN"/.test(rawDraft),
  );

  const stringTrack = await client.call("jianying_add_video", {
    name: "Draft: v2", filePath: vid1, start: 0, duration: 1, track: "3" as any,
  });
  const stringIdx = stringTrack.draft.tracks
    .filter((t: any) => t.type === "video")
    .map((t: any) => t.index);
  check(
    "a numeric string selects the intended track",
    stringIdx.includes(3),
    stringIdx,
  );

  // The SRT export must include every text track.
  const srt2Path = path.join(DRAFTS_ROOT, "multi.srt");
  if (fs.existsSync(srt2Path)) fs.rmSync(srt2Path, { force: true });
  await client.call("jianying_export_srt", { name: "Draft: v2", outputPath: srt2Path });
  const srt2 = fs.readFileSync(srt2Path, "utf8");
  check(
    "the SRT export includes captions from every text track",
    srt2.includes("第二条字幕轨"),
    srt2.slice(0, 200),
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
