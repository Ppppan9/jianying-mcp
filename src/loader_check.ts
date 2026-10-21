/**
 * Loader regression suite.
 *
 * A draft on disk may have been written by JianYing, by another tool, or by
 * a person. The loader reads whatever it finds, so it has to survive shapes
 * it was never designed for: it must refuse them with a clear message, and
 * it must never write a broken file back over the user's draft.
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

function ok(name: string, detail = "") {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}

function bad(name: string, detail: string) {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
}

const MINIMAL = {
  tracks: [],
  materials: { videos: [], audios: [], texts: [], speeds: [] },
  canvas_config: { width: 1920, height: 1080 },
};

/**
 * A deeply nested draft, built as text.
 *
 * The nesting is assembled as a string rather than with JSON.stringify: the
 * recursive stringifier overflows the stack on a small one, and how deep the
 * stack is depends on the machine. The point of the case is the depth of the
 * *file*, not the depth of the stack that built it.
 */
function deepJson(depth: number): string {
  return (
    '{"tracks":[],"materials":{},"deep":' +
    '{"n":'.repeat(depth) +
    '{"a":1}' +
    "}".repeat(depth) +
    "}"
  );
}

interface Case {
  name: string;
  info: string;
  /** What the refusal should say, when the draft is expected to be refused. */
  expect?: RegExp;
  /**
   * A value in the saved draft that must have survived.
   *
   * The draft has to load for this to mean anything — a refused draft is
   * left untouched, so the value would be there for the wrong reason.
   */
  preserved?: { path: string; value: unknown };
}

const CASES: Case[] = [
  { name: "not JSON at all", info: "this is not json", expect: /JSON|parse/i },
  { name: "a JSON array", info: "[]", expect: /object|expect/i },
  { name: "a JSON string", info: '"hello"', expect: /object|expect/i },
  { name: "a JSON number", info: "42", expect: /object|expect/i },
  { name: "JSON null", info: "null", expect: /object|expect/i },
  { name: "an empty object", info: "{}" },
  { name: "tracks is not an array", info: JSON.stringify({ ...MINIMAL, tracks: { a: 1 } }) },
  { name: "tracks holds a string", info: JSON.stringify({ ...MINIMAL, tracks: ["x"] }) },
  { name: "segments is not an array", info: JSON.stringify({ tracks: [{ type: "video", segments: 5 }] }) },
  { name: "materials is not an object", info: JSON.stringify({ ...MINIMAL, materials: [] }) },
  { name: "materials.videos is not an array", info: JSON.stringify({ ...MINIMAL, materials: { videos: 7 } }) },
  {
    name: "a segment without a timerange",
    info: JSON.stringify({
      tracks: [{ type: "video", segments: [{ material_id: "m1", target_timerange: null }] }],
      materials: { videos: [{ id: "m1", type: "video", material_name: "a.mp4" }] },
    }),
  },
  {
    name: "a timerange of strings",
    info: JSON.stringify({
      tracks: [
        {
          type: "video",
          segments: [{ material_id: "m1", target_timerange: { start: "0", duration: "1000000" } }],
        },
      ],
      materials: { videos: [{ id: "m1", type: "video", material_name: "a.mp4" }] },
    }),
  },
  {
    name: "a segment referencing a missing material",
    info: JSON.stringify({
      tracks: [
        { type: "video", segments: [{ material_id: "nope", target_timerange: { start: 0, duration: 1000000 } }] },
      ],
      materials: { videos: [] },
    }),
  },
  {
    name: "extra_material_refs pointing nowhere",
    info: JSON.stringify({
      tracks: [
        {
          type: "video",
          segments: [
            {
              material_id: "m1",
              target_timerange: { start: 0, duration: 1000000 },
              extra_material_refs: ["ghost"],
            },
          ],
        },
      ],
      materials: { videos: [{ id: "m1", type: "video", material_name: "a.mp4" }] },
    }),
  },
  {
    name: "a material with a missing id",
    info: JSON.stringify({
      tracks: [],
      materials: { videos: [{ type: "video", material_name: "a.mp4" }] },
    }),
  },
  { name: "a very deep structure", info: deepJson(2000) },
  { name: "a byte order mark", info: "﻿" + JSON.stringify(MINIMAL) },
  {
    // JianYing 11 writes its drafts encrypted. The file is not broken, it
    // is in a format this tool does not read, and the message has to say so
    // rather than "not valid JSON".
    name: "a draft encrypted by JianYing",
    info:
      "a127MeSg7JcybBBN1ydsJ1J2hijZyAHoJ9FI6ogDB7ag35j49I1bJgxgFpWb" +
      "aGFsbGlnaGFzaGVmaGFzaGZqYWxmaGFqYWxmYWxmaGFqYWxmaA==",
    expect: /encrypts its drafts|written by JianYing 11/,
  },
  {
    name: "a material bucket that is not a list",
    info: JSON.stringify({
      tracks: [],
      materials: { effects: { weird: true } },
      canvas_config: { width: 1920, height: 1080 },
    }),
    preserved: { path: "materials.effects", value: { weird: true } },
  },
  {
    name: "an unknown material bucket",
    info: JSON.stringify({
      tracks: [],
      materials: { stickers: [{ id: "s1", type: "sticker" }] },
      canvas_config: { width: 1920, height: 1080 },
    }),
    preserved: { path: "materials.stickers.0.id", value: "s1" },
  },
];

