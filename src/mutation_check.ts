#!/usr/bin/env node
/**
 * Mutation check.
 *
 * A test suite that cannot fail proves nothing. This script makes a series of
 * small, deliberate breakages to the engine and checks that the suite notices
 * each one. A mutation that goes unnoticed means the corresponding behaviour
 * is not actually covered.
 *
 * Usage: node dist/mutation_check.js <mediaDir>
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const DRAFT_SRC = path.join(REPO, "src", "draft.ts");
const BUILD = path.join(REPO, "dist");

const MEDIA = process.argv[2] ?? path.join(REPO, "test-media");
const UPSTREAM = process.env.JY_UPSTREAM_SKILL ?? "";

/**
 * Each mutation replaces a snippet of the source with a broken version.
 * The first one that changes the behaviour must be caught by the suite.
 */
const MUTATIONS: Array<{ name: string; from: string; to: string; file?: string }> = [
  {
    name: "overlap check disabled",
    from: "if (timerangesOverlap(seg.targetTimerange, range)) {",
    to: "if (false && timerangesOverlap(seg.targetTimerange, range)) {",
  },
  {
    name: "negative durations accepted",
    from: "  if (seconds < 0) {\n    throw new Error(`Invalid ${label}: ${value} must not be negative.`);",
    to: "  if (false) {\n    throw new Error(`Invalid ${label}: ${value} must not be negative.`);",
  },
  {
    name: "speed material not registered",
    from: "      speedId: this.registerSpeed(effectiveSpeed),",
    to: "      speedId: undefined,",
  },
  {
    name: "text render_index wrong",
    from: "const TEXT_RENDER_INDEX = 15000;",
    to: "const TEXT_RENDER_INDEX = 0;",
  },
  {
    name: "attribute used as track index",
    from: "        attribute: 0,\n        flag: 0,",
    to: "        attribute: t.index,\n        flag: 0,",
  },
  {
    name: "text alpha applied twice",
    from: "            alpha: 1.0,\n            content: {\n              render_type: \"solid\",\n              solid: { alpha: 1.0, color: style.color },",
    to: "            alpha: style.alpha,\n            content: {\n              render_type: \"solid\",\n              solid: { alpha: style.alpha, color: style.color },",
  },
  {
    name: "unmodelled materials dropped",
    from: "    for (const [bucket, items] of Object.entries(this.unmodelledBuckets)) {",
    to: "    for (const [bucket, items] of Object.entries({})) {",
  },
  {
    name: "orphan sweep ignores the created flag",
    from: "      (m) => !used.has(m.id) && this.createdMaterialIds.has(m.id),",
    to: "      (m) => !used.has(m.id),",
  },
  {
    // A name with a path separator is sanitised, and the draft must still be
    // addressable under the name the caller used.
    name: "the sanitised name is not used for lookup",
    from: "function sessionKey(name: string): string {\n  return sanitizeDraftName(name);\n}",
    to: "function sessionKey(name: string): string {\n  return name;\n}",
    file: "server.ts",
  },
  {
    name: "still image material duration shortened",
    from: "const STILL_IMAGE_MATERIAL_DURATION_US = 10_800_000_000;",
    to: "const STILL_IMAGE_MATERIAL_DURATION_US = 10_000_000;",
  },
  {
    name: "material bucket changed on load",
    from: "              ? entry.loadedBucket === \"images\"",
    to: "              ? false",
  },
  {
    name: "canvas size not validated",
    from: "  if (rounded <= 0) {\n    throw new Error(`Invalid ${label}: ${value} must be greater than zero.`);\n  }\n  return rounded;",
    to: "  return rounded;",
  },
  {
    name: "edit preferences reset on save",
    from: "        maintrack_adsorb: this.configFlags.maintrackAdsorb,",
    to: "        maintrack_adsorb: false,",
  },
  {
    name: "save writes directly instead of atomically",
    from: "      fs.writeFileSync(tmp, content, \"utf8\");\n      pending.push({ tmp, final });",
    to: "      fs.writeFileSync(final, content, \"utf8\");\n      pending.push({ tmp: final, final });",
  },
  {
    // The schema is published to the client, but the server has to keep it.
    // Without this check a missing field becomes "undefined" and a misspelled
    // key is ignored.
    name: "argument validation disabled",
    from: "      const problems = validateAgainstSchema(tool.inputSchema, args);",
    to: "      const problems: string[] = [];",
    file: "server.ts",
  },
  {
    name: "required fields not checked",
    from: "      for (const key of schema.required ?? []) {",
    to: "      for (const key of [] as string[]) {",
    file: "schema_validate.ts",
  },
  {
    name: "unknown arguments ignored",
    from: "      const unknown = Object.keys(obj).filter(\n        (key) => !Object.prototype.hasOwnProperty.call(properties, key),\n      );",
    to: "      const unknown: string[] = [];",
    file: "schema_validate.ts",
  },
  {
    // The membership test has to be an own-property test. `key in properties`
    // walks the prototype chain, so "__proto__" and "constructor" would look
    // like known keys and slip past the check.
    name: "prototype-named arguments slip past the unknown-key check",
    from: "        (key) => !Object.prototype.hasOwnProperty.call(properties, key),",
    to: "        (key) => !(key in properties),",
    file: "schema_validate.ts",
  },
  {
    name: "numeric strings refused",
    from: "      if (schema.acceptsNumericString && typeof value === \"string\") {",
    to: "      if (false && schema.acceptsNumericString && typeof value === \"string\") {",
    file: "schema_validate.ts",
  },
  {
    name: "a malformed line is dropped instead of reported",
    from: "      replyError(null, -32700, \"Parse error: the line is not valid JSON.\");",
    to: "      void 0;",
    file: "server.ts",
  },
  {
    name: "a non-object message is accepted",
    from: "  if (msg === null || typeof msg !== \"object\" || Array.isArray(msg)) {",
    to: "  if (false) {",
    file: "server.ts",
  },
  {
    name: "a request with a null id is treated as a notification",
    from: "  if (!Object.prototype.hasOwnProperty.call(msg, \"id\")) return;",
    to: "  if (msg.id === undefined || msg.id === null) return;",
    file: "server.ts",
  },
  {
    name: "two messages on one line are not split",
    from: "    const { values, failures } = splitJsonValues(line);",
    to: "    const values = [JSON.parse(line)]; const failures = 0;",
    file: "server.ts",
  },
  {
    // The primitive branch must stop at the end of the token. Taking the
    // rest of the line swallows the request that follows a fragment.
    name: "a fragment swallows the request behind it",
    from: "    const chunk = line.slice(index, end);\n    index = end;",
    to: "    const chunk = line.slice(index).trim();\n    index = line.length;",
    file: "server.ts",
  },
  {
    // The engine adds up the number-and-unit groups it finds and ignores
    // the rest, so "1m30s oops" has to be refused before it gets there.
    name: "a duration string with rubbish in it is accepted",
    from: "      if (schema.durationString && !DURATION_STRING_PATTERN.test(value)) {",
    to: "      if (false) {",
    file: "schema_validate.ts",
  },
  {
    name: "the subtitle flag is refused",
    from: "      subtitle: S.boolean(",
    to: "      subtitle: S.number(",
    file: "server.ts",
  },
  {
    // A draft_info.json holding an array used to be read as an empty draft.
    // Saving it would have overwritten the user's file with nothing.
    name: "a draft_info.json that is not a draft is accepted",
    from: "    if (info === null || typeof info !== \"object\" || Array.isArray(info)) {",
    to: "    if (false) {",
    file: "draft.ts",
  },
  {
    name: "a draft without a tracks array is accepted",
    from: "    if (!Array.isArray(info.tracks)) {",
    to: "    if (false) {",
    file: "draft.ts",
  },
  {
    // A bucket whose value is not a list is malformed, but it is still the
    // user's data. Dropping it strips it from the draft on the next save.
    name: "a malformed material bucket is dropped",
    from: "        materials[bucket] = items;\n      }",
    to: "        void items;\n      }",
    file: "draft.ts",
  },
  {
    // The reference keeps the whole loaded document and only overwrites
    // the keys it models. Rebuilding the file would drop a key a newer
    // JianYing had added.
    name: "an unknown top-level key is dropped",
    from: "      if (!(key in built)) built[key] = value;",
    to: "      if (false) built[key] = value;",
    file: "draft.ts",
  },
  {
    name: "an unknown config key is dropped",
    from: "      config: {\n        ...this.loadedConfig,",
    to: "      config: {",
    file: "draft.ts",
  },
];

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): boolean {
  try {
    execFileSync(cmd, args, {
      cwd: REPO,
      stdio: "pipe",
      env: { ...process.env, ...env },
    });
    return true;
  } catch {
    return false;
  }
}

