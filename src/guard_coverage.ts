#!/usr/bin/env node
/**
 * Guard coverage probe.
 *
 * Every guard in the engine refuses something. This script drives each of
 * them through the public MCP surface and checks that the refusal actually
 * happens — a guard that is not reached is a guard that does not protect.
 *
 * Usage: node dist/guard_coverage.js <mediaDir> <workDir>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "./mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.js");
const MEDIA = process.argv[2] ?? path.join(__dirname, "..", "test-media");
const WORK = process.argv[3] ?? path.join(__dirname, "..", "out_drafts", "guards");

const vid1 = path.join(MEDIA, "vid1.mp4");
const vid2 = path.join(MEDIA, "vid2.mp4");
const bgm = path.join(MEDIA, "bgm.mp3");

let pass = 0;
let fail = 0;
const failures: string[] = [];

async function expectRefusal(
  client: McpClient,
  label: string,
  tool: string,
  args: Record<string, unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await client.call(tool, args);
    fail++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label} — the call was accepted`);
  } catch (e: any) {
    if (pattern.test(e.message)) {
      pass++;
      console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    } else {
      fail++;
      failures.push(label);
      console.log(`  \x1b[31m✗\x1b[0m ${label} — wrong error: ${e.message.slice(0, 80)}`);
    }
  }
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  const client = new McpClient(SERVER, { JY_PROJECTS_ROOT: WORK });
  await client.initialize();

  console.log("\n\x1b[1mGuard coverage\x1b[0m\n");

  // A scratch draft every guard can be tried against.
  await client.call("jianying_create_draft", {
    name: "G", width: 1920, height: 1080, overwrite: true,
  });
  const base = { name: "G" };

  // --- name validation ---------------------------------------------------
  for (const bad of ["..", ".", "   ", "CON"]) {
    await expectRefusal(
      client,
      `draft name refused: ${JSON.stringify(bad)}`,
      "jianying_create_draft",
      { name: bad },
      /Invalid draft name|already exists/,
    );
  }

  // A path separator is not refused but sanitised into an underscore, so a
  // name can never escape the drafts root.
  for (const [index, raw] of ["a/b", "a\\b", "../etc"].entries()) {
    const sanitised = raw.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_");
    const name = `Sep${index}_${raw}`;
    try {
      const created = await client.call("jianying_create_draft", {
        name, overwrite: true,
      });
      // The directory the draft landed in must be a direct child of the
      // drafts root — a separator must never create a nested path.
      const root = path.dirname(created.draft.dir);
      const relative = path.relative(root, created.draft.dir);
      const safe =
        !relative.startsWith("..") &&
        !path.isAbsolute(relative) &&
        !relative.includes(path.sep);
      if (safe) {
        pass++;
        console.log(
          `  \x1b[32m✓\x1b[0m a path separator in the name is sanitised, not obeyed: ${JSON.stringify(raw)} -> ${JSON.stringify(sanitised)}`,
        );
      } else {
        fail++;
        failures.push(`a path separator in the name is sanitised: ${JSON.stringify(raw)}`);
        console.log(
          `  \x1b[31m✗\x1b[0m a path separator escaped the drafts root: ${JSON.stringify(raw)} -> ${created.draft.dir}`,
        );
      }
    } catch (e: any) {
      fail++;
      failures.push(`a path separator in the name is sanitised: ${JSON.stringify(raw)}`);
      console.log(`  \x1b[31m✗\x1b[0m ${e.message.slice(0, 80)}`);
    }
  }

  // --- media validation --------------------------------------------------
  await expectRefusal(
    client, "a missing media file is refused",
    "jianying_add_video", { ...base, filePath: path.join(MEDIA, "nope.mp4") },
    /not found/,
  );
  await expectRefusal(
    client, "a directory is refused as media",
    "jianying_add_video", { ...base, filePath: MEDIA },
    /not a file/,
  );

  // --- range validation --------------------------------------------------
  await expectRefusal(
    client, "a clip longer than its media is refused",
    "jianying_add_video", { ...base, filePath: vid1, duration: 99 },
    /exceeds media duration/,
  );
  await expectRefusal(
    client, "an audio clip longer than its media is refused",
    "jianying_add_audio", { ...base, filePath: bgm, duration: 99 },
    /exceeds media duration/,
  );
  await expectRefusal(
    client, "a negative duration is refused",
    "jianying_add_video", { ...base, filePath: vid1, duration: -5 },
    /must not be negative/,
  );
  await expectRefusal(
    client, "a negative start is refused",
    "jianying_add_text", { ...base, text: "x", start: -3, duration: 1 },
    /must not be negative/,
  );
  await expectRefusal(
    client, "a negative fade is refused",
    "jianying_add_audio", { ...base, filePath: bgm, duration: 2, fadeIn: -1 },
    /must not be negative/,
  );
  await expectRefusal(
    client, "a non-positive maxChars is refused",
    "jianying_add_subtitles", { ...base, script: "x", start: 0, duration: 2, maxChars: 0 },
    /maxChars/,
  );

  // --- material kind validation -----------------------------------------
  await expectRefusal(
    client, "an audio file is refused as a video material",
    "jianying_add_video", { ...base, filePath: bgm, duration: 2 },
    /must not be an audio-only file/,
  );
  await expectRefusal(
    client, "a video file is refused as an audio material",
    "jianying_add_audio", { ...base, filePath: vid1, duration: 2 },
    /must not contain a video track/,
  );

  // --- style validation --------------------------------------------------
  for (const [label, style] of [
    ["a two-component colour", { color: [1, 0] }],
    ["an out-of-range alpha", { alpha: 5 }],
    ["a negative font size", { size: -3 }],
    ["an invalid alignment", { align: 7 }],
  ] as const) {
    await expectRefusal(
      client, `an illegal style is refused: ${label}`,
      "jianying_add_text",
      { ...base, text: "x", start: 0, duration: 1, style },
      /Invalid/,
    );
  }
  await expectRefusal(
    client, "an out-of-range volume is refused",
    "jianying_add_video", { ...base, filePath: vid1, duration: 1, volume: 42 },
    /Invalid volume/,
  );

  // --- canvas validation -------------------------------------------------
  for (const [label, args] of [
    ["a non-numeric width", { width: "abc" }],
    ["a zero width", { width: 0 }],
    ["a negative width", { width: -100 }],
    ["a non-numeric fps", { fps: "abc" }],
    ["a zero fps", { fps: 0 }],
  ] as const) {
    await expectRefusal(
      client, `an invalid canvas value is refused: ${label}`,
      "jianying_create_draft",
      { name: `Bad_${label.replace(/\W+/g, "_")}`, ...args },
      /Invalid/,
    );
  }

  // --- overlap -----------------------------------------------------------
  await client.call("jianying_add_video", { ...base, filePath: vid1, start: 0, duration: 4 });
  await expectRefusal(
    client, "an overlapping clip is refused",
    "jianying_add_video", { ...base, filePath: vid2, start: 2, duration: 3 },
    /SegmentOverlap/,
  );

  // --- session conflicts --------------------------------------------------
  await expectRefusal(
    client, "re-opening an open draft is refused",
    "jianying_open_draft", { name: "G" },
    /already open/,
  );
  await expectRefusal(
    client, "creating over an open draft is refused",
    "jianying_create_draft", { name: "G" },
    /already open/,
  );

  // --- export guards ------------------------------------------------------
  await expectRefusal(
    client, "exporting to a non-srt path is refused",
    "jianying_export_srt", { ...base, outputPath: path.join(WORK, "x.mp4") },
    /must end in .srt/,
  );
  const existing = path.join(WORK, "x.srt");
  fs.writeFileSync(existing, "KEEP", "utf8");
  await expectRefusal(
    client, "exporting over an existing file is refused",
    "jianying_export_srt", { ...base, outputPath: existing },
    /Refusing to overwrite/,
  );
  check(
    "the protected file is untouched",
    fs.readFileSync(existing, "utf8") === "KEEP",
  );

  // --- unknown draft ------------------------------------------------------
  await expectRefusal(
    client, "inspecting an unknown draft is refused",
    "jianying_inspect_draft", { name: "No_Such_Draft" },
    /No open draft/,
  );

  client.close();

  console.log(`\n\x1b[1mGuards: ${pass} enforced, ${fail} not enforced\x1b[0m`);
  if (fail) {
    console.log("\nNot enforced:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

function check(label: string, condition: boolean): void {
  if (condition) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
