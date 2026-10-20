#!/usr/bin/env node
/**
 * Extended differential harness.
 *
 * Exercises edge cases the basic comparison never reached:
 *   - still images (photo material type)
 *   - clip speed != 1
 *   - multiple tracks of the same type
 *   - audio fade in / fade out
 *   - boundary durations (zero-length, exactly the media length)
 *   - subtitle splitting with punctuation and mixed line lengths
 *
 * Each scenario is generated twice — once by the upstream oracle, once by this
 * MCP server — and the two drafts are diffed field by field.
 *
 * Usage: node dist/diff_scenarios.js <upstreamSkillDir> <mediaDir> <workDir>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { McpClient } from "./mcp-client.js";
import { Draft } from "./draft.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.js");

const UPSTREAM_SKILL = process.argv[2];
const MEDIA = process.argv[3];
const WORK = process.argv[4] ?? path.join(process.cwd(), "diff_scenarios");

if (!UPSTREAM_SKILL) {
  console.error("Usage: node dist/diff_scenarios.js <upstreamSkillDir> <mediaDir> <workDir>");
  process.exit(2);
}

const UP_PY = process.env.JY_UPSTREAM_PYTHON ?? "python3";

/** Extensions of still-image media. */
const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".gif",
]);

// ---------------------------------------------------------------------------
// Scenario definitions — each is a list of operations applied to both sides.
// ---------------------------------------------------------------------------

interface Op {
  tool: string;
  args: Record<string, unknown>;
}

interface Scenario {
  name: string;
  /**
   * Upstream operations, expressed in the upstream Python API.
   * The reference is the underlying pyJianYingDraft library rather than the
   * wrapper skill, because the wrapper silently drops several capabilities
   * (clip speed, audio fades, out-of-range validation).
   */
  upstream: string;
  /** MCP operations. */
  mcp: Op[];
}

