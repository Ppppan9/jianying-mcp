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
/**
 * The duration strings the engine understands.
 *
 * `parseSeconds` scans for number-and-unit groups and adds them up, so it
 * quietly ignores anything it does not recognise — "1m30s oops" becomes 90
 * seconds. That is forgiving, but a typo in a caption time is a silent wrong
 * answer. The schema uses this pattern to require the *whole* string to be a
 * duration, so trailing rubbish is refused before it reaches the engine.
 */
export const DURATION_STRING_PATTERN = /^(?:-?\d+(?:\.\d+)?|\s*\d+(?:\.\d+)?\s*(?:ms|h|m|s)(?:\s*\d+(?:\.\d+)?\s*(?:ms|h|m|s))*)\s*$/i;
/**
 * Accepts "1.5", "90s", "1m30s", "500ms", or a number of seconds.
 * Returns seconds.
 *
 * The unit alternation lists "ms" before "m", because a regex alternation
 * matches the first alternative that fits — with "m" first, "500ms" would be
 * read as 500 minutes.
 */
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
    const re = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi;
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
    // A leading minus applies to the whole expression.
    return raw.startsWith("-") ? -total : total;
}
/**
 * Parses a duration and rejects negative or non-finite results.
 *
 * A negative timerange is not something JianYing can represent, so it is
 * refused rather than written into the draft.
 */
export function parseDuration(value, fallback, label) {
    if (value === undefined || value === null)
        return fallback;
    const seconds = parseSeconds(value, fallback ?? 0);
    if (!Number.isFinite(seconds)) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    if (seconds < 0) {
        throw new Error(`Invalid ${label}: ${value} must not be negative.`);
    }
    return seconds;
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
 *
 * `maxChars` must be a positive number. A non-positive limit has no sensible
 * meaning and would make the split loop forever, so it is rejected here.
 */
export function splitSubtitleLines(script, maxChars = 18) {
    if (!Number.isFinite(maxChars) || maxChars < 1) {
        throw new Error(`Invalid maxChars: ${maxChars} must be a number of at least 1.`);
    }
    const limit = Math.trunc(maxChars);
    const paragraphs = script
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean);
    const out = [];
    for (const para of paragraphs) {
        let current = "";
        const tokens = para.match(/[^。！？!?；;，,、]+[。！？!?；;，,、]?/g) ?? [para];
        for (const token of tokens) {
            // A token longer than the limit is split further, so a run-on sentence
            // without punctuation still produces readable lines.
            const pieces = token.length > limit ? hardSplit(token, limit) : [token];
            for (const piece of pieces) {
                if (current.length + piece.length <= limit) {
                    current += piece;
                }
                else {
                    if (current)
                        out.push(current);
                    current = piece;
                }
            }
        }
        if (current)
            out.push(current);
    }
    return out;
}
/**
 * Splits a run of text into pieces of at most `maxChars` characters.
 *
 * The split prefers a space for latin text and falls back to a hard cut for
 * scripts without word separators.
 */
function hardSplit(text, maxChars) {
    const out = [];
    // A non-positive limit would make the loop below never advance: the slice
    // would be empty and the same text would be cut forever. A limit below 1
    // is treated as 1, and the caller validates the range separately.
    const limit = Math.max(1, Math.trunc(maxChars));
    let rest = text;
    while (rest.length > limit) {
        let cut = limit;
        // Prefer breaking at a space so words stay intact.
        const space = rest.lastIndexOf(" ", limit);
        if (space > limit * 0.5)
            cut = space + 1;
        out.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut);
    }
    if (rest)
        out.push(rest);
    return out;
}
// ---------------------------------------------------------------------------
// Media probing
// ---------------------------------------------------------------------------
/**
 * Extensions of still-image media.
 *
 * GIF is deliberately absent: an animated GIF has a real duration and the
 * reference implementation treats it as a video, not a still image.
 */
const IMAGE_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic",
]);
/**
 * Duration assigned to a still image that has no intrinsic duration.
 *
 * The upstream implementation gives an image a 3 hour material duration and
 * a 10 second fallback when a probe cannot determine one. The long duration
 * matters: a still image may be placed on the timeline for any length, and
 * the segment's source range must fit inside the material's duration.
 */
const STILL_IMAGE_DEFAULT_DURATION_US = 10_000_000;
const STILL_IMAGE_MATERIAL_DURATION_US = 10_800_000_000;
/**
 * Parses an ffprobe frame rate such as "25/1" or "30000/1001".
 * Returns 0 when the value cannot be parsed.
 */
function parseFrameRate(value) {
    if (typeof value !== "string" || !value)
        return 0;
    const [num, den] = value.split("/");
    const n = Number(num);
    const d = den === undefined ? 1 : Number(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0)
        return 0;
    return n / d;
}
/**
 * Probes a media file for duration and dimensions.
 * Uses ffprobe when available (no native dependency), and falls back to the
 * file extension for still images.
 */
export async function probeMedia(filePath) {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs))
        throw new Error(`Media file not found: ${abs}`);
    if (!fs.statSync(abs).isFile()) {
        throw new Error(`Media path is not a file: ${abs}`);
    }
    const ext = path.extname(abs).toLowerCase();
    const looksLikeImage = IMAGE_EXTENSIONS.has(ext);
    const probe = await tryFfprobe(abs);
    if (probe) {
        if (probe.kind === "audio") {
            return { duration: probe.duration, width: 0, height: 0, kind: "audio" };
        }
        return probe;
    }
    if (looksLikeImage) {
        return {
            duration: STILL_IMAGE_DEFAULT_DURATION_US,
            width: 1920,
            height: 1080,
            kind: "video",
            stillImage: true,
            materialType: "photo",
            materialDuration: STILL_IMAGE_MATERIAL_DURATION_US,
        };
    }
    if (!(await hasFfprobe())) {
        throw new Error(`Cannot probe "${abs}": ffprobe is not available on PATH. ` +
            `Install it (brew install ffmpeg / apt install ffmpeg), or use a still image.`);
    }
    throw new Error(`Cannot probe "${abs}": ffprobe could not read this file. ` +
        `It may be corrupt or in an unsupported format.`);
}
/**
 * Locates the ffprobe executable.
 *
 * A GUI-launched application inherits a minimal PATH — on macOS that is
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which does not contain `/opt/homebrew/bin`
 * where Homebrew installs ffmpeg. Relying on PATH alone would make every
 * probe fail in the Plugin path, so the usual install locations are checked
 * explicitly.
 */
