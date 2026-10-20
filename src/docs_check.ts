/**
 * Documentation consistency check.
 *
 * The Skill file and the README teach the agent how to call the tools. If
 * they teach a call the server now refuses, the agent follows the
 * documentation and gets an error it cannot explain — the documentation is
 * the contract, so it has to be executable.
 *
 * Two directions are checked:
 *
 *   1. Every documented invocation is sent to the server. The call may fail
 *      for any reason (no such file, no open draft), but it must not fail
 *      with an argument complaint.
 *   2. Every tool the server offers is mentioned in the Skill file. A tool
 *      the agent has never heard of is a tool it will not use.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "server.js");
const repo = path.resolve(here, "..");

/** The name the example draft is opened under while the checks run. */
const SAMPLE_DRAFT = "示例草稿";

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

/**
 * Splits a documented invocation into the tool and its arguments.
 *
 * The examples are written as `tool name=value name=value`, with values that
 * may be quoted and may contain spaces.
 */
function parseInvocation(line: string): { tool: string; args: Record<string, string> } | null {
  const trimmed = line.trim();
  const match = /^(jianying_[a-z_]+)\s+(.*)$/.exec(trimmed);
  if (!match) return null;
  const tool = match[1];
  const rest = match[2];

  const args: Record<string, string> = {};
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (i >= rest.length) break;
    // A trailing comment is not part of the call.
    if (rest[i] === "#") break;

    const keyStart = i;
    while (i < rest.length && rest[i] !== "=" && !/\s/.test(rest[i])) i++;
    if (i >= rest.length || rest[i] !== "=") {
      // A bare word without "=" — skip it rather than guess.
      i++;
      continue;
    }
    const key = rest.slice(keyStart, i);
    i++; // the "="

    let value = "";
    if (rest[i] === '"') {
      i++;
      while (i < rest.length && rest[i] !== '"') {
        value += rest[i];
        i++;
      }
      i++; // the closing quote
    } else {
      while (i < rest.length && !/\s/.test(rest[i])) {
        value += rest[i];
        i++;
      }
    }
    if (key) args[key] = value;
  }
  return { tool, args };
}

/**
 * Turns a documented argument value into a JSON value.
 *
 * A quoted value is a string, a bare number is a number, and everything
 * else is a string. The "..." the examples use as a placeholder becomes a
 * usable name, so the call gets past the name check and the interesting
 * part of the answer is the one about the other arguments.
 */
function coerce(value: string): unknown {
  if (value === "...") return "示例草稿";
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * Errors that mean the documented value itself is wrong.
 *
 * The tool errors carry a prefix ("jianying_add_audio failed: ..."), so the
 * patterns are matched anywhere in the message rather than at the start.
 *
 * The other failures are context, not documentation: no open draft, no such
 * file, a clip that collides with another one.
 */
function isValueComplaint(text: string): boolean {
  return (
    /Invalid arguments/.test(text) ||
    /\bInvalid [a-z]/.test(text) ||
    /must be |must not be|must not contain|must not be negative/.test(text) ||
    /exceeds media duration/.test(text) ||
    /Cannot parse/.test(text) ||
    /Refusing to/.test(text)
  );
}

function exchange(payload: string, waitMs = 6000): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("exit", () => resolve(out.split("\n").filter((l) => l.trim())));
    const timer = setTimeout(() => child.kill("SIGKILL"), waitMs);
    child.stdin.write(payload.endsWith("\n") ? payload : payload + "\n");
    child.stdin.end();
    void timer;
  });
}