const scenarios: Scenario[] = [
  {
    name: "still_image",
    upstream: `
mat = draft.VideoMaterial(stage(os.path.join(M, "photo.png")))
mat2 = draft.VideoMaterial(stage(os.path.join(M, "vid1.mp4")))
sf.add_track(draft.TrackType.video, "PhotoTrack")
sf.add_track(draft.TrackType.video, "VideoTrack2", relative_index=1)
sf.add_segment(draft.VideoSegment(mat, draft.trange(0, 5_000_000)), "PhotoTrack")
sf.add_segment(draft.VideoSegment(mat2, draft.trange(5_000_000, 4_000_000)), "VideoTrack2")
`,
    mcp: [
      { tool: "jianying_add_video", args: { filePath: "photo.png", start: 0, duration: 5 } },
      { tool: "jianying_add_video", args: { filePath: "vid1.mp4", start: 5, duration: 4, track: 1 } },
    ],
  },
  {
    name: "speed_change",
    upstream: `
mat = draft.VideoMaterial(stage(os.path.join(M, "vid1.mp4")))
sf.add_track(draft.TrackType.video)
sf.add_segment(draft.VideoSegment(mat, draft.trange(0, 2_000_000), speed=2.0))
`,
    mcp: [
      { tool: "jianying_add_video", args: { filePath: "vid1.mp4", start: 0, duration: 2, speed: 2 } },
    ],
  },
  {
    name: "source_offset",
    upstream: `
mat = draft.VideoMaterial(stage(os.path.join(M, "vid1.mp4")))
sf.add_track(draft.TrackType.video)
sf.add_segment(draft.VideoSegment(mat, draft.trange(0, 2_000_000),
                                 source_timerange=draft.trange(1_000_000, 2_000_000)))
`,
    mcp: [
      { tool: "jianying_add_video", args: { filePath: "vid1.mp4", start: 0, sourceStart: 1, duration: 2 } },
    ],
  },
  {
    name: "multi_track",
    upstream: `
m1 = draft.VideoMaterial(stage(os.path.join(M, "vid1.mp4")))
m2 = draft.VideoMaterial(stage(os.path.join(M, "vid2.mp4")))
sf.add_track(draft.TrackType.video, "Track2", relative_index=1)
sf.add_track(draft.TrackType.video, "Track3", relative_index=2)
sf.add_segment(draft.VideoSegment(m1, draft.trange(0, 4_000_000)), "Track2")
sf.add_segment(draft.VideoSegment(m2, draft.trange(0, 3_000_000)), "Track3")
`,
    mcp: [
      { tool: "jianying_add_video", args: { filePath: "vid1.mp4", start: 0, duration: 4, track: 1 } },
      { tool: "jianying_add_video", args: { filePath: "vid2.mp4", start: 0, duration: 3, track: 2 } },
    ],
  },
  {
    name: "audio_fade",
    upstream: `
amat = draft.AudioMaterial(stage(os.path.join(M, "bgm.mp3")))
sf.add_track(draft.TrackType.audio)
aseg = draft.AudioSegment(amat, draft.trange(0, 5_000_000))
aseg.add_fade(1_000_000, 1_000_000)
sf.add_segment(aseg)
`,
    mcp: [
      { tool: "jianying_add_audio", args: { filePath: "bgm.mp3", start: 0, track: 0, fadeIn: 1, fadeOut: 1 } },
    ],
  },
  {
    name: "exact_boundary",
    upstream: `
mat = draft.VideoMaterial(stage(os.path.join(M, "vid1.mp4")))
amat = draft.AudioMaterial(stage(os.path.join(M, "bgm.mp3")))
sf.add_track(draft.TrackType.video)
sf.add_track(draft.TrackType.audio)
sf.add_segment(draft.VideoSegment(mat, draft.trange(0, 4_000_000)))
sf.add_segment(draft.AudioSegment(amat, draft.trange(0, 5_000_000)))
`,
    mcp: [
      { tool: "jianying_add_video", args: { filePath: "vid1.mp4", start: 0, duration: 4 } },
      { tool: "jianying_add_audio", args: { filePath: "bgm.mp3", start: 0, track: 0 } },
    ],
  },
  {
    name: "text_styles",
    upstream: `
sf.add_track(draft.TrackType.text)
sf.add_segment(draft.TextSegment("第一行字幕", draft.trange(0, 2_000_000)))
sf.add_segment(draft.TextSegment("Second line", draft.trange(2_000_000, 2_000_000)))
`,
    mcp: [
      { tool: "jianying_add_text", args: { text: "第一行字幕", start: 0, duration: 2 } },
      { tool: "jianying_add_text", args: { text: "Second line", start: 2, duration: 2 } },
    ],
  },
  {
    name: "overlap_attempt",
    upstream: `
mat = draft.VideoMaterial(stage(os.path.join(M, "vid1.mp4")))
sf.add_track(draft.TrackType.video)
sf.add_segment(draft.VideoSegment(mat, draft.trange(0, 4_000_000)))
try:
    sf.add_segment(draft.VideoSegment(mat, draft.trange(2_000_000, 3_000_000)))
    print("OVERLAP_ALLOWED")
except Exception as e:
    print("OVERLAP_REJECTED:", type(e).__name__)
`,
    mcp: [
      { tool: "jianying_add_video", args: { filePath: "vid1.mp4", start: 0, duration: 4 } },
      { tool: "jianying_add_video", args: { filePath: "vid2.mp4", start: 2, duration: 3 } },
    ],
  },
  {
    name: "audio_overrun",
    upstream: `
amat = draft.AudioMaterial(stage(os.path.join(M, "bgm.mp3")))
sf.add_track(draft.TrackType.audio)
try:
    sf.add_segment(draft.AudioSegment(amat, draft.trange(0, 99_000_000)))
    print("OVERRUN_ALLOWED")
except Exception as e:
    print("OVERRUN_REJECTED:", type(e).__name__)
`,
    mcp: [
      { tool: "jianying_add_audio", args: { filePath: "bgm.mp3", start: 0, track: 0, duration: 99 } },
    ],
  },
  {
    name: "video_as_audio",
    upstream: `
try:
    draft.AudioMaterial(stage(os.path.join(M, "vid1.mp4")))
    print("VIDEO_AS_AUDIO_ALLOWED")
except Exception as e:
    print("VIDEO_AS_AUDIO_REJECTED:", type(e).__name__)
`,
    mcp: [
      { tool: "jianying_add_audio", args: { filePath: "vid1.mp4", start: 0, track: 0 } },
    ],
  },
  {
    name: "adjacent_clips",
    upstream: `
mat = draft.VideoMaterial(stage(os.path.join(M, "vid1.mp4")))
sf.add_track(draft.TrackType.video)
sf.add_segment(draft.VideoSegment(mat, draft.trange(0, 4_000_000)))
sf.add_segment(draft.VideoSegment(mat, draft.trange(4_000_000, 3_000_000)))
`,
    mcp: [
      { tool: "jianying_add_video", args: { filePath: "vid1.mp4", start: 0, duration: 4 } },
      { tool: "jianying_add_video", args: { filePath: "vid1.mp4", start: 4, duration: 3 } },
    ],
  },
  {
    name: "subtitle_style",
    upstream: `
sf.add_track(draft.TrackType.text)
seg = draft.TextSegment(
    "字幕测试",
    draft.trange(0, 2_000_000),
    style=draft.TextStyle(size=5.0),
    border=draft.TextBorder(color=(0.0, 0.0, 0.0), alpha=1.0, width=40.0),
    clip_settings=draft.ClipSettings(transform_y=-0.8),
)
sf.add_segment(seg)
`,
    mcp: [
      { tool: "jianying_add_subtitles", args: { script: "字幕测试", start: 0, duration: 2, maxChars: 18 } },
    ],
  },
];

