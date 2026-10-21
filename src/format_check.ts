/**
 * Format profile check.
 *
 * A draft has to match the version of JianYing that will open it. The
 * application writes its own blank template — `template.tmp`, in plain
 * JSON — into every draft it creates, and that template says exactly what
 * the installed version expects. The engine follows it.
 *
 * `JY_DRAFT_FORMAT=upstream` pins the draft to the reference
 * implementation's format instead, which is what the differential
 * comparison needs. Both directions are checked here.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "server.js");

let passed = 0;
let failed = 0;

function ok(label: string, detail = "") {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}

function bad(label: string, detail: string) {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${label}\n      ${detail}`);
}

/** A stand-in for the template JianYing 11.6 writes for itself. */
function fakeTemplate(): any {
  const buckets = [
    "ai_generate_holders", "ai_text_effects", "ai_translates", "audio_balances",
    "audio_effects", "audio_fades", "audio_pannings", "audio_pitch_shifts",
    "audio_track_indexes", "audios", "beats", "canvases", "chromas",
    "color_curves", "common_mask", "digital_human_model_dressing",
    "digital_humans", "drafts", "effects", "flowers", "green_screens",
    "handwrites", "hsl", "hsl_curves", "images", "log_color_wheels",
    "loudnesses", "manual_beautys", "manual_deformations", "material_animations",
    "material_colors", "multi_language_refs", "placeholder_infos",
    "placeholders", "plugin_effects", "primary_color_wheels",
    "realtime_denoises", "shapes", "smart_crops", "smart_relights",
    "sound_channel_mappings", "speeds", "stickers", "tail_leaders",
    "text_templates", "texts", "time_marks", "transitions", "video_effects",
    "video_radius", "video_shadows", "video_strokes", "video_trackings",
    "videos", "vocal_beautifys", "vocal_separations",
  ];
  const materials: Record<string, unknown> = {};
  for (const bucket of buckets) materials[bucket] = [];
  return {
    ...materials && {},
    canvas_config: { background: null, height: 0, ratio: "original", width: 0 },
    config: { adjust_max_index: 1, maintrack_adsorb: true },
    materials,
    tracks: [],
    new_version: "75.0.0",
    draft_type: "video",
    path: "",
    lyrics_effects: [],
    mixed_track_mode_on: false,
    color_space: -1,
    render_index_track_mode_on: false,
  };
}

function makeRoot(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jy-fmt-"));
  // The template lives inside a draft folder, exactly where the application
  // puts it.
  const seed = path.join(root, "Seeded");
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(
    path.join(seed, "template.tmp"),
    JSON.stringify(fakeTemplate(), null, 4),
    "utf8",
  );
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function generate(root: string, env: Record<string, string>): Promise<any> {
  const payload = [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "jianying_create_draft",
        arguments: { name: "Formatted", width: 1080, height: 1920, fps: 30 },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jianying_save_draft", arguments: { name: "Formatted" } },
    }),
  ].join("\n") + "\n";

  return new Promise((resolve) => {
    const child = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, JY_PROJECTS_ROOT: root, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("exit", () => {
      const messages = out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      const create = messages.find((m) => m.id === 1);
      const failed = create?.result?.isError;
      resolve({ failed, text: String(create?.result?.content?.[0]?.text ?? "") });
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

async function main() {
  console.log("\n\x1b[1mFormat check\x1b[0m");
  console.log("  A draft has to match the JianYing that will open it.\n");

  // --- the default follows the installed application ----------------------
  {
    const { root, cleanup } = makeRoot();
    const created = await generate(root, {});
    const info = JSON.parse(
      fs.readFileSync(path.join(root, "Formatted", "draft_info.json"), "utf8"),
    );

    if (created.failed) {
      bad("a draft can be created with a local template present", created.text.slice(0, 160));
    } else if (info.new_version !== "75.0.0") {
      bad(
        "the draft takes the installed version",
        `new_version is ${info.new_version}, the template says 75.0.0`,
      );
    } else {
      ok("the draft takes the installed version", "new_version = 75.0.0");
    }

    const buckets = Object.keys(info.materials ?? {});
    if (buckets.length !== 56 || !buckets.includes("common_mask") || buckets.includes("masks")) {
      bad(
        "the draft uses the installed material buckets",
        `${buckets.length} buckets, common_mask=${buckets.includes("common_mask")}, masks=${buckets.includes("masks")}`,
      );
    } else {
      ok("the draft uses the installed material buckets", "56 buckets, common_mask instead of masks");
    }

    if (info.draft_type !== "video" || info.path !== "" || info.lyrics_effects === undefined) {
      bad(
        "the draft carries the keys the installed version added",
        `draft_type=${info.draft_type} path=${JSON.stringify(info.path)} lyrics_effects=${JSON.stringify(info.lyrics_effects)}`,
      );
    } else {
      ok("the draft carries the keys the installed version added", "draft_type, path, lyrics_effects");
    }

    cleanup();
  }

  // --- the upstream profile ignores the local template ---------------------
  {
    const { root, cleanup } = makeRoot();
    await generate(root, { JY_DRAFT_FORMAT: "upstream" });
    const info = JSON.parse(
      fs.readFileSync(path.join(root, "Formatted", "draft_info.json"), "utf8"),
    );

    if (info.new_version !== "110.0.0") {
      bad(
        "the upstream profile ignores the local template",
        `new_version is ${info.new_version}, expected the reference value`,
      );
    } else {
      ok("the upstream profile ignores the local template", "new_version = 110.0.0");
    }

    const buckets = Object.keys(info.materials ?? {});
    if (buckets.length !== 45 || !buckets.includes("masks")) {
      bad(
        "the upstream profile keeps the reference buckets",
        `${buckets.length} buckets, masks=${buckets.includes("masks")}`,
      );
    } else {
      ok("the upstream profile keeps the reference buckets", "45 buckets, masks");
    }

    if (info.draft_type !== undefined) {
      bad(
        "the upstream profile does not add the local keys",
        `draft_type=${JSON.stringify(info.draft_type)}`,
      );
    } else {
      ok("the upstream profile does not add the local keys");
    }

    cleanup();
  }

  // --- no template at all is not an error ----------------------------------
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jy-fmt-empty-"));
    const created = await generate(root, {});
    const info = JSON.parse(
      fs.readFileSync(path.join(root, "Formatted", "draft_info.json"), "utf8"),
    );
    if (created.failed) {
      bad("a machine without JianYing still works", created.text.slice(0, 160));
    } else if (info.new_version !== "110.0.0") {
      bad("a machine without JianYing still works", `new_version is ${info.new_version}`);
    } else {
      ok("a machine without JianYing still works", "falls back to the reference format");
    }
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n\x1b[1mFormat: ${passed} passed, ${failed} failed\x1b[0m\n`);
  if (failed > 0) process.exitCode = 1;
}

main();
