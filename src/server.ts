#!/usr/bin/env node
/**
 * jianying-mcp — MiniMax-native MCP server for JianYing (剪映) draft automation.
 *
 * Implemented directly against the MCP stdio JSON-RPC wire protocol with zero
 * runtime dependencies, so the Plugin package stays small, starts instantly and
 * has no native or transitive install requirements.
 *
 * Design goal vs. the upstream `jianying-editor-skill`: the upstream skill makes
 * the agent author a bespoke Python script for every edit. This server instead
 * exposes deterministic, atomic tools so the agent calls one operation and gets
 * one structured result back.
 */

import fs from "node:fs";
import path from "node:path";
import {
  Draft,
  formatSrtTime,
  listDrafts,
  parseSeconds,
  probeMedia,
  resolveDraftsRoot,
  sanitizeDraftName,
  splitSubtitleLines,
} from "./draft.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "jianying-mcp", version: "1.0.0" };

/**
 * Drafts are opened by name and kept in a registry so consecutive tool calls
 * operate on the same in-memory timeline.
 */
const sessions = new Map<string, Draft>();

/**
 * Upper bound on concurrently open drafts.
 *
 * Each draft holds its materials and segments in memory, and a long-running
 * session could otherwise accumulate drafts without bound. The limit is
 * generous enough for real work while keeping the footprint bounded.
 */
const MAX_OPEN_DRAFTS = 32;

function requireSession(name: string): Draft {
  const key = sessionKey(name);
  const draft = sessions.get(key);
  if (!draft) {
    throw new Error(
      `No open draft named "${key}". Call jianying_open_draft (or jianying_create_draft) first. Open drafts: ${[...sessions.keys()].join(", ") || "(none)"}`,
    );
  }
  return draft;
}

/**
 * Registers a draft, refusing to silently replace an existing session.
 *
 * Replacing would discard the in-memory timeline of an unsaved draft, which
 * is a silent data loss the caller cannot see.
 */
function registerSession(draft: Draft): void {
  const existing = sessions.get(draft.name);
  if (existing && existing !== draft) {
    throw new Error(
      `Draft "${draft.name}" is already open in this session. ` +
        `Close it first with jianying_close_draft, or use a different name.`,
    );
  }
  if (!sessions.has(draft.name) && sessions.size >= MAX_OPEN_DRAFTS) {
    throw new Error(
      `Too many drafts are open (limit ${MAX_OPEN_DRAFTS}). ` +
        `Close some with jianying_close_draft before opening more.`,
    );
  }
  sessions.set(draft.name, draft);
}

/**
 * Refuses to open a name that is already in use, before any file is touched.
 */
function assertNameAvailable(name: string): void {
  const key = sessionKey(name);
  if (sessions.has(key)) {
    throw new Error(
      `Draft "${key}" is already open in this session. ` +
        `Close it first with jianying_close_draft, or use a different name.`,
    );
  }
  if (sessions.size >= MAX_OPEN_DRAFTS) {
    throw new Error(
      `Too many drafts are open (limit ${MAX_OPEN_DRAFTS}). ` +
        `Close some with jianying_close_draft before opening more.`,
    );
  }
}

/**
 * The key a draft is registered under.
 *
 * Draft names are sanitised on the way in (a name like "My Draft: v2" becomes
 * "My Draft_ v2" because a colon is illegal in a file name). Sessions must be
 * looked up under the same key, otherwise the caller cannot address the
 * draft it just created with the name it used.
 */
function sessionKey(name: string): string {
  return sanitizeDraftName(name);
}

/**
 * Normalises a track index.
 *
 * The engine truncates a fractional index, so the append position must be
 * computed against the same index the engine will actually use.
 */