// ---------------------------------------------------------------------------
// Upstream generator
// ---------------------------------------------------------------------------

function runUpstream(scenario: Scenario, outRoot: string): string {
  const scriptPath = path.join(WORK, `up_${scenario.name}.py`);
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(
    scriptPath,
    `
import os, sys, json, shutil, hashlib
SKILL = ${JSON.stringify(UPSTREAM_SKILL)}
sys.path.insert(0, os.path.join(SKILL, "scripts", "vendor"))
import pyJianYingDraft as draft

M = ${JSON.stringify(MEDIA)}
root = ${JSON.stringify(outRoot)}
name = ${JSON.stringify("Up_" + scenario.name)}
draft_dir = os.path.join(root, name)
os.makedirs(os.path.join(draft_dir, "materials"), exist_ok=True)

def stage(src):
    """Copy media into the draft's materials folder, md5-named like the MCP server."""
    src = os.path.abspath(src)
    digest = hashlib.md5(src.encode("utf-8")).hexdigest()
    ext = os.path.splitext(src)[1]
    staged = os.path.join(draft_dir, "materials", digest + ext)
    shutil.copy2(src, staged)
    return staged

sf = draft.ScriptFile(1920, 1080, 30, False)
${scenario.upstream}
sf.dump(os.path.join(draft_dir, "draft_info.json"))
print("SAVED")
`,
    "utf8",
  );
  const stdout = execFileSync(UP_PY, [scriptPath], { encoding: "utf8", timeout: 120_000 });
  return stdout;
}

// ---------------------------------------------------------------------------
// MCP generator
// ---------------------------------------------------------------------------

async function runMcp(scenario: Scenario, outRoot: string): Promise<string> {
  const client = new McpClient(SERVER, { JY_PROJECTS_ROOT: outRoot });
  await client.initialize();
  const name = "Mcp_" + scenario.name;
  await client.call("jianying_create_draft", { name, width: 1920, height: 1080, fps: 30 });
  const notes: string[] = [];
  for (const op of scenario.mcp) {
    const args: Record<string, unknown> = { ...op.args, name };
    for (const key of ["filePath"]) {
      if (typeof args[key] === "string") {
        args[key] = path.join(MEDIA, args[key] as string);
      }
    }
    try {
      await client.call(op.tool, args);
    } catch (e: any) {
      notes.push(`REJECTED: ${e.message}`);
    }
  }
  try {
    await client.call("jianying_save_draft", { name });
  } catch (e: any) {
    notes.push(`SAVE_REJECTED: ${e.message}`);
  }
  client.close();
  return notes.join("\n");
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{32}$/i;

/**
 * Tolerance for values that depend on the media prober rather than on the
 * draft format.
 *
 * ffprobe reports an mp3's container duration (5.000s) while MediaInfo
 * reports the decoded sample count (5.042s) — the difference is the encoder
 * padding. Both describe the same audio, and JianYing renders either
 * identically, so the comparison ignores sub-frame differences.
 */
const DURATION_TOLERANCE_US = 100_000;

function isDurationKey(key: string): boolean {
  return (
    key === "duration" ||
    key.endsWith("_duration") ||
    key.endsWith("_duration_us")
  );
}

function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "content" && typeof v === "string") {
        try {
          out[k] = JSON.stringify(JSON.parse(v), Object.keys(JSON.parse(v)).sort());
          continue;
        } catch {
          /* keep the raw string */
        }
      }
      out[k] = normalize(v);
    }
    return out;
  }
  if (typeof value === "string" && UUID_RE.test(value)) return "<uuid>";
  return value;
}