interface Outcome {
  messages: any[];
  err: string;
  signal: NodeJS.Signals | null;
  before: Buffer;
  after: Buffer | null;
}

function run(c: Case): Promise<Outcome> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jy-load-"));
  const draftDir = path.join(root, "drafts", "Hostile");
  fs.mkdirSync(draftDir, { recursive: true });
  const infoPath = path.join(draftDir, "draft_info.json");
  fs.writeFileSync(infoPath, c.info, "utf8");
  fs.writeFileSync(
    path.join(draftDir, "draft_meta_info.json"),
    JSON.stringify({ draft_id: "x", draft_name: "Hostile", draft_materials: [] }),
    "utf8",
  );
  const before = fs.readFileSync(infoPath);

  const payload =
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "jianying_open_draft",
        arguments: { name: "Hostile", draftsRoot: path.join(root, "drafts") },
      },
    }) +
    "\n" +
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jianying_save_draft", arguments: { name: "Hostile" } },
    }) +
    "\n";

  return new Promise((resolve) => {
    const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.stdin.on("error", () => {});
    child.on("exit", (_code, signal) => {
      let after: Buffer | null = null;
      try {
        after = fs.readFileSync(infoPath);
      } catch {
        /* the file is gone */
      }
      const messages = out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      resolve({ messages, err, signal, before, after });
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.stdin.write(payload);
    child.stdin.end();
    void timer;
  });
}

async function main() {
  console.log("\n\x1b[1mLoader check\x1b[0m");
  console.log("  A hostile draft must not crash the server or corrupt the file.\n");

  for (const c of CASES) {
    const r = await run(c);
    const problems: string[] = [];

    const openReply = r.messages.find((m) => m.id === 1);
    const saveReply = r.messages.find((m) => m.id === 2);
    const openText = String(openReply?.result?.content?.[0]?.text ?? "");

    if (r.signal === "SIGKILL") problems.push("the server never exited");
    if (!openReply) problems.push("no answer to the open");
    if (c.expect && openReply && !c.expect.test(openText)) {
      problems.push(`the refusal did not say what was wrong: "${openText.slice(0, 140)}"`);
    }
    if (openReply && !openReply.result?.isError) {
      if (!saveReply) problems.push("the save was never answered");
      else if (saveReply.result?.isError && r.after && !r.after.equals(r.before)) {
        problems.push("the save failed but the file changed");
      }
    }
    // A refused draft must be left exactly as it was. Reading a draft the
    // server cannot understand and writing an empty one back over it would
    // destroy the user's file with no error anywhere.
    if (openReply?.result?.isError && r.after && !r.after.equals(r.before)) {
      problems.push("the draft was refused but the file changed");
    }
    if (r.err && /TypeError|ReferenceError|is not a function|Cannot read/.test(r.err)) {
      problems.push(`the server threw: ${r.err.trim().split("\n")[0].slice(0, 130)}`);
    }
    if (r.after && !r.after.equals(r.before)) {
      try {
        JSON.parse(r.after.toString("utf8"));
      } catch {
        problems.push("the saved file is not valid JSON");
      }
    }

    // A value the engine does not model must come back out of the saved
    // draft. The draft has to have loaded for this to mean anything.
    if (c.preserved) {
      if (openReply?.result?.isError) {
        problems.push("the draft was refused, so nothing could be preserved");
      } else {
        let saved: any = null;
        try {
          saved = JSON.parse(r.after?.toString("utf8") ?? "null");
        } catch {
          /* already reported above */
        }
        const found = c.preserved.path
          .split(".")
          .reduce<any>((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), saved);
        if (JSON.stringify(found) !== JSON.stringify(c.preserved.value)) {
          problems.push(
            `${c.preserved.path} did not survive the round trip: ${JSON.stringify(found)}`,
          );
        }
      }
    }

    if (problems.length === 0) ok(c.name);
    else bad(c.name, problems.join("\n      "));
  }

  console.log(`\n\x1b[1mLoader: ${passed} passed, ${failed} failed\x1b[0m\n`);
  if (failed > 0) process.exitCode = 1;
}

main();