function trackIndex(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema DSL (the subset this server needs)
// ---------------------------------------------------------------------------

type Schema = Record<string, unknown>;

const S = {
  string: (description: string, extra: Schema = {}): Schema => ({ type: "string", description, ...extra }),
  number: (description: string, extra: Schema = {}): Schema => ({ type: "number", description, ...extra }),
  boolean: (description: string, extra: Schema = {}): Schema => ({ type: "boolean", description, ...extra }),
  object: (description: string, properties: Record<string, Schema>, required: string[] = []): Schema => ({
    type: "object",
    description,
    properties,
    ...(required.length ? { required } : {}),
  }),
  array: (description: string, items: Schema): Schema => ({ type: "array", description, items }),
  enum: (description: string, values: (string | number)[], extra: Schema = {}): Schema => ({
    type: "number",
    description,
    enum: values,
    ...extra,
  }),
  /** Accepts either a number of seconds or a duration string like "1m30s". */
  duration: (description: string): Schema => ({
    description: `${description} (seconds as a number, or a duration string such as "1m30s")`,
    anyOf: [{ type: "number" }, { type: "string" }],
  }),
};

const textStyleProperties: Record<string, Schema> = {
  size: S.number("Font size in JianYing units (default 5.0)"),
  bold: S.boolean("Bold"),
  italic: S.boolean("Italic"),
  underline: S.boolean("Underline"),
  color: S.array("RGB triple 0..1, e.g. [1, 0.85, 0.2]", { type: "number" }),
  alpha: S.number("Opacity 0..1"),
  align: S.enum("0 = left, 1 = center, 2 = right", [0, 1, 2]),
  stroke: S.object("Stroke settings", {
    color: S.array("RGB triple 0..1", { type: "number" }),
    width: S.number("Stroke width"),
  }),
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (args: any) => Promise<unknown> | unknown;
}

const TOOLS: ToolDef[] = [
  {
    name: "jianying_open_draft",
    description:
      "Open (or create) a JianYing draft by name and return its timeline structure. Use this to resume work on an existing draft, or to inspect drafts listed by jianying_list_drafts.",
    inputSchema: S.object("Open a JianYing draft", {
      name: S.string("Draft name (the folder name inside the drafts root)"),
      draftsRoot: S.string("Override the drafts root directory"),
      overwrite: S.boolean("Replace the draft if it already exists"),
      width: S.number("Canvas width (default 1920)"),
      height: S.number("Canvas height (default 1080)"),
      fps: S.number("Frame rate (default 30)"),
    }, ["name"]),
    handler: (args) => {
      // Refuse before touching the filesystem.
      assertNameAvailable(args.name);
      const draft = new Draft({
        name: args.name,
        width: args.width,
        height: args.height,
        fps: args.fps,
        draftsRoot: resolveDraftsRoot(args.draftsRoot),
        overwrite: args.overwrite ?? false,
      });
      registerSession(draft);
      return { ok: true, draft: draft.summary() };
    },
  },

  {
    name: "jianying_create_draft",
    description:
      "Create a new JianYing draft and return its structure. Set width/height to match the source footage (1080x1920 for 9:16 vertical, 1920x1080 for 16:9). When omitted, the canvas adopts the first video's resolution automatically.",
    inputSchema: S.object("Create a new JianYing draft", {
      name: S.string("Draft name"),
      width: S.number("Canvas width"),
      height: S.number("Canvas height"),
      fps: S.number("Frame rate (default 30)"),
      draftsRoot: S.string("Override the drafts root directory"),
      overwrite: S.boolean(
        "Replace an existing draft with the same name. Off by default, because overwriting discards the existing project.",
      ),
    }, ["name"]),
    handler: (args) => {
      // Check for a conflicting session *before* touching the filesystem, so
      // a rejected call can never delete the draft that is already open.
      assertNameAvailable(args.name);
      const draft = new Draft({
        name: args.name,
        width: args.width,
        height: args.height,
        fps: args.fps,
        draftsRoot: resolveDraftsRoot(args.draftsRoot),
        overwrite: args.overwrite ?? false,
      });
      registerSession(draft);
      return { ok: true, draft: draft.summary() };
    },
  },

  {
    name: "jianying_close_draft",
    description:
      "Close an open draft and release its memory. Unsaved changes are lost, so call jianying_save_draft first. Use this when a draft is finished or was created by mistake.",
    inputSchema: S.object("Close an open draft", {
      name: S.string("Open draft name"),
    }, ["name"]),
    handler: (args) => {
      const key = sessionKey(args.name);
      const draft = sessions.get(key);
      if (!draft) {
        return {
          ok: true,
          closed: false,
          message: `No open draft named "${key}".`,
        };
      }
      sessions.delete(key);
      return {
        ok: true,
        closed: true,
        name: key,
        draftPath: draft.dir,
        openDrafts: [...sessions.keys()],
        note: "Any changes that were not saved with jianying_save_draft are discarded.",
      };
    },
  },

  {
    name: "jianying_list_drafts",
    description:
      "List all JianYing drafts found under the drafts root, with duration and canvas size. Use this before opening an unknown draft.",
    inputSchema: S.object("List drafts", {
      draftsRoot: S.string("Override the drafts root directory"),
    }),
    handler: (args) => {
      const drafts = listDrafts(args.draftsRoot);
      return {
        ok: true,
        draftsRoot: resolveDraftsRoot(args.draftsRoot),
        count: drafts.length,
        drafts,
      };
    },
  },

  {
    name: "jianying_add_video",
    description:
      "Add a video or image clip to a video track. When 'start' is omitted the clip is appended after the current track content.",
    inputSchema: S.object("Add a video or image clip", {
      name: S.string("Open draft name"),
      filePath: S.string("Absolute path to the media file"),
      start: S.duration("Timeline start"),
      sourceStart: S.duration("Offset inside the source file"),
      duration: S.duration("Clip length; defaults to the rest of the file"),
      track: S.number("Video track index (0 = bottom layer, 1 = overlay)"),
      volume: S.number("Clip volume 0..1"),
      speed: S.number("Playback speed multiplier"),
    }, ["name", "filePath"]),
    handler: async (args) => {
      const draft = requireSession(args.name);
      const start =
        args.start === undefined
          ? draft.trackDuration("video", trackIndex(args.track))
          : parseSeconds(args.start);
      const seg = await draft.addVideo({ ...args, start, track: trackIndex(args.track) });
      return {
        ok: true,
        segment: {
          id: seg.id,
          startSeconds: seg.targetTimerange.start / 1e6,
          durationSeconds: seg.targetTimerange.duration / 1e6,
          sourceStartSeconds: seg.sourceTimerange ? seg.sourceTimerange.start / 1e6 : null,
        },
        draft: draft.summary(),
      };
    },
  },

  {
    name: "jianying_add_audio",
    description:
      "Add an audio clip (BGM, voiceover, sound effect) to an audio track. Use track 0 for the main audio bed and track 1 for narration.",
    inputSchema: S.object("Add an audio clip", {
      name: S.string("Open draft name"),
      filePath: S.string("Absolute path to the audio file"),
      start: S.duration("Timeline start"),
      sourceStart: S.duration("Offset inside the source file"),
      duration: S.duration("Clip length"),
      track: S.number("Audio track index (0 = BGM, 1 = narration)"),
      volume: S.number("Volume 0..1"),
      fadeIn: S.duration("Fade-in length"),
      fadeOut: S.duration("Fade-out length"),
    }, ["name", "filePath"]),
    handler: async (args) => {
      const draft = requireSession(args.name);
      // Like the video tool, an omitted start appends after the current
      // content of the track.
      const start =
        args.start === undefined
          ? draft.trackDuration("audio", trackIndex(args.track))
          : parseSeconds(args.start);
      const seg = await draft.addAudio({ ...args, start, track: trackIndex(args.track) });
      return {
        ok: true,
        segment: {
          id: seg.id,
          track: trackIndex(args.track),
          startSeconds: seg.targetTimerange.start / 1e6,
          durationSeconds: seg.targetTimerange.duration / 1e6,
          volume: seg.volume,
        },
        draft: draft.summary(),
      };
    },
  },

  {
    name: "jianying_add_text",
    description:
      "Add a text or subtitle segment to the text track. Use for titles, lower thirds and single captions.",
    inputSchema: S.object("Add a text segment", {
      name: S.string("Open draft name"),
      text: S.string("Text content"),
      start: S.duration("Start time"),
      duration: S.duration("Duration"),
      track: S.number("Text track index (0 = captions, 1 = titles/overlays)"),
      style: S.object("Text style", textStyleProperties),
    }, ["name", "text", "start", "duration"]),
    handler: (args) => {
      const draft = requireSession(args.name);
      const seg = draft.addText({ ...args, track: trackIndex(args.track) });
      return {
        ok: true,
        segment: {
          id: seg.id,
          startSeconds: seg.targetTimerange.start / 1e6,
          durationSeconds: seg.targetTimerange.duration / 1e6,
        },
        draft: draft.summary(),
      };
    },
  },

  {
    name: "jianying_add_subtitles",
    description:
      "Add a full subtitle track from a script. The script is split into short lines (Chinese ads use ~18 chars/line) and distributed evenly across the time window. Returns the generated lines so they can be proofread.",
    inputSchema: S.object("Add a subtitle track from a script", {
      name: S.string("Open draft name"),
      script: S.string("Full narration / caption script"),
      start: S.duration("Start time"),
      duration: S.duration("Total window"),
      maxChars: S.number("Max characters per line (default 18)"),
      track: S.number("Text track index (0 = captions, 1 = titles/overlays)"),
      style: S.object("Text style", textStyleProperties),
    }, ["name", "script", "start", "duration"]),
    handler: (args) => {
      const draft = requireSession(args.name);
      const lines = splitSubtitleLines(args.script, args.maxChars ?? 18);
      const segs = draft.addSubtitles(
        args.script,
        parseSeconds(args.start),
        parseSeconds(args.duration),
        {
          maxChars: args.maxChars ?? 18,
          style: args.style,
          track: args.track ?? 0,
        },
      );
      return {
        ok: true,
        lineCount: lines.length,
        lines,
        segments: segs.map((s) => ({
          id: s.id,
          startSeconds: s.targetTimerange.start / 1e6,
          durationSeconds: s.targetTimerange.duration / 1e6,
        })),
        draft: draft.summary(),
      };
    },
  },

  {
    name: "jianying_remove_media",
    description: "Remove every clip that references the given media file from the timeline.",
    inputSchema: S.object("Remove clips by media file", {
      name: S.string("Open draft name"),
      filePath: S.string("Absolute path to the media file to remove"),
    }, ["name", "filePath"]),
    handler: (args) => {
      const draft = requireSession(args.name);
      const removed = draft.removeMedia(args.filePath);
      return { ok: true, removedSegments: removed, draft: draft.summary() };
    },
  },

  {
    name: "jianying_save_draft",
    description:
      "Write the current timeline to disk as a JianYing draft. Call this last — the draft only becomes visible to JianYing after saving.",
    inputSchema: S.object("Save the draft to disk", {
      name: S.string("Open draft name"),
    }, ["name"]),
    handler: (args) => {
      const draft = requireSession(args.name);
      const result = draft.save();
      return {
        ok: true,
        draftPath: result.draftPath,
        files: result.files,
        summary: draft.summary(),
        note: "Open JianYing and the draft appears in the project list. Export is done manually inside JianYing (macOS has no headless exporter).",
      };
    },
  },

  {
    name: "jianying_inspect_draft",
    description:
      "Return the structured timeline of the open draft: tracks, segments, timing and materials. Use this as the acceptance check after editing.",
    inputSchema: S.object("Inspect the open draft", {
      name: S.string("Open draft name"),
    }, ["name"]),
    handler: (args) => {
      const draft = requireSession(args.name);
      return { ok: true, draft: draft.summary() };
    },
  },

  {
    name: "jianying_export_srt",
    description:
      "Export the text track of the open draft as an SRT subtitle file, so the captions can be checked in any subtitle editor.",
    inputSchema: S.object("Export subtitles as SRT", {
      name: S.string("Open draft name"),
      outputPath: S.string("Absolute path of the .srt file to write"),
      overwrite: S.boolean("Replace an existing file (default false)"),
    }, ["name", "outputPath"]),
    handler: (args) => {
      const draft = requireSession(args.name);

      // Guard the write: the path comes from the caller, and silently
      // replacing a video or a source file with subtitle text would destroy
      // the user's material.
      const outputPath = path.resolve(args.outputPath);
      if (path.extname(outputPath).toLowerCase() !== ".srt") {
        throw new Error(
          `Refusing to write "${outputPath}": the output path must end in .srt.`,
        );
      }
      if (fs.existsSync(outputPath) && !args.overwrite) {
        throw new Error(
          `Refusing to overwrite the existing file "${outputPath}". ` +
            `Pass overwrite=true to replace it.`,
        );
      }

      const info = draft.buildDraftInfo();
      const texts: any[] = (info.materials as any).texts ?? [];
      // Every text track is exported, not just the first one: a title on a
      // second track would otherwise be silently dropped.
      const textTracks = (info.tracks as any[]).filter((t) => t.type === "text");
      const cues: Array<{ start: number; end: number; text: string }> = [];
      for (const track of textTracks) {
        for (const seg of track.segments ?? []) {
          const mat = texts.find((m) => m.id === seg.material_id);
          if (!mat) continue;
          const content = JSON.parse(mat.content);
          cues.push({
            start: seg.target_timerange.start / 1e6,
            end:
              (seg.target_timerange.start + seg.target_timerange.duration) / 1e6,
            text: content.text,
          });
        }
      }
      // Sort by time so the SRT reads in timeline order.
      cues.sort((a, b) => a.start - b.start);

      const lines: string[] = [];
      let index = 1;
      for (const cue of cues) {
        lines.push(String(index++));
        lines.push(`${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}`);
        lines.push(cue.text);
        lines.push("");
      }
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
      return { ok: true, outputPath, cueCount: index - 1 };
    },
  },
  {
    name: "jianying_probe_media",
    description:
      "Probe a media file for duration, resolution and type. Use this before adding clips so durations can be planned.",
    inputSchema: S.object("Probe a media file", {
      filePath: S.string("Absolute path to the media file"),
    }, ["filePath"]),
    handler: async (args) => {
      const probe = await probeMedia(args.filePath);
      return {
        ok: true,
        filePath: args.filePath,
        kind: probe.kind,
        durationSeconds: probe.duration / 1e6,
        width: probe.width,
        height: probe.height,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(message: unknown) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

/**
 * Serialises a tool result.
 *
 * `JSON.stringify` throws on circular structures and BigInt values. A result
 * that cannot be serialised must not take the whole server down, so the
 * failure is reported as text instead.
 */
function stringifyResult(result: unknown): string {
  try {
    return JSON.stringify(result, null, 2) ?? "null";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Result could not be serialised: ${message}`;
  }
}

function reply(id: unknown, result: unknown) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg: any) {
  const { id, method, params } = msg;

  // Notifications carry no id and expect no response.
  if (id === undefined || id === null) return;

  try {
    await dispatch(id, method, params);
  } catch (error) {
    // Every request must get exactly one response, even if the handler threw
    // in an unexpected place.
    const message = error instanceof Error ? error.message : String(error);
    try {
      replyError(id, -32603, `Internal error: ${message}`);
    } catch {
      /* the transport is gone; nothing more can be reported */
    }
  }
}

async function dispatch(id: unknown, method: string, params: any) {
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;

    case "ping":
      reply(id, {});
      return;

    case "tools/list":
      reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      return;

    case "tools/call": {
      const toolName = params?.name;
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        replyError(id, -32602, `Unknown tool: ${toolName}`);
        return;
      }
      try {
        const result = await tool.handler(params?.arguments ?? {});
        reply(id, {
          content: [{ type: "text", text: stringifyResult(result) }],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Tool-level failures are reported as tool errors, not protocol errors,
        // so the agent can read and react to them.
        reply(id, {
          isError: true,
          content: [{ type: "text", text: `${tool.name} failed: ${message}` }],
        });
      }
      return;
    }

    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = "";
/**
 * Cap on the unterminated-line buffer.
 *
 * A peer that sends data without a newline would otherwise grow the buffer
 * without bound. Real requests are far smaller than this.
 */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.length > MAX_BUFFER_BYTES) {
    process.stderr.write(
      `jianying-mcp: input buffer exceeded ${MAX_BUFFER_BYTES} bytes without a newline; dropping the connection.\n`,
    );
    buffer = "";
    process.exit(1);
  }
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      for (const m of parsed) void handleMessage(m);
    } else {
      void handleMessage(parsed);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// A crash in one request must not take the server down and break the host
// session. Log to stderr (stdout carries the protocol) and keep serving.
process.on("uncaughtException", (error) => {
  process.stderr.write(`jianying-mcp uncaught exception: ${error?.stack ?? error}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`jianying-mcp unhandled rejection: ${String(reason)}\n`);
});