/** Runs the whole suite and reports whether it passed. */
function suitePasses(): boolean {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "jy-mut-"));
  try {
    // Both suites have to pass. The functional suite covers the engine, the
    // protocol suite covers the wire layer; a mutation that only one of them
    // can see is still a hole.
    if (!run("node", [path.join(BUILD, "verify.js"), MEDIA, work])) return false;
    if (!run("node", [path.join(BUILD, "protocol_check.js")])) return false;
    return true;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function build(): boolean {
  return run("npx", ["tsc", "-p", "tsconfig.json"]);
}

async function main() {
  const original = fs.readFileSync(DRAFT_SRC, "utf8");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jy-mutsrc-"));
  const backup = path.join(scratch, "draft.ts.bak");
  fs.writeFileSync(backup, original, "utf8");

  console.log("\n\x1b[1mMutation check\x1b[0m");
  console.log(
    "  Each mutation breaks the engine on purpose. The suite has to notice.\n",
  );

  // Baseline: the unmodified engine must pass.
  if (!build()) {
    console.error("  the unmodified build failed — fix that first");
    process.exit(1);
  }
  if (!suitePasses()) {
    console.error("  the suite does not pass on the unmodified code");
    process.exit(1);
  }
  console.log("  \x1b[32m✓\x1b[0m baseline: the suite passes on the unmodified code\n");

  let caught = 0;
  const survivors: string[] = [];
  const skipped: string[] = [];

  const serverSrc = path.join(REPO, "src", "server.ts");
  const serverOriginal = fs.readFileSync(serverSrc, "utf8");
  const schemaSrc = path.join(REPO, "src", "schema_validate.ts");
  const schemaOriginal = fs.readFileSync(schemaSrc, "utf8");

  const sources: Record<string, { path: string; original: string }> = {
    "draft.ts": { path: DRAFT_SRC, original },
    "server.ts": { path: serverSrc, original: serverOriginal },
    "schema_validate.ts": { path: schemaSrc, original: schemaOriginal },
  };

  for (const mutation of MUTATIONS) {
    const source = sources[mutation.file ?? "draft.ts"];
    const target = source.path;
    const base = source.original;
    if (!base.includes(mutation.from)) {
      // A mutation whose snippet no longer matches the source is not a
      // passing check — it is a check that never ran. It has to be fixed
      // along with the code it watches.
      skipped.push(mutation.name);
      console.log(
        `  \x1b[31m✗\x1b[0m ${mutation.name} — the snippet no longer matches the source`,
      );
      continue;
    }
    const mutated = base.replace(mutation.from, mutation.to);
    fs.writeFileSync(target, mutated, "utf8");
    let noticed = false;
    if (build()) {
      noticed = !suitePasses();
    } else {
      // A build failure is also a detection.
      noticed = true;
    }
    if (noticed) {
      caught++;
      console.log(`  \x1b[32m✓\x1b[0m ${mutation.name}`);
    } else {
      survivors.push(mutation.name);
      console.log(
        `  \x1b[31m✗\x1b[0m ${mutation.name} — the suite did NOT notice`,
      );
    }
    fs.writeFileSync(target, base, "utf8");
  }

  // Restore every file this run may have touched and rebuild, so the tree is
  // left exactly as it was found.
  for (const source of Object.values(sources)) {
    fs.writeFileSync(source.path, source.original, "utf8");
  }
  build();
  fs.rmSync(scratch, { recursive: true, force: true });

  const total = caught + survivors.length + skipped.length;
  console.log(
    `\n\x1b[1mMutations: ${caught} of ${total} caught, ${survivors.length} survived\x1b[0m`,
  );
  if (survivors.length) {
    console.log("\nSurvived — these behaviours are not covered:");
    for (const s of survivors) console.log(`  - ${s}`);
  }
  if (skipped.length) {
    console.log(
      "\nSkipped — the source moved and these checks no longer run:",
    );
    for (const s of skipped) console.log(`  - ${s}`);
  }
  if (survivors.length || skipped.length) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