/** Collects the documented invocations from a file. */
function collect(file: string): Array<{ source: string; line: number; tool: string; args: Record<string, string> }> {
  const text = fs.readFileSync(file, "utf8");
  const found: Array<{ source: string; line: number; tool: string; args: Record<string, string> }> = [];
  text.split("\n").forEach((raw, index) => {
    // Only lines that start a documented call.
    if (!/^\s*jianying_[a-z_]+\s+/.test(raw)) return;
    // Skip the surrounding prose and the bash fence markers.
    if (/^\s*#/.test(raw)) return;
    const parsed = parseInvocation(raw);
    if (!parsed) return;
    found.push({ source: path.basename(file), line: index + 1, ...parsed });
  });
  return found;
}

/**
 * The tools that act on a draft that has to be open.
 *
 * For these the check opens a draft first and sends the documented call
 * into the same session, so the call reaches the engine's own validation.
 * Without that, the call stops at "no open draft" and a wrong value in the
 * documentation is never noticed.
 */
const NEEDS_OPEN_DRAFT = new Set([
  "jianying_add_video",
  "jianying_add_audio",
  "jianying_add_text",
  "jianying_add_subtitles",
  "jianying_remove_media",
  "jianying_save_draft",
  "jianying_inspect_draft",
  "jianying_close_draft",
  "jianying_export_srt",
]);

/**
 * Real media for the placeholder paths in the examples.
 *
 * The engine probes the file before it validates the rest of the
 * arguments, so a placeholder path stops the call before the value is ever
 * looked at. The examples use "/abs/..." for every path, so the check
 * points them at a real file of the same kind.
 */
const MEDIA_DIR = path.join(repo, "test-media");
const MEDIA_BY_KIND: Record<string, string> = {
  video: "vid1.mp4",
  audio: "bgm.mp3",
  image: "photo.png",
};

function mediaFor(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const name = MEDIA_BY_KIND[ext === ".mp4" || ext === ".mov" ? "video" : ext === ".mp3" || ext === ".wav" || ext === ".m4a" ? "audio" : "image"];
  const candidate = path.join(MEDIA_DIR, name);
  return fs.existsSync(candidate) ? candidate : null;
}

async function main() {
  console.log("\n\x1b[1mDocumentation check\x1b[0m");
  console.log("  The documentation has to be executable.\n");

  const skillPath = path.join(repo, "skills", "jianying-editor", "SKILL.md");
  const readmePath = path.join(repo, "README.md");
  const docs = [...collect(skillPath), ...collect(readmePath)];

  if (docs.length === 0) {
    bad("documented invocations were found", "none were parsed");
  }

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jy-docs-"));

  for (const doc of docs) {
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc.args)) {
      args[key] = coerce(value);
    }

    // Every case gets its own drafts root. A documented save writes to disk,
    // and the next case would then find the draft already there.
    const caseRoot = path.join(workRoot, `case-${doc.line}`);
    const draftsRoot = path.join(caseRoot, "drafts");
    fs.mkdirSync(draftsRoot, { recursive: true });

    const preamble: string[] = [];
    if (NEEDS_OPEN_DRAFT.has(doc.tool)) {
      // The documented call refers to an open draft, so the check opens one
      // and points the documented call at it.
      args.name = SAMPLE_DRAFT;
      preamble.push(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "tools/call",
          params: {
            name: "jianying_open_draft",
            arguments: { name: SAMPLE_DRAFT, draftsRoot },
          },
        }),
      );
    }
    if (doc.tool === "jianying_export_srt") {
      // Never write where the documentation says: the path is a placeholder.
      args.outputPath = path.join(caseRoot, "out.srt");
    }
    if (typeof args.filePath === "string") {
      const real = mediaFor(args.filePath);
      if (real) args.filePath = real;
    }

    const payload =
      preamble.join("\n") +
      (preamble.length ? "\n" : "") +
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: doc.tool, arguments: args },
      }) +
      "\n";

    const lines = await exchange(payload);
    const answered = lines.map((l) => JSON.parse(l)).filter((m) => m?.id === 1);
    const first = answered[0];
    const text = String(first?.result?.content?.[0]?.text ?? "");

    if (!first) {
      bad(`${doc.source}:${doc.line} ${doc.tool}`, "the call was never answered");
    } else if (isValueComplaint(text)) {
      bad(
        `${doc.source}:${doc.line} ${doc.tool}`,
        `the server refuses the documented call: ${text.replace(/\n/g, " ").slice(0, 180)}`,
      );
    } else {
      ok(`${doc.source}:${doc.line} ${doc.tool}`);
    }
  }

  fs.rmSync(workRoot, { recursive: true, force: true });

  // Every tool the server offers has to be in the Skill file.
  const skillText = fs.readFileSync(skillPath, "utf8");
  const toolsLines = await exchange(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
  );
  const list = toolsLines[0] ? JSON.parse(toolsLines[0]) : null;
  const toolNames: string[] = (list?.result?.tools ?? []).map((t: any) => t.name);
  for (const name of toolNames) {
    if (skillText.includes(name)) {
      ok(`the Skill file documents ${name}`);
    } else {
      bad(`the Skill file documents ${name}`, "the tool is never mentioned");
    }
  }

  console.log(`\n\x1b[1mDocumentation: ${passed} passed, ${failed} failed\x1b[0m\n`);
  if (failed > 0) process.exitCode = 1;
}

main();
