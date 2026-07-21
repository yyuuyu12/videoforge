import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep test imports away from the user's real SQLite database. Each test
// worker receives its own directory, so schema setup cannot contend on locks.
if (!process.env.VIDEOFORGE_DATA_DIR) {
  const dataRoot = mkdtempSync(join(tmpdir(), "videoforge-test-"));
  // The tests inspect isolated workspaces but do not build a real generated
  // presentation. Mark the dependency directory as provisioned so config.js
  // does not copy the bundled production dependencies for every worker.
  mkdirSync(join(dataRoot, "workspaces", "node_modules"), { recursive: true });
  process.env.VIDEOFORGE_DATA_DIR = dataRoot;
}
