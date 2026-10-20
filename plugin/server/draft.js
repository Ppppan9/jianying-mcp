/**
 * JianYing (剪映) draft engine — MiniMax-native reimplementation.
 *
 * Contract was reverse-engineered from the `jianying-editor-skill` upstream
 * (luoluoluo22/jianying-editor-skill, MIT) and its vendored pyJianYingDraft
 * (Apache-2.0), then verified field-by-field against a golden reference draft
 * produced by the upstream implementation itself.
 *
 * A JianYing draft is a directory containing 4 files + a materials/ folder:
 *   draft_meta_info.json  project registry entry
 *   draft_info.json       the timeline itself (v5.9+ layout)
 *   draft_settings        legacy settings blob
 *   key_value.json        legacy key/value blob
 *   materials/            self-contained copies of every referenced media file
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
/** Microseconds per second. JianYing stores all durations in microseconds. */
export const US = 1_000_000;
/**
 * Text segments render above every visual layer.
 * Verified against the upstream implementation's output.
 */
const TEXT_RENDER_INDEX = 15000;
/**
 * Base render index per track type, matching the upstream TrackType enum.
 * A track's render index is its base plus its relative index within that
 * type, so higher values sit closer to the foreground.
 */
const TRACK_BASE_RENDER_INDEX = {
    video: 0,
    audio: 0,
    text: TEXT_RENDER_INDEX,
};
/**
 * Default track names, matching the names the upstream implementation uses
 * when creating the first track of each type.
 */
const DEFAULT_TRACK_NAMES = {
    video: "VideoTrack",
    audio: "Audio",
    text: "Subtitles",
};
/**
 * Two ranges overlap when neither ends before the other starts.
 * Adjacent ranges (one ends exactly where the other begins) do not overlap.
 * Mirrors the upstream Timerange.overlaps semantics.
 */
