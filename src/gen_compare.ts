#!/usr/bin/env node
/**
 * Generates a draft through the MCP server with exactly the same inputs the
 * upstream oracle uses, so compare_drafts.py can diff them.
 *
 * Usage: node dist/gen_compare.js <draftsRoot>
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "./mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.js");

/**
 * Media directory and output root. Both are configurable so the harness runs
 * on any machine; they default to paths relative to the repository root.
 */
const REPO_ROOT = path.resolve(__dirname, "..");
const MEDIA = process.env.JY_TEST_MEDIA ?? path.join(REPO_ROOT, "test-media");
const DRAFTS_ROOT =
  process.argv[2] ?? path.join(REPO_ROOT, "compare_drafts", "mcp");
const DRAFT_NAME = "Compare_Mcp";

async function main() {
  const client = new McpClient(SERVER, { JY_PROJECTS_ROOT: DRAFTS_ROOT });
  await client.initialize();

  // Canvas size is intentionally left unset so the automatic resolution
  // adaptation matches the upstream oracle's behaviour.
  await client.call("jianying_create_draft", { name: DRAFT_NAME, fps: 30 });
  await client.call("jianying_add_video", {
    name: DRAFT_NAME, filePath: path.join(MEDIA, "vid1.mp4"), start: 0, duration: 4,
  });
  await client.call("jianying_add_video", {
    name: DRAFT_NAME, filePath: path.join(MEDIA, "vid2.mp4"), start: 4, duration: 3,
  });
  await client.call("jianying_add_audio", {
    name: DRAFT_NAME, filePath: path.join(MEDIA, "bgm.mp3"), start: 0, track: 0,
  });
  await client.call("jianying_add_text", {
    name: DRAFT_NAME, text: "黄金样本字幕", start: 1, duration: 3,
  });

  const saved = await client.call("jianying_save_draft", { name: DRAFT_NAME });
  console.log("MCP SAVED:", saved.draftPath);

  client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
