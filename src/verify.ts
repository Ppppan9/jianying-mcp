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
import { execFileSync } from "node:child_process";
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

// Start from an empty output directory. A leftover draft from an earlier run
// would make the checks about overwriting and cleaning up meaningless.
fs.rmSync(DRAFTS_ROOT, { recursive: true, force: true });
fs.mkdirSync(DRAFTS_ROOT, { recursive: true });

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

  const client = new McpClient(SERVER, { JY_PROJECTS_ROOT: DRAFTS_ROOT, JY_DRAFT_FORMAT: "upstream" });

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

  // A draft_info.json that parses but is not a draft must be refused, and
  // the file must be left exactly as it was. Reading it as an empty draft
  // and saving would overwrite the user's file with nothing.
  //
  // Two shapes are checked because they fail in different places: "null"
  // is not an object at all, and "{}" is an object with no tracks in it.
  for (const [label, hostileContent] of [
    ["a JSON null", "null"],
    ["an object without tracks", "{}"],
  ] as const) {
    const hostileName = `Hostile_Draft`;
    const hostileDir = path.join(DRAFTS_ROOT, hostileName);
    fs.rmSync(hostileDir, { recursive: true, force: true });
    fs.mkdirSync(hostileDir, { recursive: true });
    const infoPath = path.join(hostileDir, "draft_info.json");
    fs.writeFileSync(infoPath, hostileContent, "utf8");

    let refusal: string | null = null;
    try {
      await client.call("jianying_open_draft", { name: hostileName });
    } catch (e: any) {
      refusal = e.message;
    }
    check(
      `draft_info.json holding ${label} is refused`,
      refusal !== null && /not a JianYing draft|not hold a JianYing draft/.test(refusal),
      refusal,
    );
    check(
      `a refused draft (${label}) is left untouched`,
      fs.readFileSync(infoPath, "utf8") === hostileContent,
    );
    fs.rmSync(hostileDir, { recursive: true, force: true });
  }

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

  // A still image's source range must stay inside its material, and a clip
  // longer than the material must be refused.
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
    check(
      `the ${label} still image is typed as a photo`,
      photoMat?.type === "photo",
      photoMat?.type,
    );
    check(
      `the ${label} still image keeps a long material duration`,
      (photoMat?.duration ?? 0) >= 3_600_000_000,
      photoMat?.duration,
    );
  }

  // A still image's material is 3 hours long, so a clip inside that is fine
  // but one beyond it must be refused — and a source offset past the probe
  // fallback must not silently produce a zero-length clip.
  if (fs.existsSync(photo)) {
    let tooLong: string | null = null;
    try {
      await client.call("jianying_add_video", {
        name: "Draft: v2", filePath: photo, start: 0, duration: 4 * 3600, track: 11,
      });
    } catch (e: any) {
      tooLong = e.message;
    }
    check(
      "a still image clip longer than its material is refused",
      tooLong !== null && /exceeds media duration/.test(tooLong),
      tooLong,
    );

    // A still image has no intrinsic length, so an offset inside its 3 hour
    // material is legitimate. What must not happen is a silent zero-length
    // clip.
    let offsetSeg: any = null;
    try {
      const res = await client.call("jianying_add_video", {
        name: "Draft: v2", filePath: photo, start: 0, sourceStart: 15, track: 12,
      });
      offsetSeg = res.segment;
    } catch (e: any) {
      offsetSeg = null;
    }
    check(
      "a still image with a source offset does not produce a zero-length clip",
      offsetSeg !== null && (offsetSeg.durationSeconds ?? 0) > 0,
      offsetSeg,
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

  // An index that cannot be read as a number is refused outright. It used to
  // be normalised silently, which put the clip on track 0 — a wrong answer
  // that looked like a success.
  const unusableTracks: Array<[string, unknown]> = [
    ["a word", "abc"],
    ["null", null],
    ["NaN", NaN],
    ["an object", { a: 1 }],
  ];
  for (let i = 0; i < unusableTracks.length; i++) {
    const [label, bad] = unusableTracks[i];
    let refused = false;
    let reason = "";
    try {
      await client.call("jianying_add_video", {
        name: "Draft: v2", filePath: vid1, start: i * 2, duration: 1, track: bad as any,
      });
    } catch (e: any) {
      refused = /must be a number/.test(e.message);
      reason = e.message.slice(0, 100);
    }
    check(`an unusable track index is refused: ${label}`, refused, reason);
  }

  // A negative index is a number, so it is accepted and normalised to the
  // bottom track. That may collide with a clip that is already there, which
  // is a placement conflict rather than a rendering defect.
  {
    let tolerated = false;
    let reason = "";
    try {
      const probe = await client.call("jianying_add_video", {
        name: "Draft: v2", filePath: vid1, start: 6, duration: 1, track: -1,
      });
      tolerated = probe.ok === true;
    } catch (e: any) {
      tolerated = /SegmentOverlap/.test(e.message);
      reason = e.message.slice(0, 80);
    }
    check("a negative track index is normalised, not written as-is", tolerated, reason);
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

  // --- opening an existing draft must resume it, not destroy it ---------
  const resumeName = "Resume_Me";
  await client.call("jianying_create_draft", {
    name: resumeName, width: 1920, height: 1080, overwrite: true,
  });
  await client.call("jianying_add_video", {
    name: resumeName, filePath: vid1, start: 0, duration: 4,
  });
  await client.call("jianying_add_text", {
    name: resumeName, text: "要续编的字幕", start: 1, duration: 2,
  });
  await client.call("jianying_save_draft", { name: resumeName });
  await client.call("jianying_close_draft", { name: resumeName });

  const resumeDir = path.join(DRAFTS_ROOT, resumeName);
  const beforeResume = fs.readdirSync(resumeDir).sort();
  const infoBefore = fs.readFileSync(
    path.join(resumeDir, "draft_info.json"),
    "utf8",
  );

  const resumed = await client.call("jianying_open_draft", { name: resumeName });
  check("an existing draft can be opened", resumed.ok === true, resumed);
  const resumedText = resumed.draft.tracks
    .filter((t: any) => t.type === "text")
    .flatMap((t: any) => t.segments ?? [])
    .map((s: any) => s.text);
  check(
    "the opened draft keeps its timeline",
    resumedText.includes("要续编的字幕"),
    resumedText,
  );
  check(
    "the opened draft keeps its video clips",
    resumed.draft.tracks
      .filter((t: any) => t.type === "video")
      .reduce((n: number, t: any) => n + t.segmentCount, 0) === 1,
  );

  // Editing and saving the resumed draft must not lose the earlier work.
  await client.call("jianying_add_text", {
    name: resumeName, text: "续编新增", start: 6, duration: 2,
  });
  await client.call("jianying_save_draft", { name: resumeName });
  const afterResume = fs.readdirSync(resumeDir).sort();
  check(
    "opening and saving a draft keeps every file",
    JSON.stringify(afterResume) === JSON.stringify(beforeResume),
    { before: beforeResume, after: afterResume },
  );
  const infoAfter = JSON.parse(
    fs.readFileSync(path.join(resumeDir, "draft_info.json"), "utf8"),
  );
  const textsAfter = infoAfter.materials.texts.map((m: any) =>
    JSON.parse(m.content).text,
  );
  check(
    "the resumed draft keeps the original caption and gains the new one",
    textsAfter.includes("要续编的字幕") && textsAfter.includes("续编新增"),
    textsAfter,
  );
  check(
    "the resumed draft still has its video clip",
    infoAfter.materials.videos.length === 1,
    infoAfter.materials.videos.length,
  );
  await client.call("jianying_close_draft", { name: resumeName });

  // A malformed subtitle limit must be refused, not loop forever.
  let maxCharsErr: string | null = null;
  try {
    await client.call("jianying_add_subtitles", {
      name: "Draft: v2", script: "abc", start: 0, duration: 2, maxChars: 0,
    });
  } catch (e: any) {
    maxCharsErr = e.message;
  }
  check(
    "a non-positive maxChars is refused",
    maxCharsErr !== null && /maxChars/.test(maxCharsErr),
    maxCharsErr,
  );

  // Style and volume values go straight into the draft, so an illegal one
  // must be refused rather than written out.
  const illegalStyles: Array<[string, Record<string, unknown>]> = [
    ["a two-component colour", { color: [1, 0] }],
    ["an out-of-range alpha", { alpha: 5 }],
    ["a negative size", { size: -3 }],
    ["an invalid alignment", { align: 7 }],
  ];
  for (const [label, style] of illegalStyles) {
    let styleErr: string | null = null;
    try {
      await client.call("jianying_add_text", {
        name: "Draft: v2", text: "样式校验", start: 20, duration: 1, track: 13, style,
      });
    } catch (e: any) {
      styleErr = e.message;
    }
    check(`an illegal style is refused: ${label}`, styleErr !== null, styleErr);
  }

  let volumeErr: string | null = null;
  try {
    await client.call("jianying_add_video", {
      name: "Draft: v2", filePath: vid1, start: 30, duration: 1, track: 14, volume: 42,
    });
  } catch (e: any) {
    volumeErr = e.message;
  }
  check("an out-of-range volume is refused", volumeErr !== null && /volume/.test(volumeErr), volumeErr);

  // The registry entry must match the reference template field for field.
  await client.call("jianying_save_draft", { name: "Draft: v2" });
  const registry = JSON.parse(
    fs.readFileSync(path.join(DRAFTS_ROOT, "Draft_ v2", "draft_meta_info.json"), "utf8"),
  );
  check(
    "the registry entry declares the reference's seven material types",
    JSON.stringify(registry.draft_materials.map((m: any) => m.type)) ===
      JSON.stringify([0, 1, 2, 3, 6, 7, 8]),
    registry.draft_materials.map((m: any) => m.type),
  );
  check(
    "the registry entry uses the reference's dashed id shape",
    typeof registry.draft_id === "string" &&
      registry.draft_id.length === 36 &&
      registry.draft_id.split("-").length === 5,
    registry.draft_id,
  );
  check(
    "the registry entry's enterprise material is a list",
    Array.isArray(registry.draft_enterprise_info.enterprise_material),
    registry.draft_enterprise_info.enterprise_material,
  );

  // --- the written draft must match the contract, field by field -------
  // These read the saved file rather than the in-memory state, so they catch
  // a mistake in the serialization and not only in the model.
  const contractName = "Contract";
  await client.call("jianying_create_draft", {
    name: contractName, width: 1080, height: 1920, fps: 30, overwrite: true,
  });
  await client.call("jianying_add_video", {
    name: contractName, filePath: vid1, start: 0, duration: 4,
  });
  await client.call("jianying_add_audio", {
    name: contractName, filePath: bgm, start: 0, track: 0, volume: 0.3,
  });
  await client.call("jianying_add_text", {
    name: contractName, text: "契约校验", start: 0, duration: 2,
    style: { alpha: 0.5 },
  });
  await client.call("jianying_save_draft", { name: contractName });
  const contract = JSON.parse(
    fs.readFileSync(path.join(DRAFTS_ROOT, contractName, "draft_info.json"), "utf8"),
  );

  // Every media segment must reference a speed material, and the material
  // must exist in the speeds bucket.
  const speedIds = new Set(
    (contract.materials.speeds ?? []).map((m: any) => m.id),
  );
  const mediaSegments = contract.tracks
    .filter((t: any) => t.type === "video" || t.type === "audio")
    .flatMap((t: any) => t.segments ?? []);
  check(
    "every media segment references a speed material",
    mediaSegments.length > 0 &&
      mediaSegments.every((s: any) =>
        (s.extra_material_refs ?? []).some((r: string) => speedIds.has(r)),
      ),
    mediaSegments.map((s: any) => s.extra_material_refs),
  );
  check(
    "the speeds bucket holds one entry per media segment",
    (contract.materials.speeds ?? []).length === mediaSegments.length,
    {
      speeds: (contract.materials.speeds ?? []).length,
      segments: mediaSegments.length,
    },
  );

  // The track attribute is the mute flag, not a track index.
  check(
    "the track attribute is the mute flag, not a track index",
    contract.tracks.every((t: any) => t.attribute === 0),
    contract.tracks.map((t: any) => t.attribute),
  );
  check(
    "the segment track_attribute is the mute flag",
    mediaSegments.every((s: any) => s.track_attribute === 0),
    mediaSegments.map((s: any) => s.track_attribute),
  );
  check(
    "the segment track_render_index is the track position",
    mediaSegments.every((s: any) => s.track_render_index === 0),
    mediaSegments.map((s: any) => s.track_render_index),
  );

  // The text opacity is carried once, in global_alpha.
  const contractText = (contract.materials.texts ?? [])[0];
  const textContent = contractText ? JSON.parse(contractText.content) : null;
  check(
    "the text fill alpha is fixed at 1",
    textContent?.styles?.[0]?.fill?.alpha === 1.0,
    textContent?.styles?.[0]?.fill?.alpha,
  );
  check(
    "the text solid alpha is fixed at 1",
    textContent?.styles?.[0]?.fill?.content?.solid?.alpha === 1.0,
    textContent?.styles?.[0]?.fill?.content?.solid?.alpha,
  );
  check(
    "the text opacity is carried once, in global_alpha",
    contractText?.global_alpha === 0.5,
    contractText?.global_alpha,
  );

  // A draft that is loaded and saved must not sweep the media bin, and the
  // orphan sweep must only touch materials this engine created. The seeded
  // draft carries a clip that is staged but not on the timeline.
  const sweepName = "Sweep";
  await client.call("jianying_create_draft", {
    name: sweepName, width: 1920, height: 1080, overwrite: true,
  });
  await client.call("jianying_add_video", {
    name: sweepName, filePath: vid1, start: 0, duration: 4,
  });
  await client.call("jianying_save_draft", { name: sweepName });
  await client.call("jianying_close_draft", { name: sweepName });
  await client.call("jianying_open_draft", { name: sweepName });
  // A lookup that matches nothing must not remove anything.
  const removedNothing = await client.call("jianying_remove_media", {
    name: sweepName, filePath: path.join(DRAFTS_ROOT, "not_in_this_draft.mp4"),
  });
  check(
    "removing a file that is not in the draft removes nothing",
    removedNothing.ok === true && removedNothing.removedSegments === 0,
    removedNothing,
  );
  await client.call("jianying_save_draft", { name: sweepName });
  const swept = JSON.parse(
    fs.readFileSync(path.join(DRAFTS_ROOT, sweepName, "draft_info.json"), "utf8"),
  );
  check(
    "a failed lookup leaves the media bin alone",
    (swept.materials.videos ?? []).length === 1,
    (swept.materials.videos ?? []).length,
  );
  await client.call("jianying_close_draft", { name: sweepName });

  // The track attribute is the mute flag, not a track index. The check needs
  // more than one track, or a track index of zero would look the same.
  const multiName = "Multi_Track";
  await client.call("jianying_create_draft", {
    name: multiName, width: 1920, height: 1080, overwrite: true,
  });
  await client.call("jianying_add_video", {
    name: multiName, filePath: vid1, start: 0, duration: 2,
  });
  await client.call("jianying_add_video", {
    name: multiName, filePath: vid2, start: 0, duration: 2, track: 1,
  });
  await client.call("jianying_add_audio", {
    name: multiName, filePath: bgm, start: 0, track: 0, duration: 2,
  });
  await client.call("jianying_add_audio", {
    name: multiName, filePath: bgm, start: 0, track: 1, duration: 2,
  });
  await client.call("jianying_save_draft", { name: multiName });
  const multiTrackDraft = JSON.parse(
    fs.readFileSync(path.join(DRAFTS_ROOT, multiName, "draft_info.json"), "utf8"),
  );
  check(
    "every track keeps attribute at zero, whatever its index",
    multiTrackDraft.tracks.length === 4 &&
      multiTrackDraft.tracks.every((t: any) => t.attribute === 0),
    multiTrackDraft.tracks.map((t: any) => ({ type: t.type, attribute: t.attribute })),
  );
  check(
    "the track render index advances with the track index",
    multiTrackDraft.tracks
      .filter((t: any) => t.type === "video")
      .map((t: any) => t.segments[0].render_index)
      .join(",") === "0,1",
    multiTrackDraft.tracks
      .filter((t: any) => t.type === "video")
      .map((t: any) => t.segments[0].render_index),
  );
  await client.call("jianying_close_draft", { name: multiName });

  // A draft whose name needs sanitising must still be addressable with the
  // name the caller used.
  const messyName = "My: Draft/2";
  await client.call("jianying_create_draft", {
    name: messyName, width: 1920, height: 1080, overwrite: true,
  });
  await client.call("jianying_add_text", {
    name: messyName, text: "寻址测试", start: 0, duration: 1,
  });
  await client.call("jianying_save_draft", { name: messyName });
  const addressed2 = await client.call("jianying_inspect_draft", { name: messyName });
  check(
    "a draft with a sanitised name is addressable with the original name",
    addressed2.ok === true,
    addressed2,
  );
  const messyText = addressed2.draft.tracks
    .filter((t: any) => t.type === "text")
    .flatMap((t: any) => t.segments ?? [])
    .map((s: any) => s.text);
  check(
    "the addressed draft is the one that was created",
    messyText.includes("寻址测试"),
    messyText,
  );
  await client.call("jianying_close_draft", { name: messyName });

  // --- loading a draft must not lose anything ---------------------------
  // A draft seeded with material this engine does not model — effects,
  // stickers, transitions and a media bin — must keep all of it when it is
  // opened and saved again.
  const seedDir = path.join(DRAFTS_ROOT, "seed");
  fs.mkdirSync(seedDir, { recursive: true });
  const seedSource = path.join(__dirname, "..", "scripts", "make_roundtrip_seed.py");
  execFileSync("python3", [seedSource, seedDir], { timeout: 60_000 });
  const seedTarget = path.join(DRAFTS_ROOT, "Seeded");
  fs.mkdirSync(path.join(seedTarget, "materials"), { recursive: true });
  fs.copyFileSync(
    path.join(seedDir, "draft_info.json"),
    path.join(seedTarget, "draft_info.json"),
  );
  fs.writeFileSync(path.join(seedTarget, "draft_meta_info.json"), "{}", "utf8");

  const seededBefore = JSON.parse(
    fs.readFileSync(path.join(seedTarget, "draft_info.json"), "utf8"),
  );
  const opened2 = await client.call("jianying_open_draft", { name: "Seeded" });
  check("a seeded draft can be opened", opened2.ok === true, opened2);
  await client.call("jianying_save_draft", { name: "Seeded" });
  const seededAfter = JSON.parse(
    fs.readFileSync(path.join(seedTarget, "draft_info.json"), "utf8"),
  );

  for (const bucket of Object.keys(seededBefore.materials ?? {})) {
    const b = (seededBefore.materials[bucket] ?? []).length;
    const a = (seededAfter.materials[bucket] ?? []).length;
    if (b !== a) {
      check(
        `loading and saving keeps materials.${bucket}`,
        false,
        { before: b, after: a },
      );
    }
  }
  check(
    "loading and saving keeps every material bucket",
    Object.keys(seededBefore.materials ?? {}).every(
      (bucket) =>
        (seededBefore.materials[bucket] ?? []).length ===
        (seededAfter.materials[bucket] ?? []).length,
    ),
  );

  // A material bucket whose value is not a list is malformed, but it is
  // still the user's data. It has to come back out of the saved draft
  // rather than being replaced by an empty list.
  {
    const bucketName = "MalformedBucket";
    const bucketDir = path.join(DRAFTS_ROOT, bucketName);
    fs.mkdirSync(bucketDir, { recursive: true });
    fs.writeFileSync(
      path.join(bucketDir, "draft_info.json"),
      JSON.stringify({
        tracks: [],
        materials: { effects: { weird: true } },
        canvas_config: { width: 1920, height: 1080 },
      }),
      "utf8",
    );
    await client.call("jianying_open_draft", { name: bucketName });
    await client.call("jianying_save_draft", { name: bucketName });
    const saved = JSON.parse(
      fs.readFileSync(path.join(bucketDir, "draft_info.json"), "utf8"),
    );
    check(
      "a material bucket that is not a list survives the round trip",
      JSON.stringify(saved.materials?.effects) === JSON.stringify({ weird: true }),
      saved.materials?.effects,
    );
  }

  // A key the loaded draft holds and this engine does not model has to
  // come back out of the saved draft. The reference implementation keeps the
  // whole loaded document and only overwrites the keys it models, so a
  // newer JianYing that adds a key does not lose it here.
  {
    const extraName = "ExtraKeys";
    const extraDir = path.join(DRAFTS_ROOT, extraName);
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(
      path.join(extraDir, "draft_info.json"),
      JSON.stringify({
        tracks: [],
        materials: { videos: [], audios: [], texts: [], speeds: [] },
        canvas_config: { width: 1920, height: 1080 },
        config: { future_setting: { on: true } },
        future_top_level: "keep me",
        id: "PROJECT-ID-MUST-SURVIVE",
        create_time: 1700000000000,
      }),
      "utf8",
    );
    await client.call("jianying_open_draft", { name: extraName });
    await client.call("jianying_save_draft", { name: extraName });
    const saved = JSON.parse(
      fs.readFileSync(path.join(extraDir, "draft_info.json"), "utf8"),
    );
    check(
      "an unknown top-level key survives the round trip",
      saved.future_top_level === "keep me",
      saved.future_top_level,
    );
    check(
      "an unknown config key survives the round trip",
      JSON.stringify(saved.config?.future_setting) === JSON.stringify({ on: true }),
      saved.config?.future_setting,
    );
    // The reference overwrites only six keys when it saves, so the project
    // id keeps the value it was loaded with. If it changed on every save,
    // JianYing would treat the draft as a different project.
    check(
      "the project id survives the round trip",
      saved.id === "PROJECT-ID-MUST-SURVIVE",
      saved.id,
    );
    check(
      "the project creation time survives the round trip",
      saved.create_time === 1700000000000,
      saved.create_time,
    );

    // The id has to be the same in the timeline file and in the draft's own
    // registry entry. The application keys its project cache by it.
    const meta = JSON.parse(
      fs.readFileSync(path.join(extraDir, "draft_meta_info.json"), "utf8"),
    );
    check(
      "the draft's own registry entry agrees about the id",
      meta.draft_id === saved.id,
      { meta: meta.draft_id, info: saved.id },
    );
  }

  // Two drafts must not share an identity. The application keys its project
  // cache by this value.
  {
    const first = await client.call("jianying_create_draft", {
      name: "Identity_One", width: 1080, height: 1920, overwrite: true,
    });
    await client.call("jianying_save_draft", { name: "Identity_One" });
    const second = await client.call("jianying_create_draft", {
      name: "Identity_Two", width: 1080, height: 1920, overwrite: true,
    });
    await client.call("jianying_save_draft", { name: "Identity_Two" });
    const one = JSON.parse(
      fs.readFileSync(path.join(DRAFTS_ROOT, "Identity_One", "draft_info.json"), "utf8"),
    );
    const two = JSON.parse(
      fs.readFileSync(path.join(DRAFTS_ROOT, "Identity_Two", "draft_info.json"), "utf8"),
    );
    check(
      "two drafts do not share an id",
      one.id !== two.id && typeof one.id === "string" && one.id.length === 36,
      { one: one.id, two: two.id },
    );
  }
  check(
    "loading and saving keeps the unmodelled material",
    (seededAfter.materials.effects ?? []).length === 1 &&
      (seededAfter.materials.stickers ?? []).length === 1 &&
      (seededAfter.materials.transitions ?? []).length === 1 &&
      (seededAfter.materials.canvases ?? []).length === 1 &&
      (seededAfter.materials.masks ?? []).length === 1,
    {
      effects: (seededAfter.materials.effects ?? []).length,
      stickers: (seededAfter.materials.stickers ?? []).length,
      transitions: (seededAfter.materials.transitions ?? []).length,
    },
  );
  check(
    "loading and saving keeps the media bin",
    (seededAfter.materials.videos ?? []).length === 2,
    (seededAfter.materials.videos ?? []).length,
  );
  check(
    "loading and saving keeps a material that no segment references",
    // The seed carries a clip that is staged but not on the timeline. The
    // orphan sweep must not touch it, because it did not create it.
    (seededAfter.materials.videos ?? []).some(
      (m: any) => m.id === "video-unused",
    ),
    (seededAfter.materials.videos ?? []).map((m: any) => m.id),
  );
  check(
    "loading and saving keeps a photo in the images bucket",
    (seededAfter.materials.images ?? []).length === 1 &&
      (seededAfter.materials.images ?? [])[0]?.type === "photo",
    seededAfter.materials.images,
  );
  check(
    "loading and saving keeps the segment references",
    (seededAfter.tracks ?? []).reduce(
      (n: number, t: any) =>
        n +
        (t.segments ?? []).reduce(
          (m: number, s: any) => m + (s.extra_material_refs?.length ?? 0),
          0,
        ),
      0,
    ) ===
      (seededBefore.tracks ?? []).reduce(
        (n: number, t: any) =>
          n +
          (t.segments ?? []).reduce(
            (m: number, s: any) => m + (s.extra_material_refs?.length ?? 0),
            0,
          ),
        0,
      ),
  );
  check(
    "loading and saving keeps the editing preferences",
    seededAfter.config?.maintrack_adsorb === seededBefore.config?.maintrack_adsorb &&
      seededAfter.config?.lyrics_sync === seededBefore.config?.lyrics_sync &&
      seededAfter.config?.subtitle_sync === seededBefore.config?.subtitle_sync,
    {
      maintrack_adsorb: seededAfter.config?.maintrack_adsorb,
      lyrics_sync: seededAfter.config?.lyrics_sync,
    },
  );

  // remove_media on a loaded draft must work, and must not sweep the media
  // bin that no segment references.
  const unusedName = "unused_clip.mp4";
  const unusedPath = path.join(DRAFTS_ROOT, "unused_clip.mp4");
  fs.writeFileSync(unusedPath, "placeholder", "utf8");
  const removedLoaded = await client.call("jianying_remove_media", {
    name: "Seeded", filePath: unusedPath,
  });
  check(
    "remove_media works on a loaded draft",
    removedLoaded.ok === true,
    removedLoaded,
  );
  await client.call("jianying_save_draft", { name: "Seeded" });
  const afterRemove = JSON.parse(
    fs.readFileSync(path.join(seedTarget, "draft_info.json"), "utf8"),
  );
  check(
    "remove_media on a loaded draft does not delete the media bin",
    (afterRemove.materials.videos ?? []).length === 2,
    (afterRemove.materials.videos ?? []).length,
  );
  await client.call("jianying_close_draft", { name: "Seeded" });

  // The same must hold for a loaded draft that holds a clip which is staged
  // but not on the timeline: a failed lookup must not sweep it away.
  const seededSweep = "Seeded_Sweep";
  fs.cpSync(path.join(DRAFTS_ROOT, "Seeded"), path.join(DRAFTS_ROOT, seededSweep), {
    recursive: true,
  });
  await client.call("jianying_open_draft", { name: seededSweep });
  const seededRemoved = await client.call("jianying_remove_media", {
    name: seededSweep, filePath: path.join(DRAFTS_ROOT, "not_in_this_draft.mp4"),
  });
  check(
    "a failed lookup in a loaded draft removes nothing",
    seededRemoved.ok === true && seededRemoved.removedSegments === 0,
    seededRemoved,
  );
  await client.call("jianying_save_draft", { name: seededSweep });
  const seededSwept = JSON.parse(
    fs.readFileSync(path.join(DRAFTS_ROOT, seededSweep, "draft_info.json"), "utf8"),
  );
  check(
    "a failed lookup in a loaded draft leaves its media bin alone",
    (seededSwept.materials.videos ?? []).length === 2,
    (seededSwept.materials.videos ?? []).length,
  );
  check(
    "a failed lookup in a loaded draft keeps the unreferenced clip",
    (seededSwept.materials.videos ?? []).some((m: any) => m.id === "video-unused"),
    (seededSwept.materials.videos ?? []).map((m: any) => m.id),
  );
  await client.call("jianying_close_draft", { name: seededSweep });

  // Removing a material that *is* in a loaded draft runs the orphan sweep.
  // The sweep must leave the clips the engine did not create alone.
  const sweepRemove = "Seeded_Remove";
  fs.cpSync(path.join(DRAFTS_ROOT, "Seeded"), path.join(DRAFTS_ROOT, sweepRemove), {
    recursive: true,
  });
  await client.call("jianying_open_draft", { name: sweepRemove });
  // The staged copy of the clip on the timeline is named after the md5 of its
  // source path, so the source path is what the caller has to pass.
  const seededInfo = JSON.parse(
    fs.readFileSync(path.join(DRAFTS_ROOT, sweepRemove, "draft_info.json"), "utf8"),
  );
  const onTimeline = (seededInfo.materials.videos ?? []).find(
    (m: any) => m.id === "video-on-timeline",
  );
  const onTimelinePath = String(onTimeline?.path ?? "");
  const removedReal = await client.call("jianying_remove_media", {
    name: sweepRemove, filePath: onTimelinePath,
  });
  check(
    "removing a material that is in the draft works",
    removedReal.ok === true && removedReal.removedSegments === 1,
    removedReal,
  );
  await client.call("jianying_save_draft", { name: sweepRemove });
  const afterSweepRemove = JSON.parse(
    fs.readFileSync(path.join(DRAFTS_ROOT, sweepRemove, "draft_info.json"), "utf8"),
  );
  check(
    "the orphan sweep leaves the clips it did not create alone",
    (afterSweepRemove.materials.videos ?? []).some(
      (m: any) => m.id === "video-unused",
    ),
    (afterSweepRemove.materials.videos ?? []).map((m: any) => m.id),
  );
  await client.call("jianying_close_draft", { name: sweepRemove });


  // Adding a file that a loaded draft already holds must reuse its material
  // rather than creating a duplicate.
  const reuseName = "Reuse";
  await client.call("jianying_create_draft", {
    name: reuseName, width: 1920, height: 1080, overwrite: true,
  });
  await client.call("jianying_add_video", {
    name: reuseName, filePath: vid1, start: 0, duration: 4,
  });
  await client.call("jianying_save_draft", { name: reuseName });
  await client.call("jianying_close_draft", { name: reuseName });
  await client.call("jianying_open_draft", { name: reuseName });
  await client.call("jianying_add_video", {
    name: reuseName, filePath: vid1, start: 4, duration: 4,
  });
  await client.call("jianying_save_draft", { name: reuseName });
  const reused = JSON.parse(
    fs.readFileSync(path.join(DRAFTS_ROOT, reuseName, "draft_info.json"), "utf8"),
  );
  const reuseSegments = reused.tracks
    .find((t: any) => t.type === "video")
    ?.segments ?? [];
  check(
    "adding a file a loaded draft already holds does not duplicate the material",
    (reused.materials.videos ?? []).length === 1,
    (reused.materials.videos ?? []).length,
  );
  check(
    "the reused material is shared by both segments",
    reuseSegments.length === 2 &&
      reuseSegments[0].material_id === reuseSegments[1].material_id,
    reuseSegments.map((s: any) => s.material_id),
  );
  await client.call("jianying_close_draft", { name: reuseName });

  // The canvas size and frame rate must be validated. A numeric string is
  // accepted and normalised to a number, like the track index; anything else
  // is refused.
  for (const [label, args] of [
    ["a non-numeric width", { name: "Bad_Size2", width: "abc" as any }],
    ["a zero width", { name: "Bad_Size3", width: 0 }],
    ["a negative width", { name: "Bad_Size4", width: -100 }],
    ["a non-numeric fps", { name: "Bad_Fps", fps: "abc" as any }],
    ["a zero fps", { name: "Bad_Fps2", fps: 0 }],
  ]) {
    let sizeErr: string | null = null;
    try {
      await client.call("jianying_create_draft", { ...(args as Record<string, unknown>), overwrite: true });
    } catch (e: any) {
      sizeErr = e.message;
    }
    check(`an invalid canvas value is refused: ${label}`, sizeErr !== null, sizeErr);
  }

  // A numeric string must be normalised to a number in the saved draft, not
  // written through as a string.
  await client.call("jianying_create_draft", {
    name: "String_Size", width: "1920" as any, height: "1080" as any, overwrite: true,
  });
  await client.call("jianying_save_draft", { name: "String_Size" });
  const stringSize = JSON.parse(
    fs.readFileSync(path.join(DRAFTS_ROOT, "String_Size", "draft_info.json"), "utf8"),
  );
  check(
    "a numeric string canvas size is normalised to a number",
    typeof stringSize.canvas_config.width === "number" &&
      typeof stringSize.canvas_config.height === "number",
    stringSize.canvas_config,
  );

  // Opening a draft must not leave an empty folder behind.
  const stray = path.join(DRAFTS_ROOT, "Never_Saved");
  await client.call("jianying_open_draft", { name: "Never_Saved" });
  await client.call("jianying_close_draft", { name: "Never_Saved" });
  check(
    "a draft that was never saved leaves no folder behind",
    !fs.existsSync(stray),
    stray,
  );

  // A save must be atomic: if writing fails, the draft that was on disk must
  // still be there, intact.
  const atomicDir = path.join(DRAFTS_ROOT, "Atomic");
  await client.call("jianying_create_draft", {
    name: "Atomic", width: 1920, height: 1080, overwrite: true,
  });
  await client.call("jianying_add_video", {
    name: "Atomic", filePath: vid1, start: 0, duration: 4,
  });
  await client.call("jianying_save_draft", { name: "Atomic" });
  const atomicBefore = fs.readFileSync(
    path.join(atomicDir, "draft_info.json"),
    "utf8",
  );
  // Make saving fail: put a non-empty directory where one of the target
  // files goes. A rename cannot replace a non-empty directory, so the save
  // fails part-way through.
  const blocked = path.join(atomicDir, "draft_settings");
  fs.rmSync(blocked, { force: true, recursive: true });
  fs.mkdirSync(path.join(blocked, "occupied"), { recursive: true });

  let atomicErr: string | null = null;
  try {
    await client.call("jianying_save_draft", { name: "Atomic" });
  } catch (e: any) {
    atomicErr = e.message;
  }
  check("a failed save reports the failure", atomicErr !== null, atomicErr);
  const atomicAfter = fs.readFileSync(
    path.join(atomicDir, "draft_info.json"),
    "utf8",
  );
  check(
    "a failed save leaves the previous draft intact",
    atomicBefore === atomicAfter,
  );
  const strays = fs
    .readdirSync(atomicDir)
    .filter((f) => f.includes(".tmp") || f.includes(".bak"));
  check("a failed save leaves no temporary file behind", strays.length === 0, strays);

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