export function timerangesOverlap(a, b) {
    const aEnd = a.start + a.duration;
    const bEnd = b.start + b.duration;
    return !(aEnd <= b.start || bEnd <= a.start);
}
// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------
/** Accepts "1.5", "90s", "1m30s", or a number of seconds. Returns seconds. */
export function parseSeconds(value, fallback = 0) {
    if (value === undefined || value === null)
        return fallback;
    if (typeof value === "number")
        return value;
    const raw = String(value).trim();
    if (!raw)
        return fallback;
    if (/^-?\d+(\.\d+)?$/.test(raw))
        return Number(raw);
    let total = 0;
    const re = /(\d+(?:\.\d+)?)\s*(h|m|s|ms)/gi;
    let matched = false;
    let m;
    while ((m = re.exec(raw)) !== null) {
        matched = true;
        const n = Number(m[1]);
        switch (m[2].toLowerCase()) {
            case "h":
                total += n * 3600;
                break;
            case "m":
                total += n * 60;
                break;
            case "s":
                total += n;
                break;
            case "ms":
                total += n / 1000;
                break;
        }
    }
    if (!matched)
        throw new Error(`Cannot parse duration: ${raw}`);
    return total;
}
/** Formats seconds as SRT timestamp (HH:MM:SS,mmm). */
export function formatSrtTime(seconds) {
    const ms = Math.round(seconds * 1000);
    const h = Math.floor(ms / 3_600_000);
    const mm = Math.floor((ms % 3_600_000) / 60_000);
    const ss = Math.floor((ms % 60_000) / 1000);
    const mmm = ms % 1000;
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(mm)}:${pad(ss)},${pad(mmm, 3)}`;
}
/**
 * Splits a script into subtitle chunks of at most `maxChars` characters,
 * preferring punctuation boundaries. Mirrors the upstream "每 18 字一行" rule.
 */
export function splitSubtitleLines(script, maxChars = 18) {
    const paragraphs = script
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean);
    const out = [];
    for (const para of paragraphs) {
        let current = "";
        const tokens = para.match(/[^。！？!?；;，,、]+[。！？!?；;，,、]?/g) ?? [para];
        for (const token of tokens) {
            if (current.length + token.length <= maxChars) {
                current += token;
            }
            else {
                if (current)
                    out.push(current);
                current = token;
            }
        }
        if (current)
            out.push(current);
    }
    return out;
}
// ---------------------------------------------------------------------------
// Media probing
// ---------------------------------------------------------------------------
const IMAGE_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".gif",
]);
/**
 * Duration assigned to a still image that has no intrinsic duration.
 *
 * The upstream implementation falls back to 10 seconds when a probe cannot
 * determine a duration, and treats such files as video material. Matching
 * that keeps the produced draft consistent with drafts created by the
 * reference tooling.
 */
const STILL_IMAGE_DEFAULT_DURATION_US = 10_000_000;
/**
 * Probes a media file for duration and dimensions.
 * Uses ffprobe when available (no native dependency), and falls back to the
 * file extension for still images.
 */
export async function probeMedia(filePath) {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs))
        throw new Error(`Media file not found: ${abs}`);
    const ext = path.extname(abs).toLowerCase();
    const probe = await tryFfprobe(abs);
    if (probe) {
        if (probe.kind === "audio") {
            return { duration: probe.duration, width: 0, height: 0, kind: "audio" };
        }
        return probe;
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
        return {
            duration: STILL_IMAGE_DEFAULT_DURATION_US,
            width: 1920,
            height: 1080,
            kind: "video",
        };
    }
    if (!(await hasFfprobe())) {
        throw new Error(`Cannot probe "${abs}": ffprobe is not available on PATH. ` +
            `Install it (brew install ffmpeg / apt install ffmpeg), or use a still image.`);
    }
    throw new Error(`Cannot probe "${abs}": ffprobe could not read this file. ` +
        `It may be corrupt or in an unsupported format.`);
}
/** Reports whether ffprobe can be executed at all. */
let ffprobeAvailable = null;
async function hasFfprobe() {
    if (ffprobeAvailable !== null)
        return ffprobeAvailable;
    try {
        await execFileAsync("ffprobe", ["-version"], { timeout: 5_000 });
        ffprobeAvailable = true;
    }
    catch {
        ffprobeAvailable = false;
    }
    return ffprobeAvailable;
}
async function tryFfprobe(abs) {
    try {
        const { stdout } = await execFileAsync("ffprobe", [
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            abs,
        ], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
        const data = JSON.parse(stdout);
        const streams = data.streams ?? [];
        const video = streams.find((s) => s.codec_type === "video");
        const audio = streams.find((s) => s.codec_type === "audio");
        let durationUs = 0;
        const rawDur = video?.duration ?? audio?.duration ?? data.format?.duration;
        if (rawDur)
            durationUs = Math.round(Number(rawDur) * US);
        if (video) {
            // A single-frame image exposes a video stream but reports no duration.
            // The upstream implementation falls back to 10 seconds and keeps the
            // material classified as video.
            return {
                duration: durationUs > 0 ? durationUs : STILL_IMAGE_DEFAULT_DURATION_US,
                width: Number(video.width) || 1920,
                height: Number(video.height) || 1080,
                kind: "video",
            };
        }
        if (audio) {
            return { duration: durationUs, width: 0, height: 0, kind: "audio" };
        }
        return null;
    }
    catch {
        return null;
    }
}
const EMPTY_MATERIAL_KEYS = [
    "ai_translates", "audio_balances", "audio_effects", "audio_fades",
    "audio_track_indexes", "audios", "beats", "canvases", "chromas",
    "color_curves", "digital_humans", "drafts", "effects", "flowers",
    "green_screens", "handwrites", "hsl", "images", "log_color_wheels",
    "loudnesses", "manual_deformations", "masks", "material_animations",
    "material_colors", "multi_language_refs", "placeholders", "plugin_effects",
    "primary_color_wheels", "realtime_denoises", "shapes", "smart_crops",
    "smart_relights", "sound_channel_mappings", "speeds", "stickers",
    "tail_leaders", "text_templates", "texts", "time_marks",
    "transitions", "video_effects", "video_trackings", "videos",
    "vocal_beautifys", "vocal_separations",
];
/**
 * Resolves the JianYing drafts directory for the current platform.
 * macOS and Windows paths were confirmed against the upstream implementation.
 */
export function resolveDraftsRoot(explicit) {
    if (explicit && explicit.trim())
        return path.resolve(explicit.trim());
    const override = process.env.JY_PROJECTS_ROOT?.trim();
    if (override)
        return path.resolve(override);
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const candidates = [];
    if (process.platform === "darwin") {
        candidates.push(path.join(home, "Movies", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"), path.join(home, "Movies", "JianyingPro Drafts"), path.join(home, "Library", "Containers", "com.lemon.lvpro", "Data", "Library", "Application Support", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"), path.join(home, "Library", "Containers", "com.bytedance.JianyingPro", "Data", "Library", "Application Support", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"));
    }
    else if (process.platform === "win32") {
        const appData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
        candidates.push(path.join(appData, "JianyingPro", "User Data", "Projects", "com.lveditor.draft"), path.join(appData, "CapCut", "User Data", "Projects", "com.lveditor.draft"), path.join(appData, "JianyingPro Drafts"));
    }
    else {
        candidates.push(path.join(home, "Movies", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"));
    }
    for (const c of candidates) {
        if (fs.existsSync(c))
            return c;
    }
    // None exist yet — return the canonical first candidate so callers can create it.
    return candidates[0];
}
export class Draft {
    name;
    width;
    height;
    fps;
    root;
    dir;
    materialsDir;
    tracks = [];
    materials = new Map();
    materialOrder = [];
    /** path -> { materialId, stagedName } */
    stagedMedia = new Map();
    /**
     * When the caller did not pick a canvas explicitly, the first video's
     * dimensions define the canvas — matching the upstream behaviour that
     * avoids black bars around the footage.
     */
    explicitResolution;
    resolutionResolved = false;
    canvasWidth;
    canvasHeight;
    constructor(options) {
        this.name = sanitizeName(options.name);
        this.width = options.width ?? 1920;
        this.height = options.height ?? 1080;
        this.fps = options.fps ?? 30;
        this.root = resolveDraftsRoot(options.draftsRoot);
        this.dir = path.join(this.root, this.name);
        this.materialsDir = path.join(this.dir, "materials");
        // Defence in depth: even with a sanitised name, refuse to write outside
        // the drafts root.
        if (!isInside(this.root, this.dir)) {
            throw new Error(`Unsafe draft path: "${this.dir}" is outside the drafts root "${this.root}".`);
        }
        this.explicitResolution =
            options.width !== undefined || options.height !== undefined;
        this.canvasWidth = this.width;
        this.canvasHeight = this.height;
        if (fs.existsSync(this.dir)) {
            if (!options.overwrite) {
                throw new Error(`Draft "${this.name}" already exists at ${this.dir}. Pass overwrite=true to replace it.`);
            }
            // Only replace something that actually looks like a draft. Overwriting
            // must never delete an unrelated directory that happens to share the
            // name.
            if (!looksLikeDraft(this.dir)) {
                throw new Error(`Refusing to overwrite "${this.dir}": it does not look like a JianYing draft ` +
                    `(no draft_info.json and no draft_meta_info.json).`);
            }
            fs.rmSync(this.dir, { recursive: true, force: true });
        }
        fs.mkdirSync(this.materialsDir, { recursive: true });
    }
    // -- track helpers ------------------------------------------------------
    /**
     * Returns the track for the given type and relative index, creating it if
     * needed.
     *
     * `relativeIndex` is the track's position among tracks of the same type.
     * In the JianYing schema the track's `attribute` field is the mute flag
     * (always 0 here) and stacking order is carried by `render_index`. The
     * upstream implementation gives every track of a type the same base render
     * index, so the relative index only affects ordering in the track list.
     */
    ensureTrack(type, relativeIndex) {
        const index = Math.max(0, Math.trunc(relativeIndex));
        let track = this.tracks.find((t) => t.type === type && t.index === index);
        if (!track) {
            track = {
                id: randomUUID().replace(/-/g, ""),
                type,
                index,
                segments: [],
                renderIndex: TRACK_BASE_RENDER_INDEX[type],
                name: index === 0 ? DEFAULT_TRACK_NAMES[type] : `${DEFAULT_TRACK_NAMES[type]}_${index}`,
            };
            this.tracks.push(track);
            this.tracks.sort((a, b) => a.renderIndex - b.renderIndex);
        }
        return track;
    }
    /** Timeline end (seconds) of a track, used as the default append position. */
    trackDuration(type, index = 0) {
        const track = this.tracks.find((t) => t.type === type && t.index === index);
        if (!track)
            return 0;
        let maxEnd = 0;
        for (const seg of track.segments) {
            const end = seg.targetTimerange.start + seg.targetTimerange.duration;
            if (end > maxEnd)
                maxEnd = end;
        }
        return maxEnd / US;
    }
    /**
     * Rejects a segment that would overlap an existing one on the same track.
     *
     * Overlapping clips make JianYing render unpredictably, and the upstream
     * implementation raises SegmentOverlap rather than allowing them. Adjacent
     * clips (one ends exactly where the next begins) are fine.
     */
    assertNoOverlap(track, range, kindLabel) {
        for (const seg of track.segments) {
            if (timerangesOverlap(seg.targetTimerange, range)) {
                throw new Error(`SegmentOverlap: new ${kindLabel} [start: ${range.start}, end: ${range.start + range.duration}] ` +
                    `overlaps an existing segment on track ${track.type}/${track.index} ` +
                    `[start: ${seg.targetTimerange.start}, end: ${seg.targetTimerange.start + seg.targetTimerange.duration}]`);
            }
        }
    }
    // -- media --------------------------------------------------------------
    /**
     * Copies a media file into the draft's materials/ folder and registers it.
     * JianYing v5.9+ expects self-contained materials; the staged copy is named
     * after the md5 of the source path, matching the upstream convention.
     */
    async registerMedia(filePath, kind) {
        const abs = path.resolve(filePath);
        if (!fs.existsSync(abs))
            throw new Error(`Media file not found: ${abs}`);
        const existing = this.stagedMedia.get(abs);
        const probe = await probeMedia(abs);
        if (existing) {
            const mat = this.materials.get(existing.materialId);
            return {
                materialId: existing.materialId,
                probe,
                stagedPath: path.join(this.materialsDir, existing.stagedName),
            };
        }
        const md5 = createHash("md5").update(abs).digest("hex");
        const ext = path.extname(abs) || (kind === "audio" ? ".mp3" : ".mp4");
        const stagedName = `${md5}${ext}`;
        const stagedPath = path.join(this.materialsDir, stagedName);
        fs.copyFileSync(abs, stagedPath);
        const materialId = randomUUID().replace(/-/g, "");
        this.stagedMedia.set(abs, { materialId, stagedName });
        if (kind === "audio") {
            this.addMaterial({
                id: materialId,
                kind: "audio",
                data: {
                    app_id: 0,
                    category_id: "",
                    category_name: "local",
                    check_flag: 3,
                    copyright_limit_type: "none",
                    duration: probe.duration,
                    effect_id: "",
                    formula_id: "",
                    id: materialId,
                    local_material_id: stagedName.replace(/\.[^.]+$/, ""),
                    music_id: materialId,
                    name: stagedName,
                    path: stagedPath,
                    source_platform: 0,
                    type: "extract_music",
                    wave_points: [],
                },
            });
        }
        else {
            this.addMaterial({
                id: materialId,
                kind: "video",
                data: {
                    audio_fade: null,
                    category_id: "",
                    category_name: "local",
                    check_flag: 63487,
                    crop: {
                        upper_left_x: 0.0, upper_left_y: 0.0,
                        upper_right_x: 1.0, upper_right_y: 0.0,
                        lower_left_x: 0.0, lower_left_y: 1.0,
                        lower_right_x: 1.0, lower_right_y: 1.0,
                    },
                    crop_ratio: "free",
                    crop_scale: 1.0,
                    duration: probe.duration,
                    height: probe.height,
                    id: materialId,
                    local_material_id: stagedName.replace(/\.[^.]+$/, ""),
                    material_id: materialId,
                    material_name: stagedName,
                    media_path: "",
                    path: stagedPath,
                    type: "video",
                    video_algorithm: {
                        algorithms: [],
                        complement_frame_config: null,
                        deflicker: null,
                        gameplay_configs: [],
                        motion_blur_config: null,
                        noise_reduction: null,
                        path: "",
                        quality_enhance: null,
                        time_range: null,
                    },
                    source_platform: 0,
                    team_id: "",
                    width: probe.width,
                },
            });
        }
        return { materialId, probe, stagedPath };
    }
    addMaterial(entry) {
        this.materials.set(entry.id, entry);
        this.materialOrder.push(entry);
    }
    /**
     * Registers a Speed material for a segment.
     * JianYing expects one `speeds` entry per clip describing its playback rate.
     */
    registerSpeed(speed) {
        const id = randomUUID().replace(/-/g, "");
        this.addMaterial({
            id,
            kind: "speed",
            data: {
                curve_speed: null,
                id,
                mode: 0,
                speed,
                type: "speed",
            },
        });
        return id;
    }
    // -- public mutation API ------------------------------------------------
    /** Adds a video or image clip to a video track. */
    async addVideo(spec) {
        const { materialId, probe } = await this.registerMedia(spec.filePath, "video");
        const track = this.ensureTrack("video", spec.track ?? 0);
        // First video defines the canvas when the caller did not choose one.
        if (!this.explicitResolution && !this.resolutionResolved) {
            if (probe.width > 0 && probe.height > 0) {
                this.canvasWidth = probe.width;
                this.canvasHeight = probe.height;
            }
            this.resolutionResolved = true;
        }
        const startUs = Math.round(parseSeconds(spec.start, 0) * US);
        const sourceStartUs = Math.round(parseSeconds(spec.sourceStart, 0) * US);
        // Speed semantics follow the upstream VideoSegment constructor exactly:
        //
        //   source range + speed given:
        //       target = source duration / speed
        //   source range given, no speed:
        //       speed  = source duration / target duration
        //       target = requested target duration
        //   only a target duration given:
        //       speed  = requested speed (default 1)
        //       source = target duration * speed
        //
        // The caller may give either `duration` (target) or `sourceStart`
        // (source offset); `duration` is always the timeline slot length.
        const requestedTargetUs = Math.round(parseSeconds(spec.duration, 0) * US);
        const requestedSpeed = spec.speed ?? 1;
        const hasSourceOffset = spec.sourceStart !== undefined;
        let sourceUs;
        let targetUs;
        let effectiveSpeed;
        if (requestedTargetUs > 0) {
            // `duration` is the timeline slot length.
            targetUs = requestedTargetUs;
            effectiveSpeed = requestedSpeed;
            sourceUs = Math.round(targetUs * effectiveSpeed);
        }
        else if (hasSourceOffset) {
            // No explicit length: consume the rest of the material from the offset.
            sourceUs = Math.max(0, probe.duration - sourceStartUs);
            targetUs = sourceUs;
            effectiveSpeed = 1;
        }
        else {
            sourceUs = Math.max(0, probe.duration - sourceStartUs);
            targetUs = sourceUs;
            effectiveSpeed = requestedSpeed;
        }
        if (sourceStartUs + sourceUs > probe.duration + 1000) {
            throw new Error(`Requested range ${sourceStartUs / US}s..${(sourceStartUs + sourceUs) / US}s exceeds media duration ${probe.duration / US}s`);
        }
        const targetRange = { start: startUs, duration: targetUs };
        this.assertNoOverlap(track, targetRange, "video clip");
        const seg = {
            id: randomUUID().replace(/-/g, ""),
            materialId,
            targetTimerange: targetRange,
            sourceTimerange: { start: sourceStartUs, duration: sourceUs },
            speed: effectiveSpeed,
            volume: spec.volume ?? 1.0,
            extraMaterialRefs: [],
            clip: defaultClipSettings(),
            speedId: this.registerSpeed(effectiveSpeed),
        };
        track.segments.push(seg);
        return seg;
    }
    /** Adds an audio clip (BGM, voiceover, SFX) to an audio track. */
    async addAudio(spec) {
        const { materialId, probe } = await this.registerMedia(spec.filePath, "audio");
        const track = this.ensureTrack("audio", spec.track ?? 0);
        // The upstream implementation refuses to treat a file with a video track
        // as an audio material; doing so produces a draft JianYing cannot read.
        if (probe.kind === "video") {
            throw new Error(`Audio material must not contain a video track: ${path.resolve(spec.filePath)}`);
        }
        const startUs = Math.round(parseSeconds(spec.start, 0) * US);
        const sourceStartUs = Math.round(parseSeconds(spec.sourceStart, 0) * US);
        const remaining = Math.max(0, probe.duration - sourceStartUs);
        const durationUs = Math.round(parseSeconds(spec.duration, 0) * US) || remaining;
        if (sourceStartUs + durationUs > probe.duration + 1000) {
            throw new Error(`Requested range ${sourceStartUs / US}s..${(sourceStartUs + durationUs) / US}s exceeds media duration ${probe.duration / US}s`);
        }
        const targetRange = { start: startUs, duration: durationUs };
        this.assertNoOverlap(track, targetRange, "audio clip");
        const seg = {
            id: randomUUID().replace(/-/g, ""),
            materialId,
            targetTimerange: targetRange,
            sourceTimerange: { start: sourceStartUs, duration: durationUs },
            speed: 1,
            volume: spec.volume ?? 1.0,
            extraMaterialRefs: [],
            speedId: this.registerSpeed(1),
        };
        if (spec.fadeIn || spec.fadeOut) {
            const fadeId = randomUUID().replace(/-/g, "");
            this.addMaterial({
                id: fadeId,
                kind: "audio_fade",
                data: {
                    id: fadeId,
                    fade_in_duration: Math.round(parseSeconds(spec.fadeIn, 0) * US),
                    fade_out_duration: Math.round(parseSeconds(spec.fadeOut, 0) * US),
                    fade_type: 0,
                    type: "audio_fade",
                },
            });
            seg.extraMaterialRefs.push(fadeId);
        }
        track.segments.push(seg);
        return seg;
    }
    /**
     * Adds a text segment to the text track.
     *
     * `subtitle` switches to the caption defaults (smaller size, black
     * outline, placed low on the canvas). Plain text uses the upstream
     * TextSegment defaults instead.
     */
    addText(spec) {
        const track = this.ensureTrack("text", 0);
        const materialId = randomUUID().replace(/-/g, "");
        const base = spec.subtitle ? SUBTITLE_DEFAULT_STYLE : TEXT_DEFAULT_STYLE;
        const style = normalizeStyle(spec.style, base);
        const chars = [...spec.text];
        // Build per-run styles; upstream emits one style span covering the text.
        const hasStroke = style.stroke.width > 0;
        const content = {
            styles: [
                {
                    fill: {
                        alpha: style.alpha,
                        content: {
                            render_type: "solid",
                            solid: { alpha: style.alpha, color: style.color },
                        },
                    },
                    range: [0, chars.length],
                    size: style.size,
                    bold: style.bold,
                    italic: style.italic,
                    underline: style.underline,
                    strokes: hasStroke
                        ? [
                            {
                                content: { solid: { alpha: 1.0, color: style.stroke.color } },
                                width: style.stroke.width,
                            },
                        ]
                        : [],
                },
            ],
            text: spec.text,
        };
        // check_flag is a bitmask of the effects a text material carries.
        const checkFlag = 7 | (hasStroke ? 8 : 0);
        this.addMaterial({
            id: materialId,
            kind: "text",
            data: {
                id: materialId,
                content: JSON.stringify(content),
                typesetting: 0,
                alignment: style.align,
                letter_spacing: 0.0,
                line_spacing: 0.02,
                line_feed: 1,
                line_max_width: 0.82,
                force_apply_line_max_width: false,
                check_flag: checkFlag,
                // The material type stays "text" for both plain text and captions.
                // JianYing only uses "subtitle" for auto-wrapping text, and the
                // reference implementation does not enable it.
                type: "text",
                global_alpha: style.alpha,
            },
        });
        const startUs = Math.round(parseSeconds(spec.start, 0) * US);
        const durationUs = Math.round(parseSeconds(spec.duration, 0) * US);
        const targetRange = { start: startUs, duration: durationUs };
        this.assertNoOverlap(track, targetRange, "text segment");
        const seg = {
            id: randomUUID().replace(/-/g, ""),
            materialId,
            targetTimerange: targetRange,
            sourceTimerange: null,
            speed: 1,
            volume: 1,
            extraMaterialRefs: [],
            // Subtitles sit low on the canvas, matching the value JianYing itself
            // writes for imported captions. Plain text keeps the default position.
            clip: spec.subtitle
                ? { ...defaultClipSettings(), transform: { x: 0.0, y: SUBTITLE_TRANSFORM_Y } }
                : defaultClipSettings(),
        };
        track.segments.push(seg);
        return seg;
    }
    /**
     * Adds a full subtitle track from a script, splitting into lines and
     * distributing them evenly across the given window.
     */
    addSubtitles(script, start, duration, opts = {}) {
        const lines = splitSubtitleLines(script, opts.maxChars ?? 18);
        if (!lines.length)
            return [];
        const totalUs = Math.round(parseSeconds(duration, 0) * US);
        const perLine = Math.floor(totalUs / lines.length);
        const startUs = Math.round(parseSeconds(start, 0) * US);
        return lines.map((line, i) => this.addText({
            text: line,
            start: (startUs + i * perLine) / US,
            duration: perLine / US,
            style: opts.style,
            subtitle: true,
        }));
    }
    /**
     * Removes every clip that references the given media file.
     *
     * Also drops the now-orphaned materials (the media entry, its speed
     * material and any audio fade) and deletes the staged copy from
     * `materials/`. Leaving orphans behind makes the draft inconsistent —
     * the material list would reference files that no segment uses.
     */
    removeMedia(filePath) {
        const abs = path.resolve(filePath);
        const staged = this.stagedMedia.get(abs);
        if (!staged)
            return 0;
        let removed = 0;
        const removedSpeedIds = new Set();
        const removedFadeIds = new Set();
        for (const track of this.tracks) {
            const keep = [];
            for (const seg of track.segments) {
                if (seg.materialId !== staged.materialId) {
                    keep.push(seg);
                    continue;
                }
                removed++;
                if (seg.speedId)
                    removedSpeedIds.add(seg.speedId);
                for (const ref of seg.extraMaterialRefs)
                    removedFadeIds.add(ref);
            }
            track.segments = keep;
        }
        if (removed === 0)
            return 0;
        // Only drop the media material when no segment still references it.
        const stillReferenced = this.tracks.some((t) => t.segments.some((s) => s.materialId === staged.materialId));
        if (!stillReferenced) {
            this.materials.delete(staged.materialId);
            this.materialOrder = this.materialOrder.filter((m) => m.id !== staged.materialId);
            this.stagedMedia.delete(abs);
            // Remove the staged copy from disk.
            const stagedPath = path.join(this.materialsDir, staged.stagedName);
            try {
                fs.rmSync(stagedPath, { force: true });
            }
            catch {
                /* the staged file may already be gone; the draft is still consistent */
            }
        }
        // Drop the speed and fade materials that only those segments used.
        for (const id of [...removedSpeedIds, ...removedFadeIds]) {
            const stillUsed = this.tracks.some((t) => t.segments.some((s) => s.speedId === id || s.extraMaterialRefs.includes(id)));
            if (!stillUsed) {
                this.materials.delete(id);
                this.materialOrder = this.materialOrder.filter((m) => m.id !== id);
            }
        }
        return removed;
    }
    /** Total timeline duration in seconds (max track end). */
    duration() {
        let max = 0;
        for (const t of this.tracks) {
            for (const s of t.segments) {
                const end = (s.targetTimerange.start + s.targetTimerange.duration) / US;
                if (end > max)
                    max = end;
            }
        }
        return max;
    }
    /** Structured summary of the timeline, for inspection and acceptance checks. */
    summary() {
        return {
            name: this.name,
            dir: this.dir,
            width: this.canvasWidth,
            height: this.canvasHeight,
            fps: this.fps,
            durationSeconds: this.duration(),
            tracks: this.tracks.map((t) => ({
                type: t.type,
                index: t.index,
                renderIndex: t.renderIndex,
                segmentCount: t.segments.length,
                durationSeconds: Math.round(this.trackDuration(t.type, t.index) * 1000) / 1000,
                segments: t.segments.map((s) => ({
                    id: s.id,
                    materialId: s.materialId,
                    start: s.targetTimerange.start / US,
                    duration: s.targetTimerange.duration / US,
                    sourceStart: s.sourceTimerange ? s.sourceTimerange.start / US : null,
                    volume: s.volume,
                    speed: s.speed,
                })),
            })),
            materialCount: this.materialOrder.length,
            materials: this.materialOrder.map((m) => ({
                id: m.id,
                kind: m.kind,
                name: m.data.name ?? m.data.material_name,
            })),
        };
    }
    // -- serialization ------------------------------------------------------
    /** Builds the full draft_info.json payload. */
    buildDraftInfo() {
        const now = Date.now();
        const materials = {};
        for (const key of EMPTY_MATERIAL_KEYS)
            materials[key] = [];
        for (const entry of this.materialOrder) {
            const bucket = entry.kind === "speed"
                ? "speeds"
                : entry.kind === "audio_fade"
                    ? "audio_fades"
                    : entry.kind === "video"
                        ? "videos"
                        : entry.kind === "audio"
                            ? "audios"
                            : "texts";
            materials[bucket].push(entry.data);
        }
        const tracks = this.tracks.map((t) => ({
            // `attribute` is the mute flag in the JianYing schema, not a track
            // index. Every track here is unmuted.
            attribute: 0,
            flag: 0,
            id: t.id,
            is_default_name: false,
            name: t.name,
            segments: t.segments.map((s) => this.serializeSegment(t, s)),
            type: t.type,
        }));
        return {
            business_info: null,
            canvas_config: {
                height: this.canvasHeight,
                ratio: "original",
                width: this.canvasWidth,
            },
            color_space: 0,
            complement_frame_config: {
                open_close_key_complement_frame_flag: false,
                quality_enhance: false,
            },
            config: {
                adjust_max_index: 1,
                attachment_info: [],
                combination_max_index: 1,
                export_range: null,
                extract_audio_last_index: 1,
                lyrics_recognition_id: "",
                lyrics_sync: false,
                lyrics_taskinfo: [],
                maintrack_adsorb: false,
                material_save_mode: 0,
                multi_language_current: "none",
                multi_language_list: [],
                multi_language_main: "none",
                multi_language_mode: "none",
                original_sound_last_index: 1,
                record_audio_last_index: 1,
                sticker_max_index: 1,
                subtitle_keywords_config: null,
                subtitle_recognition_id: "",
                subtitle_sync: false,
                subtitle_taskinfo: [],
                system_font_list: [],
                video_mute: false,
                zoom_info_params: null,
            },
            cover: null,
            create_time: now,
            duration: Math.round(this.duration() * US),
            extra_info: null,
            fps: this.fps,
            free_render_index_mode_on: false,
            group_container: null,
            id: "91E08AC5-22FB-47e2-9AA0-7DC300FAEA2B",
            keyframe_graph_list: [],
            keyframes: {
                adjusts: [], audios: [], effects: [], filters: [],
                handwrites: [], stickers: [], texts: [], videos: [],
            },
            last_modified_platform: {
                app_id: 3704, app_source: "lv", app_version: "5.9.0", os: hostOs(),
            },
            materials,
            mutable_config: null,
            name: "",
            new_version: "110.0.0",
            platform: {
                app_id: 3704, app_source: "lv", app_version: "5.9.0", os: hostOs(),
            },
            relationships: [],
            render_index_track_mode_on: true,
            retouch_cover: null,
            source: "default",
            static_cover_image_path: "",
            time_marks: null,
            tracks,
            update_time: now,
            version: 360000,
            video_algorithm: {
                algorithms: [],
                complement_frame_config: null,
                deflicker: null,
                quality_enhance: null,
            },
        };
    }
    serializeSegment(track, seg) {
        // Every segment references its Speed material through extra_material_refs.
        const extraRefs = [...seg.extraMaterialRefs];
        if (seg.speedId)
            extraRefs.push(seg.speedId);
        const base = {
            enable_adjust: true,
            enable_color_correct_adjust: false,
            enable_color_curves: true,
            enable_color_match_adjust: false,
            enable_color_wheels: true,
            enable_lut: true,
            enable_smart_color_adjust: false,
            last_nonzero_volume: 1.0,
            reverse: false,
            // `track_attribute` mirrors the parent track's mute flag.
            track_attribute: 0,
            // `track_render_index` is the track's position in the track list,
            // while `render_index` is the stacking layer. The upstream
            // implementation writes 0 for every track it creates.
            track_render_index: 0,
            visible: true,
            id: seg.id,
            material_id: seg.materialId,
            target_timerange: seg.targetTimerange,
            common_keyframes: [],
            keyframe_refs: [],
            source_timerange: seg.sourceTimerange,
            speed: seg.speed,
            volume: seg.volume,
            extra_material_refs: extraRefs,
            is_tone_modify: false,
            render_index: track.renderIndex,
        };
        if (track.type === "video") {
            base.clip = seg.clip ?? defaultClipSettings();
            base.uniform_scale = { on: true, value: 1.0 };
            base.hdr_settings = { intensity: 1.0, mode: 1, nits: 1000 };
        }
        else if (track.type === "audio") {
            // Audio segments are not visual: JianYing expects explicit nulls here.
            base.clip = null;
            base.hdr_settings = null;
        }
        else {
            // Text segments are visual but carry no source range.
            base.clip = seg.clip ?? defaultClipSettings();
            base.uniform_scale = { on: true, value: 1.0 };
        }
        return base;
    }
    /** Writes the complete draft directory to disk. */
    save() {
        const written = [];
        const write = (name, content) => {
            const p = path.join(this.dir, name);
            fs.writeFileSync(p, content, "utf8");
            written.push(p);
        };
        write("draft_info.json", JSON.stringify(this.buildDraftInfo(), null, 4));
        write("draft_meta_info.json", JSON.stringify(buildMetaInfo(this.name), null, 4));
        write("draft_settings", [
            "[General]",
            "draft_create_time=0",
            "draft_last_edit_time=0",
            "real_edit_keys=1",
            "real_edit_seconds=0",
            "",
        ].join("\n"));
        write("key_value.json", "{}");
        // Touch the directory so JianYing's project list sorts the newest first.
        const now = new Date();
        fs.utimesSync(this.dir, now, now);
        return { draftPath: this.dir, files: written };
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * The host OS string JianYing records in the draft.
 * Matches the upstream implementation, which writes platform.system().lower().
 */
function hostOs() {
    if (process.platform === "darwin")
        return "mac";
    if (process.platform === "win32")
        return "windows";
    return process.platform;
}
function defaultClipSettings() {
    return {
        transform: { x: 0.0, y: 0.0 },
        scale: { x: 1.0, y: 1.0 },
        rotation: 0.0,
        alpha: 1.0,
        flip: { horizontal: false, vertical: false },
    };
}
/**
 * Default style for a general text segment.
 * Mirrors the upstream TextSegment defaults: size 8, no border, no transform.
 */
const TEXT_DEFAULT_STYLE = {
    size: 8.0,
    bold: false,
    italic: false,
    underline: false,
    color: [1.0, 1.0, 1.0],
    alpha: 1.0,
    align: 0,
    stroke: { color: [0.0, 0.0, 0.0], width: 0 },
};
/**
 * Default style for subtitle captions.
 *
 * Subtitles render low on the canvas with an outline so they stay legible
 * over any footage — the same defaults the upstream skill applies to
 * imported subtitles (size 5, black outline, transform_y -0.8).
 */
const SUBTITLE_DEFAULT_STYLE = {
    size: 5.0,
    bold: false,
    italic: false,
    underline: false,
    color: [1.0, 1.0, 1.0],
    alpha: 1.0,
    align: 0,
    // Stroke width is derived the same way the upstream implementation derives
    // it (width / 100 * 0.2) so the serialized value matches bit for bit.
    stroke: { color: [0.0, 0.0, 0.0], width: 40.0 / 100.0 * 0.2 },
};
/** Vertical offset that places a text segment low on the canvas. */
const SUBTITLE_TRANSFORM_Y = -0.8;
/**
 * Merges a partial style over a base style.
 * The stroke width is only defaulted when the caller supplies a stroke
 * without a width.
 */
function normalizeStyle(partial, base) {
    const stroke = partial?.stroke;
    return {
        size: partial?.size ?? base.size,
        bold: partial?.bold ?? base.bold,
        italic: partial?.italic ?? base.italic,
        underline: partial?.underline ?? base.underline,
        color: partial?.color ?? base.color,
        alpha: partial?.alpha ?? base.alpha,
        align: partial?.align ?? base.align,
        stroke: stroke
            ? {
                color: stroke.color ?? base.stroke.color,
                width: stroke.width ?? base.stroke.width,
            }
            : base.stroke,
    };
}
/**
 * Returns true when `child` is the same as, or nested inside, `parent`.
 * Used to make sure no write escapes the drafts root.
 */
function isInside(parent, child) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    if (rel === "")
        return true;
    return !rel.startsWith("..") && !path.isAbsolute(rel);
}
/**
 * Returns true when a directory looks like a JianYing draft, so an overwrite
 * cannot destroy an unrelated directory that happens to share the name.
 */
function looksLikeDraft(dir) {
    try {
        if (fs.existsSync(path.join(dir, "draft_info.json")) ||
            fs.existsSync(path.join(dir, "draft_content.json")) ||
            fs.existsSync(path.join(dir, "draft_meta_info.json"))) {
            return true;
        }
        // A half-created draft may only have its materials folder — that happens
        // when a previous run was interrupted. It is safe to replace, because
        // every entry is something this tool itself creates.
        const entries = fs.readdirSync(dir);
        if (entries.length === 0)
            return true;
        return entries.every((e) => e === "materials" ||
            e === "draft_settings" ||
            e === "key_value.json");
    }
    catch {
        return false;
    }
}
/**
 * Device names Windows reserves. A draft cannot use them, because the
 * directory cannot be created there.
 */
const WINDOWS_RESERVED_NAMES = new Set([
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);
function sanitizeName(name) {
    const cleaned = String(name)
        .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
        .trim()
        .replace(/^\.+/, "")
        .replace(/\.+$/, "")
        .replace(/\s+/g, " ");
    if (!cleaned)
        throw new Error("Invalid draft name: empty after sanitization.");
    if (WINDOWS_RESERVED_NAMES.has(cleaned.toUpperCase())) {
        throw new Error(`Invalid draft name: "${cleaned}" is a reserved device name.`);
    }
    return cleaned;
}
/**
 * Builds the draft_meta_info.json registry entry.
 * Key set mirrors the upstream draft_meta_info.json template exactly.
 */
export function buildMetaInfo(name) {
    const draftId = createHash("md5").update(name).digest("hex").toUpperCase();
    return {
        cloud_package_completed_time: "",
        draft_cloud_capcut_purchase_info: "",
        draft_cloud_last_action_download: false,
        draft_cloud_materials: [],
        draft_cloud_purchase_info: "",
        draft_cloud_template_id: "",
        draft_cloud_tutorial_info: "",
        draft_cloud_videocut_purchase_info: "",
        draft_cover: "",
        draft_deeplink_url: "",
        draft_enterprise_info: {
            draft_enterprise_extra: "",
            draft_enterprise_id: "",
            draft_enterprise_name: "",
            enterprise_material: null,
        },
        draft_fold_path: "",
        draft_id: draftId,
        draft_is_ai_packaging_used: false,
        draft_is_ai_shorts: false,
        draft_is_ai_translate: false,
        draft_is_article_video_draft: false,
        draft_is_from_deeplink: "false",
        draft_is_invisible: false,
        draft_materials: [
            { type: 0, value: [] },
            { type: 1, value: [] },
            { type: 2, value: [] },
        ],
        draft_materials_copied_info: [],
        draft_name: name,
        draft_new_version: "",
        draft_removable_storage_device: "",
        draft_root_path: path.join(name, "draft_info.json"),
        draft_segment_extra_info: [],
        draft_type: "",
        tm_draft_cloud_completed: "",
        tm_draft_cloud_modified: 0,
        tm_draft_removed: 0,
        tm_duration: 0,
    };
}
/** Lists existing drafts under a drafts root. */
export function listDrafts(draftsRoot) {
    const root = resolveDraftsRoot(draftsRoot);
    if (!fs.existsSync(root))
        return [];
    return fs
        .readdirSync(root)
        .filter((n) => {
        const p = path.join(root, n);
        return fs.statSync(p).isDirectory();
    })
        .map((n) => {
        const infoPath = path.join(root, n, "draft_info.json");
        let duration = 0;
        let width = 0;
        let height = 0;
        if (fs.existsSync(infoPath)) {
            try {
                const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
                duration = (info.duration ?? 0) / US;
                width = info.canvas_config?.width ?? 0;
                height = info.canvas_config?.height ?? 0;
            }
            catch {
                /* keep defaults for an unreadable draft */
            }
        }
        return { name: n, path: path.join(root, n), durationSeconds: duration, width, height };
    })
        .sort((a, b) => a.name.localeCompare(b.name));
}