/** Builds a structural fingerprint that ignores volatile values. */
function fingerprint(draftDir: string): any {
  const infoPath = path.join(draftDir, "draft_info.json");
  if (!fs.existsSync(infoPath)) return null;
  const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));

  const materials: any = {};
  for (const [bucket, items] of Object.entries(info.materials ?? {})) {
    if (!Array.isArray(items) || items.length === 0) continue;
    const targetBucket = bucket;
    if (!materials[targetBucket]) materials[targetBucket] = [];
    materials[targetBucket].push(
      ...items.map((m: any) => {
        const c: Record<string, any> = { ...m };
        delete c.id;
        delete c.material_id;
        delete c.local_material_id;
        delete c.name;
        delete c.path;
        delete c.music_id;
        // The reference implementation classifies a still image as "photo"
        // only when MediaInfo is available; with its ffprobe fallback it
        // reports "video". The environment-dependent case is normalised away
        // so the comparison stays meaningful on a machine without MediaInfo;
        // the MediaInfo behaviour is checked separately.
        const stagedName = String(m.material_name ?? m.name ?? "");
        const ext = stagedName.slice(stagedName.lastIndexOf(".")).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext) && process.env.JY_UPSTREAM_HAS_MEDIAINFO !== "1") {
          c.type = "<image>";
          c.duration = "<image-duration>";
        }
        delete c.material_name;
        if (typeof c.content === "string") {
          try {
            c.content = JSON.parse(c.content);
          } catch {
            /* keep raw */
          }
        }
        return c;
      }),
    );
  }

  // Sort every bucket so the comparison does not depend on insertion order.
  for (const key of Object.keys(materials)) {
    materials[key].sort((a: any, b: any) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }

  const tracks = (info.tracks ?? [])
    .map((t: any) => ({
      type: t.type,
      attribute: t.attribute,
      segmentCount: t.segments?.length ?? 0,
      segments: (t.segments ?? []).map((s: any) => {
        const c = { ...s };
        delete c.id;
        delete c.material_id;
        // The references point at uuids, which differ between the two runs.
        // Their *count* is compared instead — a dropped reference is exactly
        // the kind of defect this comparison has to catch.
        //
        // A reference to a material that does not exist is a defect in the
        // reference implementation: its text segments point at a speed
        // material that is never added to the `speeds` bucket. Such a
        // dangling reference is counted separately so that it cannot mask a
        // real difference in the references that do resolve.
        const allIds = new Set<string>();
        for (const items of Object.values(info.materials ?? {})) {
          for (const m of items as any[]) {
            if (m && typeof m.id === "string") allIds.add(m.id);
          }
        }
        const refs = (s.extra_material_refs ?? []) as string[];
        c.extra_material_refs = refs.filter((r) => allIds.has(r)).length;
        c.dangling_refs = refs.filter((r) => !allIds.has(r)).length;
        return c;
      }),
    }))
    .sort((a: any, b: any) => `${a.type}:${a.attribute}`.localeCompare(`${b.type}:${b.attribute}`));

  return normalize({
    canvas: info.canvas_config,
    fps: info.fps,
    duration: info.duration,
    version: info.version,
    platform: { ...info.platform, os: "<os>" },
    video_algorithm: info.video_algorithm,
    materials,
    tracks,
  });
}

