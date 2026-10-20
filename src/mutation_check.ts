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
    const ok = run("node", [path.join(BUILD, "verify.js"), MEDIA, work]);
    return ok;
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

  const serverSrc = path.join(REPO, "src", "server.ts");
  const serverOriginal = fs.readFileSync(serverSrc, "utf8");

  for (const mutation of MUTATIONS) {
    const target = mutation.file === "server.ts" ? serverSrc : DRAFT_SRC;
    const base = mutation.file === "server.ts" ? serverOriginal : original;
    if (!base.includes(mutation.from)) {
      console.log(
        `  \x1b[33m?\x1b[0m ${mutation.name} — the snippet no longer matches, skipping`,
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

  // Restore and rebuild so the tree is left in a good state.
  build();
  fs.rmSync(scratch, { recursive: true, force: true });

  const total = caught + survivors.length;
  console.log(
    `\n\x1b[1mMutations: ${caught} of ${total} caught, ${survivors.length} survived\x1b[0m`,
  );
  if (survivors.length) {
    console.log("\nSurvived — these behaviours are not covered:");
    for (const s of survivors) console.log(`  - ${s}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