let ffprobePath;
async function resolveFfprobe() {
    if (ffprobePath !== undefined)
        return ffprobePath;
    const candidates = ["ffprobe"];
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) {
        candidates.push(path.join(home, ".local", "bin", "ffprobe"), path.join(home, "bin", "ffprobe"), path.join(home, ".ffmpeg", "bin", "ffprobe"), path.join(home, "Applications", "ffmpeg", "bin", "ffprobe"));
    }
    candidates.push("/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe", "/bin/ffprobe", "/opt/local/bin/ffprobe", "/snap/bin/ffprobe");
    for (const candidate of candidates) {
        try {
            await execFileAsync(candidate, ["-version"], { timeout: 5_000 });
            ffprobePath = candidate;
            return ffprobePath;
        }
        catch {
            /* try the next candidate */
        }
    }
    ffprobePath = null;
    return ffprobePath;
}
/** Reports whether ffprobe can be executed at all. */
async function hasFfprobe() {
    return (await resolveFfprobe()) !== null;
}
async function tryFfprobe(abs) {
    const binary = await resolveFfprobe();
    if (!binary)
        return null;
    try {
        const { stdout } = await execFileAsync(binary, [
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            abs,
        ], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
        const data = JSON.parse(stdout);
        const streams = data.streams ?? [];
        const videoStreams = streams.filter((s) => s.codec_type === "video");
        const audio = streams.find((s) => s.codec_type === "audio");
        // An mp3 with cover art exposes the artwork as a video stream. It is
        // attached to the audio, not a picture the user can place on a timeline,
        // so it must not be mistaken for the media's real video track.
        const attached = new Set(streams
            .filter((s) => s.disposition?.attached_pic === 1)
            .map((s) => s.index));
        const realVideo = videoStreams.find((s) => !attached.has(s.index));
        // When every video stream is cover art, the file is an audio file — the
        // artwork belongs to the audio, it is not a placeable video.
        const video = realVideo;
        let durationUs = 0;
        // The duration of a material with a video stream is the video's
        // duration. Using the audio duration here would truncate a video whose
        // audio track is shorter than its picture — a common case for a
        // narrated still sequence. The audio duration is only the fallback when
        // the file has no video stream at all.
        const rawDur = video
            ? video.duration ?? data.format?.duration
            : audio?.duration ?? data.format?.duration;
        if (rawDur !== undefined && rawDur !== null) {
            const parsed = Number(rawDur);
            // A decoder may report an unknown duration as "N/A"; that becomes NaN
            // and would otherwise be written into the draft as null.
            if (Number.isFinite(parsed) && parsed > 0) {
                durationUs = Math.round(parsed * US);
            }
        }
        if (video) {
            // A still image exposes a video stream, but the duration it reports is
            // unreliable: some decoders report nothing, others report a single
            // frame's worth (0.04s at 25fps). The file extension is the reliable
            // signal, combined with a frame count of at most one.
            const ext = path.extname(abs).toLowerCase();
            const isImageExtension = IMAGE_EXTENSIONS.has(ext);
            // A decoder may report an unknown frame count as "N/A", which becomes
            // NaN and would make every comparison false.
            const parsedFrames = video.nb_frames !== undefined && video.nb_frames !== null
                ? Number(video.nb_frames)
                : NaN;
            const frameCount = Number.isFinite(parsedFrames) ? parsedFrames : undefined;
            // The length of one frame at the stream's frame rate. A duration
            // close to this means the decoder reported a single frame rather than
            // the clip's real length.
            const fps = parseFrameRate(video.r_frame_rate ?? video.avg_frame_rate);
            const singleFrameUs = fps > 0 ? Math.round(1_000_000 / fps) : 0;
            const looksLikeOneFrame = singleFrameUs > 0 &&
                durationUs > 0 &&
                durationUs <= singleFrameUs * 2;
            const isStill = isImageExtension &&
                (frameCount === undefined
                    ? durationUs <= 0 || looksLikeOneFrame
                    : frameCount <= 1);
            // A still image has no intrinsic length. When the decoder only
            // reported one frame, that value is replaced by the reference's
            // fallback — but a still that reports a real length (an animated
            // image) keeps it.
            const duration = isStill && looksLikeOneFrame
                ? STILL_IMAGE_DEFAULT_DURATION_US
                : durationUs > 0
                    ? durationUs
                    : STILL_IMAGE_DEFAULT_DURATION_US;
            return {
                duration,
                width: Number(video.width) || 1920,
                height: Number(video.height) || 1080,
                kind: "video",
                // A still image may be placed on the timeline for any length; only its
                // intrinsic duration is unknown.
                stillImage: isStill,
                // The material type follows the reference implementation, which
                // classifies an image as "photo" and gives it a 3 hour duration.
                materialType: isStill ? "photo" : "video",
                materialDuration: isStill ? STILL_IMAGE_MATERIAL_DURATION_US : duration,
            };
        }
        if (audio) {
            // A decoder that cannot report a duration must not leave the material
            // without one. The reference falls back to 10 seconds in the same
            // situation.
            return {
                duration: durationUs > 0 ? durationUs : STILL_IMAGE_DEFAULT_DURATION_US,
                width: 0,
                height: 0,
                kind: "audio",
            };
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
        // The macOS draft location moved between releases and differs between the
        // domestic (剪映) and international (CapCut) builds. Every known location
        // is listed, because picking the wrong one means the draft is written
        // where JianYing never looks.
        //
        // `com.lemon.jianyingpro` is the domestic macOS build; its drafts live
        // under Application Support without the extra JianyingPro level.
        candidates.push(path.join(home, "Movies", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"), path.join(home, "Movies", "JianyingPro Drafts"), path.join(home, "Library", "Containers", "com.lemon.jianyingpro", "Data", "Library", "Application Support", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"), path.join(home, "Library", "Containers", "com.lemon.jianyingpro", "Data", "Library", "Application Support", "JianyingPro Drafts"), path.join(home, "Library", "Containers", "com.lemon.lvpro", "Data", "Library", "Application Support", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"), path.join(home, "Library", "Containers", "com.bytedance.JianyingPro", "Data", "Library", "Application Support", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"));
    }
    else if (process.platform === "win32") {
        const appData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
        candidates.push(path.join(appData, "JianyingPro", "User Data", "Projects", "com.lveditor.draft"), path.join(appData, "CapCut", "User Data", "Projects", "com.lveditor.draft"), path.join(appData, "JianyingPro Drafts"));
    }
    else {
        candidates.push(path.join(home, "Movies", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"));
    }
    // Prefer a directory that already holds real drafts: that is the one
    // JianYing itself reads. Simply picking the first directory that exists
    // would lock onto an empty folder this tool created earlier.
    for (const c of candidates) {
        try {
            if (!fs.existsSync(c))
                continue;
            const entries = fs.readdirSync(c);
            const holdsDrafts = entries.some((n) => {
                try {
                    return (fs.statSync(path.join(c, n)).isDirectory() &&
                        fs.existsSync(path.join(c, n, "draft_info.json")));
                }
                catch {
                    return false;
                }
            });
            if (holdsDrafts)
                return c;
        }
        catch {
            /* unreadable candidate — try the next one */
        }
    }
    // Otherwise fall back to the first candidate that already exists.
    for (const c of candidates) {
        if (fs.existsSync(c))
            return c;
    }
    // None exist yet — return the canonical first candidate so callers can
    // create it.
    return candidates[0];
}
export class Draft {
    name;
    width;
    height;
    /** Frame rate, restored from the draft when one is loaded. */
    fps;
    root;
    dir;
    materialsDir;
    tracks = [];
    materials = new Map();
    materialOrder = [];
    /**
     * Media cache, keyed by `<kind>\0<absolute path>`.
     * A file used as both video and audio needs two entries.
     */
    stagedMedia = new Map();
    /**
     * Media index by the staged file name inside the draft, so a loaded
     * draft's media can be found by the path the caller knows it under.
     */
    stagedByMaterialId = new Map();
    /**
     * Material buckets this engine does not model, carried through from a
     * loaded draft so that saving does not strip them.
     */
    unmodelledBuckets = {};
    /**
     * The top-level keys of a loaded draft that this engine does not write.
     *
     * The reference implementation keeps the whole loaded document and only
     * overwrites the keys it models. Rebuilding the file from scratch would
     * drop a key a newer JianYing had added, so the unknown ones are carried
     * through.
     */
    loadedTopLevel = {};
    /** The `config` of a loaded draft, so its unknown keys survive too. */
    loadedConfig = {};
    /** Ids of the materials this engine created, as opposed to loaded ones. */
    createdMaterialIds = new Set();
    /**
     * Editing preferences read from a loaded draft and written back on save.
     * They are user settings, not content, so they must survive a round trip.
     */
    configFlags = {
        maintrackAdsorb: false,
        lyricsSync: false,
        subtitleSync: false,
    };
    /** In-flight registrations, so concurrent calls share one material. */
    pendingMedia = new Map();
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
        this.width = normalizeCanvasSize(options.width, 1920, "width");
        this.height = normalizeCanvasSize(options.height, 1080, "height");
        this.fps = normalizeFps(options.fps);
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
        if (options.load) {
            this.loadExisting();
            return;
        }
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
        // The directory is created when the draft is saved, not here: creating it
        // now would leave an empty folder in the user's real project list for
        // every draft that was opened and never edited.
    }
    /**
     * Reads an existing draft back into memory so it can be edited and saved.
     *
     * Only the parts this engine writes are restored: the tracks with their
     * segments, and the materials those segments reference. Anything else in
     * the file (effects, keyframes, stickers) is preserved on disk but not
     * modelled, and is therefore left untouched when the draft is saved.
     */
    loadExisting() {
        const infoPath = path.join(this.dir, "draft_info.json");
        if (!fs.existsSync(infoPath)) {
            throw new Error(`Cannot open "${this.name}": no draft_info.json in ${this.dir}. ` +
                `Use jianying_create_draft to make a new draft.`);
        }
        let info;
        try {
            info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Cannot open "${this.name}": ${this.dir}/draft_info.json is not valid JSON (${message}).`);
        }
        // The file has to be a draft, not merely something that parses.
        //
        // A draft_info.json holding an array, a string or null used to be read
        // as an empty draft: every property read returned undefined and the
        // loader carried on. Saving that draft would then overwrite the user's
        // file with an empty one — the original content gone, with no error
        // anywhere. Refuse before anything is read from it.
        if (info === null || typeof info !== "object" || Array.isArray(info)) {
            throw new Error(`Cannot open "${this.name}": ${this.dir}/draft_info.json does not hold a JianYing draft ` +
                `(it must be an object with a tracks array, not ${describeJsonValue(info)}).`);
        }
        if (!Array.isArray(info.tracks)) {
            throw new Error(`Cannot open "${this.name}": ${this.dir}/draft_info.json has no tracks array, ` +
                `so it is not a JianYing draft.`);
        }
        this.fps = typeof info.fps === "number" ? info.fps : this.fps;
        if (info.canvas_config) {
            this.canvasWidth = Number(info.canvas_config.width) || this.canvasWidth;
            this.canvasHeight = Number(info.canvas_config.height) || this.canvasHeight;
        }
        this.explicitResolution = true;
        this.resolutionResolved = true;
        // Keep what the loaded draft held, so the save can put back anything
        // this engine does not model.
        this.loadedTopLevel = { ...info };
        this.loadedConfig =
            info.config && typeof info.config === "object" && !Array.isArray(info.config)
                ? { ...info.config }
                : {};
        const config = info.config ?? {};
        this.configFlags = {
            maintrackAdsorb: Boolean(config.maintrack_adsorb),
            lyricsSync: Boolean(config.lyrics_sync),
            subtitleSync: Boolean(config.subtitle_sync),
        };
        // Restore the materials this engine understands, keyed by their id.
        const materials = info.materials ?? {};
        const buckets = [
            ["video", "videos"],
            ["photo", "images"],
            ["audio", "audios"],
            ["text", "texts"],
            ["speed", "speeds"],
            ["audio_fade", "audio_fades"],
        ];
        for (const [kind, bucket] of buckets) {
            for (const material of materials[bucket] ?? []) {
                if (!material || typeof material.id !== "string")
                    continue;
                // A loaded material was not created here, so it is never swept, and
                // it keeps the bucket it was found in.
                this.addMaterial({ id: material.id, kind, data: material, loadedBucket: bucket }, false);
                // A media material that was staged in this draft is registered under
                // its staged path, so it can be found again by the original file.
                if (kind === "video" || kind === "photo" || kind === "audio") {
                    const stagedPath = String(material.path ?? "");
                    if (stagedPath) {
                        const stagedName = path.basename(stagedPath);
                        // The cache is keyed by the *source* path, the same key the add
                        // path uses. Registering it under the staged path instead would
                        // mean remove_media could never find it after a load.
                        this.stagedMedia.set(`${kind}\u0000${stagedPath}`, {
                            materialId: material.id,
                            stagedName,
                        });
                        // The staged file is named after the md5 of the source path, so
                        // it can be looked up from the source path the caller gives.
                        this.stagedByMaterialId.set(stagedName, {
                            materialId: material.id,
                            kind,
                            stagedPath,
                        });
                    }
                }
            }
        }
        // Everything this engine does not model is carried through untouched, the
        // way the reference implementation carries its imported materials. The
        // buckets below hold effects, stickers, transitions, canvases, masks,
        // keyframes and anything else a real draft may contain; dropping them on
        // save would silently strip the user's work.
        this.unmodelledBuckets = {};
        for (const [bucket, items] of Object.entries(materials)) {
            if (buckets.some(([, b]) => b === bucket))
                continue;
            // A bucket that is not a list is malformed, but it is still the
            // user's data. It is carried through as it is; dropping it would
            // strip it from the draft on the next save.
            this.unmodelledBuckets[bucket] = items;
        }
        // Restore the tracks with their segments.
        const perTypeCounter = {};
        for (const track of info.tracks ?? []) {
            const type = track.type;
            if (type !== "video" && type !== "audio" && type !== "text")
                continue;
            const renderIndex = Number(track.segments?.[0]?.render_index ?? 0);
            const base = TRACK_BASE_RENDER_INDEX[type];
            const relative = Math.max(0, Math.trunc(renderIndex - base));
            // Two tracks of the same type may share a render index; fall back to a
            // counter so each keeps its own identity.
            const key = `${type}:${relative}`;
            const index = perTypeCounter[key] ?? relative;
            perTypeCounter[key] = index + 1;
            const state = {
                id: String(track.id ?? randomUUID().replace(/-/g, "")),
                type,
                index,
                segments: [],
                renderIndex,
                name: String(track.name ?? DEFAULT_TRACK_NAMES[type]),
            };
            for (const raw of track.segments ?? []) {
                const materialId = String(raw.material_id ?? "");
                const material = this.materials.get(materialId);
                if (!material)
                    continue;
                const speedId = (raw.extra_material_refs ?? []).find((ref) => this.materials.get(ref)?.data?.type === "speed");
                const segment = {
                    id: String(raw.id ?? randomUUID().replace(/-/g, "")),
                    materialId,
                    targetTimerange: {
                        start: Number(raw.target_timerange?.start ?? 0),
                        duration: Number(raw.target_timerange?.duration ?? 0),
                    },
                    sourceTimerange: raw.source_timerange
                        ? {
                            start: Number(raw.source_timerange.start ?? 0),
                            duration: Number(raw.source_timerange.duration ?? 0),
                        }
                        : null,
                    speed: Number(raw.speed ?? 1),
                    volume: Number(raw.volume ?? 1),
                    // Every reference is carried through, not just the fades: a
                    // segment may point at a transition, an effect or a sticker
                    // material this engine does not model, and dropping those
                    // references would break the draft.
                    extraMaterialRefs: [...(raw.extra_material_refs ?? [])].filter((ref) => typeof ref === "string"),
                    clip: raw.clip
                        ? {
                            transform: {
                                x: Number(raw.clip.transform?.x ?? 0),
                                y: Number(raw.clip.transform?.y ?? 0),
                            },
                            scale: {
                                x: Number(raw.clip.scale?.x ?? 1),
                                y: Number(raw.clip.scale?.y ?? 1),
                            },
                            rotation: Number(raw.clip.rotation ?? 0),
                            alpha: Number(raw.clip.alpha ?? 1),
                            flip: {
                                horizontal: Boolean(raw.clip.flip?.horizontal),
                                vertical: Boolean(raw.clip.flip?.vertical),
                            },
                        }
                        : undefined,
                    speedId,
                };
                state.segments.push(segment);
            }
            this.tracks.push(state);
        }
        this.tracks.sort((a, b) => a.renderIndex - b.renderIndex);
    }
    // -- track helpers ------------------------------------------------------
    /**
     * Returns the track for the given type and relative index, creating it if
     * needed.
     *
     * `relativeIndex` is the track's position among tracks of the same type.
     * In the JianYing schema the track's `attribute` field is the mute flag
     * (always 0 here) and the stacking order is carried by `render_index`,
     * which is the type's base index plus this relative index. Two tracks of
     * the same type must therefore get different render indices, otherwise
     * JianYing cannot tell them apart.
     */
    ensureTrack(type, relativeIndex) {
        // A malformed index must not produce a NaN render index, which would be
        // written into the draft as null. A numeric string is accepted, because
        // the index may arrive from a loosely typed client.
        const numeric = typeof relativeIndex === "number" ? relativeIndex : Number(relativeIndex);
        const index = Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
        let track = this.tracks.find((t) => t.type === type && t.index === index);
        if (!track) {
            track = {
                id: randomUUID().replace(/-/g, ""),
                type,
                index,
                segments: [],
                renderIndex: TRACK_BASE_RENDER_INDEX[type] + index,
                name: index === 0
                    ? DEFAULT_TRACK_NAMES[type]
                    : `${DEFAULT_TRACK_NAMES[type]}_${index}`,
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
        // The cache is keyed by path *and* kind. A file that is used both as a
        // video and as an audio material needs two distinct material entries —
        // sharing one would put an audio material on a video track.
        const cacheKey = `${kind}\u0000${abs}`;
        // An in-flight registration is reused, so two concurrent calls for the
        // same file do not create duplicate materials.
        const inFlight = this.pendingMedia.get(cacheKey);
        if (inFlight)
            return inFlight;
        const registration = this.registerMediaInternal(abs, kind, cacheKey);
        this.pendingMedia.set(cacheKey, registration);
        try {
            return await registration;
        }
        finally {
            this.pendingMedia.delete(cacheKey);
        }
    }
    async registerMediaInternal(abs, kind, cacheKey) {
        const probe = await probeMedia(abs);
        const existing = this.stagedMedia.get(cacheKey);
        if (existing) {
            return {
                materialId: existing.materialId,
                probe,
                stagedPath: path.join(this.materialsDir, existing.stagedName),
            };
        }
        const md5 = createHash("md5").update(abs).digest("hex");
        const ext = path.extname(abs) || (kind === "audio" ? ".mp3" : ".mp4");
        const stagedName = `${md5}${ext}`;
        // A loaded draft knows its media by the staged copy, whose name is the
        // md5 of the source path. Looking that name up finds the material the
        // draft already has, so adding the same file again reuses it instead of
        // creating a duplicate.
        const known = this.stagedByMaterialId.get(stagedName);
        if (known) {
            this.stagedMedia.set(cacheKey, {
                materialId: known.materialId,
                stagedName,
            });
            return {
                materialId: known.materialId,
                probe,
                stagedPath: path.join(this.materialsDir, stagedName),
            };
        }
        const stagedPath = path.join(this.materialsDir, stagedName);
        fs.mkdirSync(this.materialsDir, { recursive: true });
        fs.copyFileSync(abs, stagedPath);
        const materialId = randomUUID().replace(/-/g, "");
        this.stagedMedia.set(cacheKey, { materialId, stagedName });
        this.stagedByMaterialId.set(stagedName, {
            materialId,
            kind,
            stagedPath,
        });
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
            const materialType = probe.materialType ?? "video";
            this.addMaterial({
                id: materialId,
                kind: materialType === "photo" ? "photo" : "video",
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
                    // The material duration follows the reference implementation: a
                    // still image gets 3 hours, so a clip of any length still fits
                    // inside the material.
                    duration: probe.materialDuration ?? probe.duration,
                    height: probe.height,
                    id: materialId,
                    local_material_id: stagedName.replace(/\.[^.]+$/, ""),
                    material_id: materialId,
                    material_name: stagedName,
                    media_path: "",
                    path: stagedPath,
                    type: materialType,
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
    addMaterial(entry, created = true) {
        this.materials.set(entry.id, entry);
        this.materialOrder.push(entry);
        // Only materials this engine created may be swept as orphans later.
        if (created)
            this.createdMaterialIds.add(entry.id);
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
        const abs = path.resolve(spec.filePath);
        if (!fs.existsSync(abs))
            throw new Error(`Media file not found: ${abs}`);
        // Probe before anything is written, so a rejected call leaves no staged
        // copy and no orphaned material behind.
        const probe = await probeMedia(abs);
        if (probe.kind === "audio") {
            throw new Error(`Video material must not be an audio-only file: ${abs}`);
        }
        const track = this.ensureTrack("video", spec.track ?? 0);
        // First video defines the canvas when the caller did not choose one.
        if (!this.explicitResolution && !this.resolutionResolved) {
            if (probe.width > 0 && probe.height > 0) {
                this.canvasWidth = probe.width;
                this.canvasHeight = probe.height;
            }
            this.resolutionResolved = true;
        }
        const startUs = Math.round(parseDuration(spec.start, 0, "start time") * US);
        const sourceStartUs = Math.round(parseDuration(spec.sourceStart, 0, "source start") * US);
        // Speed semantics follow the upstream VideoSegment constructor:
        //
        //   `duration` given:
        //       the timeline slot is `duration`, and `duration x speed` is
        //       consumed from the source.
        //   `duration` omitted:
        //       the rest of the material is consumed from the source offset, and
        //       the timeline slot is that length divided by the speed.
        //
        // The invariant `source = target x speed` always holds.
        const requestedTargetUs = Math.round(parseDuration(spec.duration, undefined, "duration") * US || 0);
        const requestedSpeed = spec.speed ?? 1;
        if (!Number.isFinite(requestedSpeed) || requestedSpeed <= 0) {
            throw new Error(`Invalid speed: ${spec.speed} must be greater than zero.`);
        }
        let sourceUs;
        let targetUs;
        let effectiveSpeed;
        // The usable length of the material. A still image's material is 3 hours
        // long, so it can be placed for any length; a video is bounded by its
        // own duration.
        const materialLengthUs = probe.materialDuration ?? probe.duration;
        if (requestedTargetUs > 0) {
            targetUs = requestedTargetUs;
            effectiveSpeed = requestedSpeed;
            sourceUs = Math.round(targetUs * effectiveSpeed);
        }
        else {
            // No explicit length: consume the rest of the material from the offset.
            sourceUs = Math.max(0, materialLengthUs - sourceStartUs);
            effectiveSpeed = requestedSpeed;
            targetUs = Math.round(sourceUs / effectiveSpeed);
        }
        if (sourceStartUs + sourceUs > materialLengthUs + 1000) {
            throw new Error(`Requested range ${sourceStartUs / US}s..${(sourceStartUs + sourceUs) / US}s exceeds media duration ${materialLengthUs / US}s`);
        }
        const targetRange = { start: startUs, duration: targetUs };
        this.assertNoOverlap(track, targetRange, "video clip");
        // Everything validated — now stage the file and register the material.
        const { materialId } = await this.registerMedia(spec.filePath, "video");
        const seg = {
            id: randomUUID().replace(/-/g, ""),
            materialId,
            targetTimerange: targetRange,
            sourceTimerange: { start: sourceStartUs, duration: sourceUs },
            speed: effectiveSpeed,
            volume: normalizeVolume(spec.volume),
            extraMaterialRefs: [],
            clip: defaultClipSettings(),
            speedId: this.registerSpeed(effectiveSpeed),
        };
        track.segments.push(seg);
        return seg;
    }
    /** Adds an audio clip (BGM, voiceover, SFX) to an audio track. */
    async addAudio(spec) {
        const abs = path.resolve(spec.filePath);
        if (!fs.existsSync(abs))
            throw new Error(`Media file not found: ${abs}`);
        // Probe and validate before anything is written.
        const probe = await probeMedia(abs);
        // The upstream implementation refuses to treat a file with a video track
        // as an audio material; doing so produces a draft JianYing cannot read.
        if (probe.kind === "video") {
            throw new Error(`Audio material must not contain a video track: ${abs}`);
        }
        const track = this.ensureTrack("audio", spec.track ?? 0);
        const startUs = Math.round(parseDuration(spec.start, 0, "start time") * US);
        const sourceStartUs = Math.round(parseDuration(spec.sourceStart, 0, "source start") * US);
        const remaining = Math.max(0, probe.duration - sourceStartUs);
        const durationUs = Math.round(parseDuration(spec.duration, undefined, "duration") * US) ||
            remaining;
        // The fades are validated here, before anything is written, so a bad
        // fade cannot leave a staged file and an orphaned material behind.
        const fadeInUs = Math.round(parseDuration(spec.fadeIn, 0, "fade in") * US);
        const fadeOutUs = Math.round(parseDuration(spec.fadeOut, 0, "fade out") * US);
        if (durationUs <= 0) {
            throw new Error(`Invalid duration: the audio material is empty (${probe.duration / US}s).`);
        }
        if (sourceStartUs + durationUs > probe.duration + 1000) {
            throw new Error(`Requested range ${sourceStartUs / US}s..${(sourceStartUs + durationUs) / US}s exceeds media duration ${probe.duration / US}s`);
        }
        const targetRange = { start: startUs, duration: durationUs };
        this.assertNoOverlap(track, targetRange, "audio clip");
        // Everything validated — now stage the file and register the material.
        const { materialId } = await this.registerMedia(spec.filePath, "audio");
        const seg = {
            id: randomUUID().replace(/-/g, ""),
            materialId,
            targetTimerange: targetRange,
            sourceTimerange: { start: sourceStartUs, duration: durationUs },
            speed: 1,
            volume: normalizeVolume(spec.volume),
            extraMaterialRefs: [],
            speedId: this.registerSpeed(1),
        };
        if (fadeInUs > 0 || fadeOutUs > 0) {
            const fadeId = randomUUID().replace(/-/g, "");
            this.addMaterial({
                id: fadeId,
                kind: "audio_fade",
                data: {
                    id: fadeId,
                    fade_in_duration: fadeInUs,
                    fade_out_duration: fadeOutUs,
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
     * Adds a text segment to a text track.
     *
     * `subtitle` switches to the caption defaults (smaller size, black
     * outline, placed low on the canvas). Plain text uses the upstream
     * TextSegment defaults instead.
     *
     * `track` selects the text track. Track 0 is the caption track; use track 1
     * for titles or overlays so they can coexist with the captions.
     */
    addText(spec) {
        const track = this.ensureTrack("text", spec.track ?? 0);
        const startUs = Math.round(parseDuration(spec.start, 0, "start time") * US);
        const durationUs = Math.round(parseDuration(spec.duration, 0, "duration") * US);
        if (durationUs <= 0) {
            throw new Error(`Invalid duration: ${spec.duration} must be greater than zero.`);
        }
        // Validate before registering anything, so a rejected call leaves no
        // orphaned material behind.
        const targetRange = { start: startUs, duration: durationUs };
        this.assertNoOverlap(track, targetRange, "text segment");
        const materialId = randomUUID().replace(/-/g, "");
        const base = spec.subtitle ? SUBTITLE_DEFAULT_STYLE : TEXT_DEFAULT_STYLE;
        const style = normalizeStyle(spec.style, base);
        const chars = [...spec.text];
        // Build per-run styles; upstream emits one style span covering the text.
        const hasStroke = style.stroke.width > 0;
        const content = {
            styles: [
                {
                    // The reference implementation writes a fixed alpha of 1.0 here and
                    // carries the actual opacity in global_alpha. Applying the alpha in
                    // both places would square it.
                    fill: {
                        alpha: 1.0,
                        content: {
                            render_type: "solid",
                            solid: { alpha: 1.0, color: style.color },
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
     *
     * The whole set is validated before anything is written, so a script that
     * does not fit leaves the draft untouched.
     */
    addSubtitles(script, start, duration, opts = {}) {
        const lines = splitSubtitleLines(script, opts.maxChars ?? 18);
        if (!lines.length)
            return [];
        const totalUs = Math.round(parseDuration(duration, 0, "duration") * US);
        const startUs = Math.round(parseDuration(start, 0, "start time") * US);
        const perLine = Math.floor(totalUs / lines.length);
        if (perLine <= 0) {
            throw new Error(`Invalid duration: ${totalUs / US}s cannot hold ${lines.length} subtitle lines.`);
        }
        // Validate every line against the track before adding any of them.
        const track = this.ensureTrack("text", opts.track ?? 0);
        const planned = [];
        for (let i = 0; i < lines.length; i++) {
            const range = {
                start: startUs + i * perLine,
                duration: perLine,
            };
            for (const existing of track.segments) {
                if (timerangesOverlap(existing.targetTimerange, range)) {
                    throw new Error(`SegmentOverlap: subtitle line ${i + 1} [start: ${range.start}, end: ${range.start + range.duration}] ` +
                        `overlaps an existing segment on track text/${track.index} ` +
                        `[start: ${existing.targetTimerange.start}, end: ${existing.targetTimerange.start + existing.targetTimerange.duration}]`);
                }
            }
            for (const other of planned) {
                if (timerangesOverlap(other, range)) {
                    throw new Error(`SegmentOverlap: subtitle lines overlap each other near ${range.start / US}s.`);
                }
            }
            planned.push(range);
        }
        return lines.map((line, i) => this.addText({
            text: line,
            start: planned[i].start / US,
            duration: planned[i].duration / US,
            style: opts.style,
            subtitle: true,
            track: opts.track ?? 0,
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
        // The file may have been registered as a video, as an audio, or as both.
        let entries = [
            this.stagedMedia.get(`video\u0000${abs}`),
            this.stagedMedia.get(`photo\u0000${abs}`),
            this.stagedMedia.get(`audio\u0000${abs}`),
        ].filter((e) => !!e);
        // A loaded draft knows its media by the staged copy inside the draft.
        // The staged file is named after the md5 of the *source* path, so the
        // staged name can be computed from the path the caller gives — no
        // guessing by file name, which could match an unrelated file.
        if (!entries.length) {
            const md5 = createHash("md5").update(abs).digest("hex");
            const ext = path.extname(abs);
            for (const kind of ["video", "photo", "audio"]) {
                const cached = this.stagedMedia.get(`${kind}\u0000${abs}`);
                if (cached)
                    continue;
                const stagedName = `${md5}${ext}`;
                const match = this.stagedByMaterialId.get(stagedName);
                if (match) {
                    entries.push({ materialId: match.materialId, stagedName });
                }
            }
        }
        if (!entries.length) {
            // Nothing matched. Returning without touching anything is essential:
            // a cleanup sweep here would delete media the draft legitimately holds
            // but no segment references — the media bin a real project keeps.
            return 0;
        }
        const materialIds = new Set(entries.map((e) => e.materialId));
        let removed = 0;
        const removedSpeedIds = new Set();
        const removedFadeIds = new Set();
        for (const track of this.tracks) {
            const keep = [];
            for (const seg of track.segments) {
                if (!materialIds.has(seg.materialId)) {
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
        // Drop the media materials that no segment references any more.
        for (const entry of entries) {
            const stillReferenced = this.tracks.some((t) => t.segments.some((s) => s.materialId === entry.materialId));
            if (stillReferenced)
                continue;
            this.materials.delete(entry.materialId);
            this.materialOrder = this.materialOrder.filter((m) => m.id !== entry.materialId);
            for (const key of [...this.stagedMedia.keys()]) {
                if (this.stagedMedia.get(key)?.materialId === entry.materialId) {
                    this.stagedMedia.delete(key);
                }
            }
            // Remove the staged copy from disk.
            const stagedPath = path.join(this.materialsDir, entry.stagedName);
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
        this.removeOrphanMaterials();
        return removed;
    }
    /**
     * Drops materials that no segment references.
     *
     * A rejected add can leave a material behind — for example a video whose
     * staged copy was made before the overlap check failed. Such a material
     * is unreachable through the timeline, so it is removed here.
     *
     * Only materials this engine created are eligible. A material that came
     * from a loaded draft is left alone even when no segment references it:
     * a real project keeps a media bin of clips that are not on the timeline
     * yet, and deleting those would destroy the user's work.
     */
    removeOrphanMaterials() {
        const used = new Set();
        for (const track of this.tracks) {
            for (const seg of track.segments) {
                used.add(seg.materialId);
                if (seg.speedId)
                    used.add(seg.speedId);
                for (const ref of seg.extraMaterialRefs)
                    used.add(ref);
            }
        }
        const orphans = this.materialOrder.filter((m) => !used.has(m.id) && this.createdMaterialIds.has(m.id));
        if (!orphans.length)
            return;
        // A staged file is shared when two materials point at the same path —
        // the same file registered as both a video and an audio material. It may
        // only be deleted when no surviving material still points at it.
        const survivingPaths = new Set(this.materialOrder
            .filter((m) => used.has(m.id))
            .map((m) => String(m.data.path ?? ""))
            .filter(Boolean));
        for (const orphan of orphans) {
            this.materials.delete(orphan.id);
            // A staged media file that no segment uses is deleted from disk too —
            // unless a surviving material still references the same file.
            if (orphan.kind === "video" ||
                orphan.kind === "photo" ||
                orphan.kind === "audio") {
                const stagedPath = String(orphan.data.path ?? "");
                if (stagedPath &&
                    stagedPath.startsWith(this.materialsDir) &&
                    !survivingPaths.has(stagedPath)) {
                    try {
                        fs.rmSync(stagedPath, { force: true });
                    }
                    catch {
                        /* already gone */
                    }
                }
            }
        }
        this.materialOrder = this.materialOrder.filter((m) => used.has(m.id));
        // Drop cache entries whose material no longer exists.
        for (const [key, entry] of [...this.stagedMedia.entries()]) {
            if (!this.materials.has(entry.materialId)) {
                this.stagedMedia.delete(key);
            }
        }
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
        // Resolve the caption text so the summary can actually be proofread —
        // an acceptance check that cannot see the words is not a check.
        const textOf = (materialId) => {
            const mat = this.materials.get(materialId);
            if (!mat || mat.kind !== "text")
                return null;
            try {
                const content = JSON.parse(String(mat.data.content));
                return typeof content.text === "string" ? content.text : null;
            }
            catch {
                return null;
            }
        };
        const materialName = (materialId) => {
            const mat = this.materials.get(materialId);
            if (!mat)
                return null;
            const name = mat.data.name ?? mat.data.material_name;
            return typeof name === "string" ? name : null;
        };
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
                    // The caption text and the source media name, so the result can be
                    // checked without opening the draft file.
                    text: textOf(s.materialId),
                    media: materialName(s.materialId),
                })),
            })),
            materialCount: this.materialOrder.length,
            materials: this.materialOrder.map((m) => ({
                id: m.id,
                kind: m.kind,
                name: m.data.name ?? m.data.material_name,
                path: m.data.path ?? null,
            })),
        };
    }
    // -- serialization ------------------------------------------------------
    /** Builds the full draft_info.json payload. */
    buildDraftInfo() {
        const now = Date.now();
        const template = localJianyingTemplate();
        const materials = {};
        for (const key of localMaterialBuckets(template))
            materials[key] = [];
        // Material buckets this engine does not model are written back exactly
        // as they were loaded. The reference implementation does the same with
        // its imported materials, and dropping them would strip the effects,
        // stickers, transitions, masks and keyframes of a real project.
        for (const [bucket, items] of Object.entries(this.unmodelledBuckets)) {
            if (Array.isArray(items)) {
                const existing = Array.isArray(materials[bucket]) ? materials[bucket] : [];
                materials[bucket] = [...existing, ...items];
            }
            else {
                // A bucket whose value is not a list is malformed, but it is still
                // the user's data. It replaces the empty placeholder rather than
                // being dropped on the floor.
                materials[bucket] = items;
            }
        }
        for (const entry of this.materialOrder) {
            // A photo created here goes into the `videos` bucket, which is where
            // the reference implementation puts every video material — its
            // `images` bucket is always empty for a fresh draft. A photo that came
            // from a loaded draft keeps the bucket it was in, because re-bucketing
            // it would change the user's file.
            const bucket = entry.kind === "speed"
                ? "speeds"
                : entry.kind === "audio_fade"
                    ? "audio_fades"
                    : entry.kind === "photo"
                        ? entry.loadedBucket === "images"
                            ? "images"
                            : "videos"
                        : entry.kind === "video"
                            ? "videos"
                            : entry.kind === "audio"
                                ? "audios"
                                : "texts";
            materials[bucket].push(entry.data);
        }
        // A track with no segments carries no information — it can be left over
        // from a rejected add — so it is not written to the draft.
        const tracks = this.tracks
            .filter((t) => t.segments.length > 0)
            .map((t) => ({
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
        const built = {
            // The installed application's own template provides the keys this
            // engine does not write, and the version string it version-checks.
            ...localTemplateExtras(template),
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
                ...this.loadedConfig,
                adjust_max_index: 1,
                attachment_info: [],
                combination_max_index: 1,
                export_range: null,
                extract_audio_last_index: 1,
                lyrics_recognition_id: "",
                lyrics_sync: this.configFlags.lyricsSync,
                lyrics_taskinfo: [],
                maintrack_adsorb: this.configFlags.maintrackAdsorb,
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
                subtitle_sync: this.configFlags.subtitleSync,
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
            // The application refuses a draft whose version it does not know, and
            // the reference template claims a version newer than 11.6 writes. The
            // installed template says which version that is.
            new_version: template?.new_version ?? "110.0.0",
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
        // Everything the loaded draft held that this engine does not model is
        // carried through.
        //
        // The reference implementation overwrites exactly six keys when it
        // saves: fps, duration, config.maintrack_adsorb, canvas_config,
        // materials and tracks. Every other key keeps the value the draft was
        // loaded with — including the project id, which would otherwise change
        // on every save and make JianYing treat the draft as a different
        // project.
        for (const [key, value] of Object.entries(this.loadedTopLevel)) {
            if (!MODELLED_TOP_LEVEL.has(key))
                built[key] = value;
        }
        return built;
    }
    serializeSegment(track, seg) {
        // Every segment references its Speed material through extra_material_refs.
        // A loaded segment may already carry that reference, so the list is
        // de-duplicated rather than appended to.
        const extraRefs = [...new Set([...seg.extraMaterialRefs, ...(seg.speedId ? [seg.speedId] : [])])];
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
        fs.mkdirSync(this.dir, { recursive: true });
        // The save is done in two phases. Every file is written to a temporary
        // name first; only when all of them are on disk are they renamed into
        // place. A failure therefore leaves the previous draft exactly as it
        // was, rather than a mix of old and new files.
        const pending = [];
        const staged = (name, content) => {
            const final = path.join(this.dir, name);
            const tmp = path.join(this.dir, `.${name}.tmp-${process.pid}`);
            fs.writeFileSync(tmp, content, "utf8");
            pending.push({ tmp, final });
        };
        try {
            staged("draft_info.json", JSON.stringify(this.buildDraftInfo(), null, 4));
            staged("draft_meta_info.json", JSON.stringify(buildMetaInfo(this.name), null, 4));
            staged("draft_settings", [
                "[General]",
                // The application writes the real time here, in seconds since the
                // epoch. The reference template leaves both at zero.
                `draft_create_time=${Math.floor(Date.now() / 1000)}`,
                `draft_last_edit_time=${Math.floor(Date.now() / 1000)}`,
                "real_edit_keys=1",
                "real_edit_seconds=0",
                "",
            ].join("\n"));
            staged("key_value.json", "{}");
        }
        catch (error) {
            for (const { tmp } of pending) {
                try {
                    fs.rmSync(tmp, { force: true });
                }
                catch {
                    /* the temporary file may already be gone */
                }
            }
            throw error;
        }
        // All files are written. Move them into place. A rename replaces the
        // target atomically, so a file is never seen half-written; and the
        // previous version is kept aside so a failure part-way through can be
        // undone.
        //
        // The backup is a *copy*, not a move: moving the target aside would
        // make an occupied target (a directory, say) look free, and the save
        // would silently succeed where it should have failed.
        const backups = [];
        try {
            for (const { tmp, final } of pending) {
                const backup = fs.existsSync(final)
                    ? path.join(this.dir, `.${path.basename(final)}.bak-${process.pid}`)
                    : null;
                if (backup) {
                    try {
                        fs.copyFileSync(final, backup);
                    }
                    catch {
                        // The target may be a directory, which cannot be copied. The
                        // rename below will fail on it, which is the correct outcome.
                    }
                }
                backups.push({ final, backup });
                fs.renameSync(tmp, final);
                written.push(final);
            }
        }
        catch (error) {
            // Put the draft back the way it was.
            for (const { final, backup } of backups.reverse()) {
                try {
                    if (backup && fs.existsSync(backup)) {
                        fs.rmSync(final, { force: true, recursive: true });
                        fs.renameSync(backup, final);
                    }
                }
                catch {
                    /* best effort */
                }
            }
            for (const { tmp } of pending) {
                try {
                    fs.rmSync(tmp, { force: true, recursive: true });
                }
                catch {
                    /* the temporary file may already be gone */
                }
            }
            throw error;
        }
        for (const { backup } of backups) {
            if (backup) {
                try {
                    // A backup can be a directory when the target path was one, so the
                    // removal has to be recursive.
                    fs.rmSync(backup, { force: true, recursive: true });
                }
                catch {
                    /* best effort */
                }
            }
        }
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
 * Validates a canvas dimension.
 *
 * The value is written straight into `canvas_config`. A string or a
 * non-positive number there produces a draft JianYing cannot read as
 * specified, so it is refused rather than written out. A numeric string is
 * accepted, because a loosely typed client may send one.
 */
function normalizeCanvasSize(value, fallback, label) {
    if (value === undefined || value === null)
        return fallback;
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
        throw new Error(`Invalid ${label}: ${value} must be a number.`);
    }
    const rounded = Math.trunc(numeric);
    if (rounded <= 0) {
        throw new Error(`Invalid ${label}: ${value} must be greater than zero.`);
    }
    return rounded;
}
/** Validates a frame rate the same way. */
function normalizeFps(value) {
    if (value === undefined || value === null)
        return 30;
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
        throw new Error(`Invalid fps: ${value} must be a number.`);
    }
    const rounded = Math.trunc(numeric);
    if (rounded <= 0) {
        throw new Error(`Invalid fps: ${value} must be greater than zero.`);
    }
    return rounded;
}
/**
 * Validates a volume value.
 *
 * The volume is written straight into the draft, so a value outside 0..1
 * would make JianYing render the clip unpredictably.
 */
function normalizeVolume(volume) {
    if (volume === undefined)
        return 1.0;
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
        throw new Error(`Invalid volume: ${volume} must be between 0 and 1.`);
    }
    return volume;
}
/**
 * Merges a partial style over a base style.
 *
 * The values are validated, because they are written straight into the draft:
 * a colour with the wrong number of components, an alpha outside 0..1 or a
 * negative size would make JianYing render the text unpredictably.
 */
function normalizeStyle(partial, base) {
    const stroke = partial?.stroke;
    const size = partial?.size ?? base.size;
    if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`Invalid font size: ${size} must be greater than zero.`);
    }
    const alpha = partial?.alpha ?? base.alpha;
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
        throw new Error(`Invalid alpha: ${alpha} must be between 0 and 1.`);
    }
    const color = partial?.color ?? base.color;
    if (!Array.isArray(color) || color.length !== 3) {
        throw new Error(`Invalid colour: expected 3 components (RGB), got ${Array.isArray(color) ? color.length : typeof color}.`);
    }
    for (const channel of color) {
        if (!Number.isFinite(channel) || channel < 0 || channel > 1) {
            throw new Error(`Invalid colour component: ${channel} must be between 0 and 1.`);
        }
    }
    const align = partial?.align ?? base.align;
    if (align !== 0 && align !== 1 && align !== 2) {
        throw new Error(`Invalid align: ${align} must be 0, 1 or 2.`);
    }
    let strokeColor = stroke?.color ?? base.stroke.color;
    let strokeWidth = stroke?.width ?? base.stroke.width;
    if (strokeWidth < 0 || !Number.isFinite(strokeWidth)) {
        throw new Error(`Invalid stroke width: ${strokeWidth} must not be negative.`);
    }
    if (!Array.isArray(strokeColor) || strokeColor.length !== 3) {
        throw new Error(`Invalid stroke colour: expected 3 components (RGB), got ${Array.isArray(strokeColor) ? strokeColor.length : typeof strokeColor}.`);
    }
    return {
        size,
        bold: partial?.bold ?? base.bold,
        italic: partial?.italic ?? base.italic,
        underline: partial?.underline ?? base.underline,
        color: color,
        alpha,
        align,
        stroke: {
            color: strokeColor,
            width: strokeWidth,
        },
    };
}
/**
 * The top-level keys this engine models, and therefore writes itself.
 *
 * The reference implementation overwrites exactly these when it saves:
 * `fps`, `duration`, `config.maintrack_adsorb`, `canvas_config`,
 * `materials` and `tracks`. Every other key of a loaded draft keeps the
 * value it was loaded with.
 */
const MODELLED_TOP_LEVEL = new Set([
    "canvas_config",
    "config",
    "duration",
    "fps",
    "materials",
    "tracks",
]);
/**
 * Whether a draft should follow the installed JianYing's own format.
 *
 * `JY_DRAFT_FORMAT=upstream` pins the draft to the reference
 * implementation's format, which is what the differential comparison needs:
 * it has to compare two drafts produced the same way. The default follows
 * the installed application, because a draft that does not match the
 * version that is going to open it may be refused.
 */
function followsLocalFormat() {
    return (process.env.JY_DRAFT_FORMAT ?? "auto").toLowerCase() !== "upstream";
}
/**
 * The blank template the installed JianYing writes for itself.
 *
 * Every draft the application creates carries `template.tmp` — the plain
 * JSON template of the format that version expects. It is the authoritative
 * description of the installed version's format: 11.6 has 56 material
 * buckets where 5.9 had 45, and `masks` was renamed `common_mask`. Reading
 * the template is far more reliable than mapping an app version to a draft
 * version by hand.
 */
let localTemplateCache;
function localJianyingTemplate() {
    if (!followsLocalFormat())
        return null;
    if (localTemplateCache !== undefined)
        return localTemplateCache;
    localTemplateCache = null;
    try {
        const root = resolveDraftsRoot();
        for (const name of fs.readdirSync(root)) {
            const candidate = path.join(root, name, "template.tmp");
            try {
                const data = JSON.parse(fs.readFileSync(candidate, "utf8"));
                if (data &&
                    typeof data === "object" &&
                    !Array.isArray(data) &&
                    Array.isArray(data.tracks)) {
                    localTemplateCache = data;
                    break;
                }
            }
            catch {
                /* not a template */
            }
        }
    }
    catch {
        /* no drafts root yet */
    }
    return localTemplateCache;
}
/**
 * The top-level keys of the local template that this engine does not write.
 *
 * The template carries the defaults for keys a newer JianYing added, and
 * they are part of what that version expects to find.
 */
function localTemplateExtras(template) {
    const extras = {};
    for (const [key, value] of Object.entries(template ?? {})) {
        if (key === "tracks" || key === "materials" || key === "canvas_config" || key === "config") {
            continue;
        }
        extras[key] = value;
    }
    return extras;
}
/**
 * The material buckets the installed version expects.
 */
function localMaterialBuckets(template) {
    const buckets = template?.materials;
    if (buckets && typeof buckets === "object" && !Array.isArray(buckets)) {
        const keys = Object.keys(buckets);
        if (keys.length > 0)
            return keys;
    }
    return EMPTY_MATERIAL_KEYS;
}
/**
 * Names a JSON value for an error message.
 */
function describeJsonValue(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "an array";
    return `a ${typeof value}`;
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
/**
 * Sanitises a draft name into something safe to use as a directory name.
 *
 * Illegal characters become underscores, leading and trailing dots are
 * stripped, and Windows device names are rejected.
 */
export function sanitizeDraftName(name) {
    // The order matters: strip trailing dots *before* trimming whitespace, so
    // that "a ." collapses to "a" and not to "a ". The result is sanitised
    // again to make the function idempotent — the name a draft is registered
    // under must be the same name the caller can address it with.
    let cleaned = String(name)
        .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
        .replace(/^\.+/, "")
        .replace(/\.+$/, "")
        .trim()
        .replace(/\s+/g, " ");
    if (cleaned !== name) {
        const second = String(cleaned)
            .replace(/^\.+/, "")
            .replace(/\.+$/, "")
            .trim()
            .replace(/\s+/g, " ");
        if (second !== cleaned)
            cleaned = second;
    }
    if (!cleaned)
        throw new Error("Invalid draft name: empty after sanitization.");
    if (WINDOWS_RESERVED_NAMES.has(cleaned.toUpperCase())) {
        throw new Error(`Invalid draft name: "${cleaned}" is a reserved device name.`);
    }
    return cleaned;
}
function sanitizeName(name) {
    return sanitizeDraftName(name);
}
/**
 * Builds the draft_meta_info.json registry entry.
 * Key set mirrors the upstream draft_meta_info.json template exactly.
 */
export function buildMetaInfo(name) {
    // The reference template uses a dashed, UUID-shaped id derived from the
    // draft name; a plain hex digest is a different shape.
    const hex = createHash("md5").update(name).digest("hex").toUpperCase();
    const draftId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
            enterprise_material: [],
        },
        draft_fold_path: "",
        draft_id: draftId,
        draft_is_ai_packaging_used: false,
        draft_is_ai_shorts: false,
        draft_is_ai_translate: false,
        draft_is_article_video_draft: false,
        draft_is_from_deeplink: "false",
        draft_is_invisible: false,
        // The reference template declares seven material types, not three.
        draft_materials: [
            { type: 0, value: [] },
            { type: 1, value: [] },
            { type: 2, value: [] },
            { type: 3, value: [] },
            { type: 6, value: [] },
            { type: 7, value: [] },
            { type: 8, value: [] },
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