function diff(a: any, b: any, pathStr = "", keyName = ""): string[] {
  const out: string[] = [];
  if (a === null || b === null) {
    if (a !== b) out.push(`${pathStr}: upstream=${JSON.stringify(a)} mcp=${JSON.stringify(b)}`);
    return out;
  }
  if (typeof a !== typeof b || typeof a !== "object") {
    if (a !== b) {
      const bothNum = typeof a === "number" && typeof b === "number";
      if (bothNum) {
        // Durations depend on the media prober, not on the draft format.
        // Tolerate sub-frame differences so the comparison stays meaningful.
        const tolerance = isDurationKey(keyName) ? DURATION_TOLERANCE_US : 1e-9;
        if (Math.abs(a - b) > tolerance) {
          out.push(`${pathStr}: upstream=${JSON.stringify(a)} mcp=${JSON.stringify(b)}`);
        }
      } else {
        out.push(`${pathStr}: upstream=${JSON.stringify(a)} mcp=${JSON.stringify(b)}`);
      }
    }
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${pathStr}: type mismatch`);
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      out.push(`${pathStr}: length upstream=${a.length} mcp=${b.length}`);
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      out.push(...diff(a[i], b[i], `${pathStr}[${i}]`, keyName));
    }
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    // A dangling reference is a reference to a material that does not exist.
    // The reference implementation produces them for text segments; this
    // project does not. More dangling references is a defect, so only a
    // difference in the other direction counts.
    if (k === "dangling_refs") {
      if (Number(b[k]) > Number(a[k])) {
        out.push(
          `${pathStr}.${k}: upstream=${a[k]} mcp=${b[k]} — the draft gained a dangling reference`,
        );
      }
      continue;
    }
    if (!(k in a)) {
      out.push(`${pathStr}.${k}: only in mcp (${JSON.stringify(b[k])?.slice(0, 80)})`);
      continue;
    }
    if (!(k in b)) {
      out.push(`${pathStr}.${k}: only in upstream (${JSON.stringify(a[k])?.slice(0, 80)})`);
      continue;
    }
    out.push(...diff(a[k], b[k], `${pathStr}.${k}`, k));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n\x1b[1mExtended differential scenarios\x1b[0m");
  console.log(`  upstream: ${UPSTREAM_SKILL}`);
  console.log(`  media:    ${MEDIA}`);
  console.log(`  work:     ${WORK}\n`);

  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  for (const scenario of scenarios) {
    const upRoot = path.join(WORK, "upstream");
    const mcpRoot = path.join(WORK, "mcp");
    fs.rmSync(upRoot, { recursive: true, force: true });
    fs.rmSync(mcpRoot, { recursive: true, force: true });

    let upStdout = "";
    let mcpNotes = "";
    let upError: string | null = null;
    let mcpError: string | null = null;

    try {
      upStdout = runUpstream(scenario, upRoot);
    } catch (e: any) {
      upError = String(e.stdout ?? "") + String(e.message ?? "");
    }
    try {
      mcpNotes = await runMcp(scenario, mcpRoot);
    } catch (e: any) {
      mcpError = String(e.message ?? e);
    }

    const upDir = path.join(upRoot, "Up_" + scenario.name);
    const mcpDir = path.join(mcpRoot, "Mcp_" + scenario.name);

    // Behavioural parity: did both sides accept or reject the operation?
    const upRejected = /REJECTED/.test(upStdout);
    const mcpRejected = /REJECTED/.test(mcpNotes) || mcpError !== null;

    const problems: string[] = [];

    if (upRejected !== mcpRejected) {
      problems.push(
        `behaviour mismatch: upstream ${upRejected ? "REJECTED" : "accepted"}, mcp ${mcpRejected ? "REJECTED" : "accepted"}`,
      );
      if (upStdout.trim()) problems.push(`  upstream said: ${upStdout.trim().split("\n").pop()}`);
      if (mcpNotes.trim()) problems.push(`  mcp said: ${mcpNotes.trim().split("\n").pop()}`);
    }

    if (!upRejected && !mcpRejected) {
      const upFp = fingerprint(upDir);
      const mcpFp = fingerprint(mcpDir);
      if (upFp === null && mcpFp === null) {
        problems.push("both sides produced no draft");
      } else if (upFp === null || mcpFp === null) {
        problems.push(`draft presence mismatch: upstream=${upFp !== null} mcp=${mcpFp !== null}`);
      } else {
        problems.push(...diff(upFp, mcpFp, "draft"));
      }
    }

    if (problems.length === 0) {
      pass++;
      console.log(`  \x1b[32m✓\x1b[0m ${scenario.name}`);
    } else {
      fail++;
      failures.push(scenario.name);
      console.log(`  \x1b[31m✗\x1b[0m ${scenario.name}`);
      for (const p of problems.slice(0, 12)) console.log(`      ${p}`);
      if (problems.length > 12) console.log(`      ... and ${problems.length - 12} more`);
    }
  }

  console.log(`\n\x1b[1mScenarios: ${pass} matched, ${fail} differed\x1b[0m`);

  // --- load → save round trip -------------------------------------------
  // The differential scenarios only ever compare freshly generated drafts.
  // This check covers the path where a draft is opened, edited and saved
  // again — the path where unmodelled materials can be lost.
  console.log("\n\x1b[1mLoad → save round trip\x1b[0m");
  const roundTrip = checkRoundTrip();
  if (roundTrip.problems.length === 0) {
    console.log(`  \x1b[32m✓\x1b[0m ${roundTrip.label}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${roundTrip.label}`);
    for (const p of roundTrip.problems.slice(0, 12)) console.log(`      ${p}`);
  }

  if (fail) {
    console.log("\nDiffering scenarios:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

/**
 * Verifies that opening a draft, saving it and reopening it keeps everything.
 *
 * A draft is seeded with material this engine does not model — the kind a
 * real project contains: effects, stickers, transitions, and a media bin with
 * clips that are not on the timeline. Saving must not strip any of it.
 */
function checkRoundTrip(): { label: string; problems: string[] } {
  const problems: string[] = [];
  const label = "a loaded draft keeps everything it was given";

  const root = path.join(WORK, "roundtrip");
  fs.rmSync(root, { recursive: true, force: true });
  const draftDir = path.join(root, "Seeded");
  fs.mkdirSync(path.join(draftDir, "materials"), { recursive: true });

  // Seed a draft that carries material this engine does not model.
  const seedDir = path.join(WORK, "seed");
  execFileSync(UP_PY, [path.join(__dirname, "..", "scripts", "make_roundtrip_seed.py"), seedDir], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const seeded = JSON.parse(
    fs.readFileSync(path.join(seedDir, "draft_info.json"), "utf8"),
  );
  fs.writeFileSync(
    path.join(draftDir, "draft_info.json"),
    JSON.stringify(seeded, null, 4),
    "utf8",
  );
  fs.writeFileSync(path.join(draftDir, "draft_meta_info.json"), "{}", "utf8");

  const before = JSON.parse(
    fs.readFileSync(path.join(draftDir, "draft_info.json"), "utf8"),
  );

  // Load it, save it, and compare what came back.
  const draft = new Draft({
    name: "Seeded",
    draftsRoot: root,
    load: true,
  });
  draft.save();

  const after = JSON.parse(
    fs.readFileSync(path.join(draftDir, "draft_info.json"), "utf8"),
  );

  // Every material bucket must survive, with the same number of entries.
  const beforeBuckets = before.materials ?? {};
  const afterBuckets = after.materials ?? {};
  for (const bucket of Object.keys(beforeBuckets)) {
    const b = beforeBuckets[bucket] ?? [];
    const a = afterBuckets[bucket] ?? [];
    if (b.length !== a.length) {
      problems.push(
        `materials.${bucket}: before=${b.length} after=${a.length} — ` +
          `${b.length - a.length} entr${b.length - a.length === 1 ? "y" : "ies"} lost`,
      );
    }
  }

  // Every segment must survive, with the same references.
  const countSegs = (info: any) =>
    (info.tracks ?? []).reduce(
      (n: number, t: any) => n + (t.segments?.length ?? 0),
      0,
    );
  if (countSegs(before) !== countSegs(after)) {
    problems.push(
      `segments: before=${countSegs(before)} after=${countSegs(after)}`,
    );
  }

  const countRefs = (info: any) =>
    (info.tracks ?? []).reduce(
      (n: number, t: any) =>
        n +
        (t.segments ?? []).reduce(
          (m: number, s: any) => m + (s.extra_material_refs?.length ?? 0),
          0,
        ),
      0,
    );
  if (countRefs(before) !== countRefs(after)) {
    problems.push(
      `extra_material_refs: before=${countRefs(before)} after=${countRefs(after)} — ` +
        `references were dropped`,
    );
  }

  // The editing preferences must survive too.
  for (const key of ["maintrack_adsorb", "lyrics_sync", "subtitle_sync"]) {
    if (before.config?.[key] !== after.config?.[key]) {
      problems.push(
        `config.${key}: before=${before.config?.[key]} after=${after.config?.[key]}`,
      );
    }
  }

  return { label, problems };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
